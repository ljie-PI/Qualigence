import { deflateSync, inflateSync } from "node:zlib";

export interface ScreenshotRectangle {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const MAXIMUM_PNG_DIMENSION = 16_384;
const MAXIMUM_PNG_BYTES = 256 * 1024 * 1024;

export function redactPngRectangles(
  source: Uint8Array,
  rectangles: readonly ScreenshotRectangle[],
  expectedDimensions: { readonly width: number; readonly height: number },
): Uint8Array {
  if (source.byteLength > MAXIMUM_PNG_BYTES || source.byteLength < PNG_SIGNATURE.length + 12) {
    throw new Error("png-size-unproven");
  }
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (source[index] !== PNG_SIGNATURE[index]) throw new Error("png-signature-unproven");
  }

  let width = 0;
  let height = 0;
  let colorType = -1;
  let header: Uint8Array | undefined;
  let sawEnd = false;
  const compressed: Buffer[] = [];
  for (let offset = PNG_SIGNATURE.length; offset < source.byteLength;) {
    if (source.byteLength - offset < 12) throw new Error("png-chunk-unproven");
    const view = new DataView(source.buffer, source.byteOffset + offset, source.byteLength - offset);
    const length = view.getUint32(0);
    const end = offset + 12 + length;
    if (end > source.byteLength) throw new Error("png-chunk-unproven");
    const typeBytes = source.subarray(offset + 4, offset + 8);
    const type = String.fromCharCode(...typeBytes);
    const data = source.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = new DataView(
      source.buffer,
      source.byteOffset + offset + 8 + length,
      4,
    ).getUint32(0);
    if (crc32(source.subarray(offset + 4, offset + 8 + length)) !== expectedCrc) {
      throw new Error("png-crc-unproven");
    }
    if (type === "IHDR") {
      if (header !== undefined || length !== 13) throw new Error("png-header-unproven");
      header = Uint8Array.from(data);
      const dimensions = new DataView(data.buffer, data.byteOffset, data.byteLength);
      width = dimensions.getUint32(0);
      height = dimensions.getUint32(4);
      colorType = data[9] ?? -1;
      if (data[8] !== 8 || (colorType !== 2 && colorType !== 6) ||
          data[10] !== 0 || data[11] !== 0 || data[12] !== 0) {
        throw new Error("png-format-unproven");
      }
    } else if (type === "IDAT") {
      if (header === undefined || sawEnd) throw new Error("png-order-unproven");
      compressed.push(Buffer.from(data));
    } else if (type === "IEND") {
      if (length !== 0 || sawEnd) throw new Error("png-end-unproven");
      sawEnd = true;
      if (end !== source.byteLength) throw new Error("png-trailing-data");
    } else if ((typeBytes[0]! & 0x20) === 0) {
      throw new Error("png-critical-chunk-unproven");
    }
    offset = end;
  }
  if (header === undefined || !sawEnd || compressed.length === 0 ||
      width <= 0 || height <= 0 || width > MAXIMUM_PNG_DIMENSION ||
      height > MAXIMUM_PNG_DIMENSION || width !== expectedDimensions.width ||
      height !== expectedDimensions.height) {
    throw new Error("png-dimensions-unproven");
  }

  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const expectedFilteredBytes = height * (stride + 1);
  if (!Number.isSafeInteger(expectedFilteredBytes) || expectedFilteredBytes > MAXIMUM_PNG_BYTES) {
    throw new Error("png-pixel-bounds-unproven");
  }
  const filtered = inflateSync(Buffer.concat(compressed), { maxOutputLength: expectedFilteredBytes });
  if (filtered.byteLength !== expectedFilteredBytes) throw new Error("png-pixels-unproven");
  const pixels = Buffer.allocUnsafe(stride * height);
  let sourceOffset = 0;
  for (let row = 0; row < height; row += 1) {
    const filter = filtered[sourceOffset++];
    if (filter === undefined || filter > 4) throw new Error("png-filter-unproven");
    const rowOffset = row * stride;
    for (let column = 0; column < stride; column += 1) {
      const raw = filtered[sourceOffset++];
      if (raw === undefined) throw new Error("png-pixels-unproven");
      const left = column >= channels ? pixels[rowOffset + column - channels]! : 0;
      const above = row > 0 ? pixels[rowOffset - stride + column]! : 0;
      const upperLeft = row > 0 && column >= channels
        ? pixels[rowOffset - stride + column - channels]!
        : 0;
      pixels[rowOffset + column] = (raw + filterDelta(filter, left, above, upperLeft)) & 0xff;
    }
  }

  for (const rectangle of rectangles) {
    if (![rectangle.x, rectangle.y, rectangle.width, rectangle.height].every(Number.isFinite) ||
        rectangle.width <= 0 || rectangle.height <= 0) {
      throw new Error("png-rectangle-unproven");
    }
    const left = Math.max(0, Math.floor(rectangle.x));
    const top = Math.max(0, Math.floor(rectangle.y));
    const right = Math.min(width, Math.ceil(rectangle.x + rectangle.width));
    const bottom = Math.min(height, Math.ceil(rectangle.y + rectangle.height));
    if (left >= right || top >= bottom) throw new Error("png-rectangle-coverage-unproven");
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        const pixel = y * stride + x * channels;
        pixels[pixel] = 0;
        pixels[pixel + 1] = 0;
        pixels[pixel + 2] = 0;
        if (channels === 4) pixels[pixel + 3] = 255;
      }
    }
  }

  const raw = Buffer.allocUnsafe(expectedFilteredBytes);
  for (let row = 0; row < height; row += 1) {
    const targetOffset = row * (stride + 1);
    raw[targetOffset] = 0;
    pixels.copy(raw, targetOffset + 1, row * stride, (row + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from(PNG_SIGNATURE),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", new Uint8Array()),
  ]);
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.allocUnsafe(data.byteLength + 12);
  chunk.writeUInt32BE(data.byteLength, 0);
  typeBytes.copy(chunk, 4);
  Buffer.from(data).copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.byteLength)), 8 + data.byteLength);
  return chunk;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 0 ? 0 : 0xedb88320);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function filterDelta(filter: number, left: number, above: number, upperLeft: number): number {
  if (filter === 0) return 0;
  if (filter === 1) return left;
  if (filter === 2) return above;
  if (filter === 3) return Math.floor((left + above) / 2);
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  return leftDistance <= aboveDistance && leftDistance <= upperLeftDistance
    ? left
    : aboveDistance <= upperLeftDistance ? above : upperLeft;
}

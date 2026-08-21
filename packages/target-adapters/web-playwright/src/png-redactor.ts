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
const SUPPORTED_ANCILLARY_CHUNKS = new Set([
  "cHRM",
  "gAMA",
  "sBIT",
  "sRGB",
  "bKGD",
  "pHYs",
  "tRNS",
  "tEXt",
  "zTXt",
  "iTXt",
]);

interface PngChunk {
  readonly type: string;
  readonly data: Uint8Array;
  readonly bytes: Uint8Array;
}

export function redactPngRectangles(
  source: Uint8Array,
  rectangles: readonly ScreenshotRectangle[],
  expectedDimensions: { readonly width: number; readonly height: number },
): Uint8Array {
  const parsed = parsePng(source);
  const { width, height, colorType, header, beforeIdat, afterIdat, compressed, end } = parsed;
  if (width !== expectedDimensions.width || height !== expectedDimensions.height) {
    throw new Error("png-dimensions-unproven");
  }

  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const expectedFilteredBytes = height * (stride + 1);
  if (!Number.isSafeInteger(expectedFilteredBytes) || expectedFilteredBytes > MAXIMUM_PNG_BYTES) {
    throw new Error("png-pixel-bounds-unproven");
  }
  const filtered = strictInflateZlib(
    Buffer.concat(compressed.map((data) => Buffer.from(data))),
    expectedFilteredBytes,
  );
  if (filtered.byteLength !== expectedFilteredBytes) throw new Error("png-pixels-unproven");
  const pixels = Buffer.allocUnsafe(stride * height);
  const filters = Buffer.allocUnsafe(height);
  let sourceOffset = 0;
  for (let row = 0; row < height; row += 1) {
    const filter = filtered[sourceOffset++];
    if (filter === undefined || filter > 4) throw new Error("png-filter-unproven");
    filters[row] = filter;
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

  const transparentRgb = parsed.transparency === undefined
    ? undefined
    : [parsed.transparency[1]!, parsed.transparency[3]!, parsed.transparency[5]!] as const;
  if (transparentRgb?.every((value) => value === 0)) {
    throw new Error("png-mask-transparency-unproven");
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

  const refiltered = Buffer.allocUnsafe(expectedFilteredBytes);
  for (let row = 0; row < height; row += 1) {
    const filter = filters[row]!;
    const rowOffset = row * stride;
    let targetOffset = row * (stride + 1);
    refiltered[targetOffset++] = filter;
    for (let column = 0; column < stride; column += 1) {
      const value = pixels[rowOffset + column]!;
      const left = column >= channels ? pixels[rowOffset + column - channels]! : 0;
      const above = row > 0 ? pixels[rowOffset - stride + column]! : 0;
      const upperLeft = row > 0 && column >= channels
        ? pixels[rowOffset - stride + column - channels]!
        : 0;
      refiltered[targetOffset + column] =
        (value - filterDelta(filter, left, above, upperLeft)) & 0xff;
    }
  }
  return Buffer.concat([
    Buffer.from(PNG_SIGNATURE),
    Buffer.from(header.bytes),
    ...beforeIdat.map((chunk) => Buffer.from(chunk.bytes)),
    pngChunk("IDAT", deflateSync(refiltered)),
    ...afterIdat.map((chunk) => Buffer.from(chunk.bytes)),
    Buffer.from(end.bytes),
  ]);
}

function parsePng(source: Uint8Array): {
  readonly width: number;
  readonly height: number;
  readonly colorType: 2 | 6;
  readonly header: PngChunk;
  readonly beforeIdat: readonly PngChunk[];
  readonly afterIdat: readonly PngChunk[];
  readonly compressed: readonly Uint8Array[];
  readonly end: PngChunk;
  readonly transparency: Uint8Array | undefined;
} {
  if (source.byteLength > MAXIMUM_PNG_BYTES || source.byteLength < PNG_SIGNATURE.length + 12) {
    throw new Error("png-size-unproven");
  }
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (source[index] !== PNG_SIGNATURE[index]) throw new Error("png-signature-unproven");
  }

  const chunks: PngChunk[] = [];
  for (let offset = PNG_SIGNATURE.length; offset < source.byteLength;) {
    if (source.byteLength - offset < 12) throw new Error("png-chunk-unproven");
    const view = new DataView(source.buffer, source.byteOffset + offset, source.byteLength - offset);
    const length = view.getUint32(0);
    const end = offset + 12 + length;
    if (!Number.isSafeInteger(end) || end > source.byteLength) throw new Error("png-chunk-unproven");
    const typeBytes = source.subarray(offset + 4, offset + 8);
    if (![...typeBytes].every((byte) =>
      (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122))) {
      throw new Error("png-chunk-type-unproven");
    }
    if ((typeBytes[2]! & 0x20) !== 0) throw new Error("png-chunk-type-unproven");
    const type = String.fromCharCode(...typeBytes);
    const data = source.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = new DataView(source.buffer, source.byteOffset + offset + 8 + length, 4)
      .getUint32(0);
    if (crc32(source.subarray(offset + 4, offset + 8 + length)) !== expectedCrc) {
      throw new Error("png-crc-unproven");
    }
    chunks.push({ type, data, bytes: source.subarray(offset, end) });
    offset = end;
  }
  if (chunks.length < 3 || chunks[0]?.type !== "IHDR") throw new Error("png-header-unproven");
  const header = chunks[0];
  if (header === undefined || header.data.byteLength !== 13 ||
      chunks.filter(({ type }) => type === "IHDR").length !== 1) {
    throw new Error("png-header-unproven");
  }
  const last = chunks.at(-1);
  if (last === undefined || last.type !== "IEND" || last.data.byteLength !== 0 ||
      chunks.filter(({ type }) => type === "IEND").length !== 1) {
    throw new Error("png-end-unproven");
  }
  const dimensions = new DataView(header.data.buffer, header.data.byteOffset, header.data.byteLength);
  const width = dimensions.getUint32(0);
  const height = dimensions.getUint32(4);
  const colorType = header.data[9];
  if (header.data[8] !== 8 || (colorType !== 2 && colorType !== 6) ||
      header.data[10] !== 0 || header.data[11] !== 0 || header.data[12] !== 0 ||
      width <= 0 || height <= 0 || width > MAXIMUM_PNG_DIMENSION || height > MAXIMUM_PNG_DIMENSION) {
    throw new Error("png-format-unproven");
  }

  const idatIndexes = chunks.flatMap((chunk, index) => chunk.type === "IDAT" ? [index] : []);
  if (idatIndexes.length === 0) throw new Error("png-pixels-unproven");
  const firstIdat = idatIndexes[0]!;
  const lastIdat = idatIndexes.at(-1)!;
  if (lastIdat - firstIdat + 1 !== idatIndexes.length) throw new Error("png-order-unproven");
  const beforeIdat = chunks.slice(1, firstIdat);
  const afterIdat = chunks.slice(lastIdat + 1, -1);
  const ancillary = [...beforeIdat, ...afterIdat];
  for (const chunk of ancillary) {
    if (chunk.type === "PLTE") continue;
    if ((chunk.type.charCodeAt(0) & 0x20) === 0) throw new Error("png-critical-chunk-unproven");
    if (!SUPPORTED_ANCILLARY_CHUNKS.has(chunk.type)) throw new Error("png-ancillary-chunk-unproven");
  }
  validateAncillary(beforeIdat, afterIdat, colorType);
  const transparency = beforeIdat.find(({ type }) => type === "tRNS")?.data;
  return {
    width,
    height,
    colorType,
    header,
    beforeIdat,
    afterIdat,
    compressed: chunks.slice(firstIdat, lastIdat + 1).map(({ data }) => data),
    end: last,
    transparency,
  };
}

function validateAncillary(
  beforeIdat: readonly PngChunk[],
  afterIdat: readonly PngChunk[],
  colorType: 2 | 6,
): void {
  const all = [...beforeIdat, ...afterIdat];
  const singleton = new Set(["PLTE", "cHRM", "gAMA", "sBIT", "sRGB", "bKGD", "pHYs", "tRNS"]);
  for (const type of singleton) {
    if (all.filter((chunk) => chunk.type === type).length > 1) throw new Error("png-ancillary-order-unproven");
  }
  const beforeOnly = new Set(["PLTE", "cHRM", "gAMA", "sBIT", "sRGB", "bKGD", "pHYs", "tRNS"]);
  if (afterIdat.some(({ type }) => beforeOnly.has(type))) throw new Error("png-ancillary-order-unproven");
  const paletteIndex = beforeIdat.findIndex(({ type }) => type === "PLTE");
  if (paletteIndex >= 0) {
    const mustPrecedePalette = new Set(["cHRM", "gAMA", "sBIT", "sRGB"]);
    if (beforeIdat.some((chunk, index) => index > paletteIndex && mustPrecedePalette.has(chunk.type)) ||
        beforeIdat.some((chunk, index) => index < paletteIndex &&
          (chunk.type === "bKGD" || chunk.type === "tRNS"))) {
      throw new Error("png-ancillary-order-unproven");
    }
  }
  const exactLengths: Readonly<Record<string, number>> = {
    cHRM: 32,
    gAMA: 4,
    sBIT: colorType === 2 ? 3 : 4,
    sRGB: 1,
    bKGD: 6,
    pHYs: 9,
  };
  for (const chunk of all) {
    if (chunk.type === "PLTE" && (chunk.data.byteLength === 0 ||
        chunk.data.byteLength > 768 || chunk.data.byteLength % 3 !== 0)) {
      throw new Error("png-palette-unproven");
    }
    const exactLength = exactLengths[chunk.type];
    if (exactLength !== undefined && chunk.data.byteLength !== exactLength) {
      throw new Error("png-ancillary-format-unproven");
    }
    if (["tEXt", "zTXt", "iTXt"].includes(chunk.type)) validateTextChunk(chunk);
  }
  const transparency = beforeIdat.find(({ type }) => type === "tRNS");
  if (transparency !== undefined) {
    if (colorType !== 2 || transparency.data.byteLength !== 6 ||
        transparency.data[0] !== 0 || transparency.data[2] !== 0 || transparency.data[4] !== 0) {
      throw new Error("png-transparency-unproven");
    }
  }
  const renderingIntent = all.find(({ type }) => type === "sRGB")?.data[0];
  if (renderingIntent !== undefined && renderingIntent > 3) throw new Error("png-color-profile-unproven");
  const gamma = all.find(({ type }) => type === "gAMA")?.data;
  if (gamma !== undefined && new DataView(gamma.buffer, gamma.byteOffset, gamma.byteLength).getUint32(0) === 0) {
    throw new Error("png-gamma-unproven");
  }
}

function validateTextChunk(chunk: PngChunk): void {
  const separator = chunk.data.indexOf(0);
  if (separator < 1 || separator > 79) throw new Error("png-text-unproven");
  if (chunk.type === "tEXt") return;
  if (chunk.type === "zTXt") {
    if (chunk.data[separator + 1] !== 0 || separator + 2 >= chunk.data.byteLength) {
      throw new Error("png-text-unproven");
    }
    strictInflateZlib(Buffer.from(chunk.data.subarray(separator + 2)), MAXIMUM_PNG_BYTES);
    return;
  }
  const compressionFlag = chunk.data[separator + 1];
  const compressionMethod = chunk.data[separator + 2];
  if ((compressionFlag !== 0 && compressionFlag !== 1) || compressionMethod !== 0) {
    throw new Error("png-text-unproven");
  }
  const languageEnd = chunk.data.indexOf(0, separator + 3);
  const translatedEnd = languageEnd < 0 ? -1 : chunk.data.indexOf(0, languageEnd + 1);
  if (languageEnd < 0 || translatedEnd < 0) throw new Error("png-text-unproven");
  const text = chunk.data.subarray(translatedEnd + 1);
  const decoded = compressionFlag === 1
    ? strictInflateZlib(Buffer.from(text), MAXIMUM_PNG_BYTES)
    : text;
  new TextDecoder("utf-8", { fatal: true }).decode(decoded);
}

function strictInflateZlib(compressed: Buffer, maxOutputLength: number): Buffer {
  const result: unknown = inflateSync(compressed, { info: true, maxOutputLength });
  if (typeof result !== "object" || result === null) throw new Error("png-zlib-boundary-unproven");
  const buffer = Object.getOwnPropertyDescriptor(result, "buffer")?.value;
  const engine = Object.getOwnPropertyDescriptor(result, "engine")?.value;
  if (!Buffer.isBuffer(buffer) || typeof engine !== "object" || engine === null) {
    throw new Error("png-zlib-boundary-unproven");
  }
  const bytesWritten = Object.getOwnPropertyDescriptor(engine, "bytesWritten")?.value;
  if (typeof bytesWritten !== "number" || !Number.isSafeInteger(bytesWritten) ||
      bytesWritten !== compressed.byteLength) {
    throw new Error("png-zlib-boundary-unproven");
  }
  return buffer;
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

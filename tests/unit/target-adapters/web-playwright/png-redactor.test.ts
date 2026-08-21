import { deflateSync, inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { redactPngRectangles } from "@qualigence/web-playwright/internal";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface Chunk {
  readonly type: string;
  readonly data: Buffer;
  readonly bytes: Buffer;
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

function chunk(type: string, data: Uint8Array): Buffer {
  const result = Buffer.alloc(data.byteLength + 12);
  result.writeUInt32BE(data.byteLength, 0);
  result.write(type, 4, 4, "ascii");
  Buffer.from(data).copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, -4)), result.byteLength - 4);
  return result;
}

function png(parts: readonly Buffer[], colorType = 2): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = colorType;
  const channels = colorType === 6 ? 4 : 3;
  const pixels = colorType === 2
    ? Buffer.from([1, 20, 30, 40, 246, 236, 226])
    : Buffer.from([1, 20, 30, 40, 255, 246, 236, 226, 0]);
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    ...parts,
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunks(bytes: Uint8Array): Chunk[] {
  const result: Chunk[] = [];
  for (let offset = SIGNATURE.length; offset < bytes.byteLength;) {
    const length = Buffer.from(bytes).readUInt32BE(offset);
    const end = offset + length + 12;
    result.push({
      type: Buffer.from(bytes).toString("ascii", offset + 4, offset + 8),
      data: Buffer.from(bytes).subarray(offset + 8, offset + 8 + length),
      bytes: Buffer.from(bytes).subarray(offset, end),
    });
    offset = end;
  }
  return result;
}

describe("PNG screenshot redaction", () => {
  it("preserves RGB tRNS and unrelated transparency while retaining scanline filters", () => {
    const transparency = chunk("tRNS", Buffer.from([0, 10, 0, 10, 0, 10]));
    const source = png([transparency]);

    const redacted = redactPngRectangles(source, [{ x: 0, y: 0, width: 1, height: 1 }], {
      width: 2,
      height: 1,
    });
    const output = chunks(redacted);
    const idat = Buffer.concat(output.filter(({ type }) => type === "IDAT").map(({ data }) => data));

    expect(output.find(({ type }) => type === "tRNS")?.bytes).toEqual(transparency);
    const filtered = inflateSync(idat);
    expect(filtered[0]).toBe(1);
    expect([
      (filtered[4]! + 0) & 0xff,
      (filtered[5]! + 0) & 0xff,
      (filtered[6]! + 0) & 0xff,
    ]).toEqual([10, 10, 10]);
  });

  it("preserves supported color, physical, and text metadata byte-for-byte in order", () => {
    const metadata = [
      chunk("sRGB", Buffer.from([0])),
      chunk("gAMA", Buffer.from([0, 0, 177, 143])),
      chunk("pHYs", Buffer.from([0, 0, 14, 196, 0, 0, 14, 196, 1])),
      chunk("tEXt", Buffer.from("Title\0original", "latin1")),
    ];

    const output = chunks(redactPngRectangles(png(metadata), [{ x: 0, y: 0, width: 1, height: 1 }], {
      width: 2,
      height: 1,
    })).filter(({ type }) => !["IHDR", "IDAT", "IEND"].includes(type));

    expect(output.map(({ type }) => type)).toEqual(["sRGB", "gAMA", "pHYs", "tEXt"]);
    expect(output.map(({ bytes }) => bytes)).toEqual(metadata);
  });

  it("rejects unknown ancillary chunks", () => {
    expect(() => redactPngRectangles(
      png([chunk("vpAg", Buffer.from([1]))]),
      [{ x: 0, y: 0, width: 1, height: 1 }],
      { width: 2, height: 1 },
    )).toThrow();
  });

  it("rejects unsafe transparency that would make the black mask transparent", () => {
    expect(() => redactPngRectangles(
      png([chunk("tRNS", Buffer.alloc(6))]),
      [{ x: 0, y: 0, width: 1, height: 1 }],
      { width: 2, height: 1 },
    )).toThrow();
  });

  it.each([
    ["CRC", () => {
      const source = png([]);
      source[source.byteLength - 1] = source[source.byteLength - 1]! ^ 0xff;
      return source;
    }],
    ["trailing bytes", () => Buffer.concat([png([]), Buffer.from([1])])],
    ["noncontiguous IDAT", () => {
      const source = png([]);
      const parsed = chunks(source);
      return Buffer.concat([
        SIGNATURE,
        parsed[0]!.bytes,
        parsed[1]!.bytes,
        chunk("tEXt", Buffer.from("k\0v", "latin1")),
        chunk("IDAT", deflateSync(Buffer.alloc(0))),
        parsed[2]!.bytes,
      ]);
    }],
  ])("fails closed for invalid %s", (_case, source) => {
    expect(() => redactPngRectangles(
      source(),
      [{ x: 0, y: 0, width: 1, height: 1 }],
      { width: 2, height: 1 },
    )).toThrow();
  });
});

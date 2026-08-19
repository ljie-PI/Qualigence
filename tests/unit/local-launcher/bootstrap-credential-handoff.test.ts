import { describe, expect, it } from "vitest";
import {
  BOOTSTRAP_FRAME_BYTES,
  BootstrapFrameError,
  decodeBootstrapCredential,
  encodeBootstrapCredential,
  encodeBootstrapFrame,
  parseBootstrapFrame,
} from "@qualigence/local-control";

describe("QLGBOOT1 bootstrap credential frame", () => {
  it("encodes the exact 100-byte binary contract and destroys credential bytes", () => {
    const user = Buffer.alloc(32, 0x11);
    const supervisor = Buffer.alloc(32, 0x22);
    const frame = encodeBootstrapFrame({
      userBootstrap: user,
      supervisor,
      createdAtEpochMs: 1_700_000_000_000,
      userExpiresAtEpochMs: 1_700_000_600_000,
    });

    expect(frame).toHaveLength(BOOTSTRAP_FRAME_BYTES);
    expect(frame.subarray(0, 8).toString("ascii")).toBe("QLGBOOT1");
    expect(frame.readUInt16BE(8)).toBe(1);
    expect(frame.readUInt16BE(10)).toBe(20);
    expect(frame.readUInt32BE(12)).toBe(100);
    expect(frame.readUInt32BE(16)).toBe(80);
    expect(frame.subarray(20, 52)).toEqual(user);
    expect(frame.subarray(52, 84)).toEqual(supervisor);
    expect(frame.readBigInt64BE(84)).toBe(1_700_000_000_000n);
    expect(frame.readBigInt64BE(92)).toBe(1_700_000_600_000n);

    const parsed = parseBootstrapFrame(frame);
    expect(parsed.userBootstrap).toEqual(user);
    parsed.destroy();
    expect(frame.equals(Buffer.alloc(100))).toBe(true);
  });

  it("zeroes malformed frames and emits only stable parser codes", () => {
    const frame = Buffer.alloc(100, 0xaa);
    expect(() => parseBootstrapFrame(frame)).toThrowError(BootstrapFrameError);
    expect(frame.equals(Buffer.alloc(100))).toBe(true);
  });

  it("uses exact 43-character unpadded base64url credentials", () => {
    const raw = Buffer.alloc(32, 0xff);
    const text = encodeBootstrapCredential(raw);
    expect(text).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(text).not.toContain("=");
    expect(decodeBootstrapCredential(text)).toEqual(raw);
    expect(() => decodeBootstrapCredential(`${text}=`)).toThrow();
  });
});

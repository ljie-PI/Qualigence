import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { encodeBootstrapFrame } from "@qualigence/local-control";
import { collectBootstrapCredentialHandoff } from "../../../apps/core-daemon/src/local/bootstrap-credential-handoff.js";

describe("Core bootstrap credential collector", () => {
  it("collects one exact frame and requires EOF", async () => {
    const stream = new PassThrough();
    const frame = encodeBootstrapFrame({
      userBootstrap: Buffer.alloc(32, 1),
      supervisor: Buffer.alloc(32, 2),
      createdAtEpochMs: 1_000,
      userExpiresAtEpochMs: 2_000,
    });
    stream.end(frame);
    const result = await collectBootstrapCredentialHandoff(stream, 1_000);
    expect(result.userBootstrap).toEqual(Buffer.alloc(32, 1));
    result.destroy();
    expect(frame.equals(Buffer.alloc(100))).toBe(true);
  });

  it("rejects trailing bytes without returning credentials", async () => {
    const stream = new PassThrough();
    const frame = encodeBootstrapFrame({ userBootstrap: Buffer.alloc(32, 1), supervisor: Buffer.alloc(32, 2), createdAtEpochMs: 1_000, userExpiresAtEpochMs: 2_000 });
    stream.end(Buffer.concat([frame, Buffer.of(1)]));
    await expect(collectBootstrapCredentialHandoff(stream, 1_000)).rejects.toMatchObject({
      code: "BootstrapFrameTrailingBytes",
    });
  });

  it.each([
    [8, 2, "BootstrapFrameVersionUnsupported"],
    [10, 19, "BootstrapFrameHeaderLengthInvalid"],
    [12, 101, "BootstrapFrameTotalLengthInvalid"],
    [16, 81, "BootstrapFrameBodyLengthInvalid"],
  ] as const)("rejects header field at offset %i before reading the body", async (offset, value, code) => {
    const frame = encodeBootstrapFrame({ userBootstrap: Buffer.alloc(32, 1), supervisor: Buffer.alloc(32, 2), createdAtEpochMs: 1_000, userExpiresAtEpochMs: 2_000 });
    if (offset === 8 || offset === 10) frame.writeUInt16BE(value, offset); else frame.writeUInt32BE(value, offset);
    const stream = new PassThrough();
    stream.write(frame.subarray(0, 20));

    await expect(collectBootstrapCredentialHandoff(stream, 1_000)).rejects.toMatchObject({ code });
    expect(frame.subarray(0, 20).equals(Buffer.alloc(20))).toBe(true);
    stream.destroy();
  });

  it("distinguishes missing, truncated, timed out, and IO failure and zeroes supplied bytes", async () => {
    const missing = new PassThrough(); missing.end();
    await expect(collectBootstrapCredentialHandoff(missing, 1_000)).rejects.toMatchObject({ code: "BootstrapFrameMissing" });

    const bytes = Buffer.from("QLGBOOT1");
    const truncated = new PassThrough(); truncated.end(bytes);
    await expect(collectBootstrapCredentialHandoff(truncated, 1_000)).rejects.toMatchObject({ code: "BootstrapFrameTruncated" });
    expect(bytes.equals(Buffer.alloc(bytes.length))).toBe(true);

    const timedOut = new PassThrough();
    await expect(collectBootstrapCredentialHandoff(timedOut, 10)).rejects.toMatchObject({ code: "BootstrapFrameTimedOut" });

    const failed = new PassThrough();
    const collecting = collectBootstrapCredentialHandoff(failed, 1_000);
    failed.destroy(new Error("read failed"));
    await expect(collecting).rejects.toMatchObject({ code: "BootstrapFrameIoFailed" });
  });
});

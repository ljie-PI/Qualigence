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
    stream.end(Buffer.alloc(101));
    await expect(collectBootstrapCredentialHandoff(stream, 1_000)).rejects.toMatchObject({
      code: "BootstrapFrameTrailingBytes",
    });
  });
});

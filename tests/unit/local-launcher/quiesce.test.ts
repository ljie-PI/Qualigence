import { describe, expect, it } from "vitest";
import { parseStopRequest } from "../../../apps/local-launcher/src/runtime-state.js";

describe("detached stop marker", () => {
  it("accepts only the exact non-secret v1 topology tuple", () => {
    const marker = {
      version: "local-stop-request/v1",
      supervisorPid: 10,
      corePid: 11,
      runnerPid: 12,
      startedAt: "2026-08-19T00:00:00.000Z",
      requestedAt: "2026-08-19T00:00:01.000Z",
    };
    expect(parseStopRequest(marker)).toEqual(marker);
    expect(() => parseStopRequest({ ...marker, credential: "secret" })).toThrow();
    expect(() => parseStopRequest({ ...marker, runnerPid: 0 })).toThrow();
  });
});

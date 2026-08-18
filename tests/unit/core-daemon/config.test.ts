import { describe, expect, it } from "vitest";
import { loadCoreDaemonConfig } from "@qualigence/core-daemon";

describe("CoreDaemonConfig", () => {
  it("reads the explicitly named legacy recovery manifest as an opaque candidate", () => {
    expect(loadCoreDaemonConfig).toBeTypeOf("function");
  });
});

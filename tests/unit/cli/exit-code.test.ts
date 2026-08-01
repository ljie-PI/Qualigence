import { describe, expect, it } from "vitest";
import type { RunExecutionResult } from "@qualigence/execution-application";
import { exitCodeFor } from "@qualigence/cli/exit-code";

function result(status: RunExecutionResult["status"]): RunExecutionResult {
  return { runId: "r", status, evidenceRefs: [] };
}

describe("exitCodeFor", () => {
  it("maps each terminal status to a stable exit code", () => {
    expect(exitCodeFor(result("passed"))).toBe(0);
    expect(exitCodeFor(result("finding"))).toBe(1);
    expect(exitCodeFor(result("blocked"))).toBe(2);
    expect(exitCodeFor(result("error"))).toBe(3);
  });
});

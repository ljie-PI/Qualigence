import { describe, expect, it } from "vitest";
import type { RunExecutionResult } from "@qualigence/execution-application";
import { createLogger, renderHuman, renderJson } from "@qualigence/cli/output";

const passed: RunExecutionResult = {
  runId: "run-1",
  status: "passed",
  evidenceRefs: ["art-1"],
};

const finding: RunExecutionResult = {
  runId: "run-2",
  status: "finding",
  evidenceRefs: ["g:1", "art-1"],
  finding: {
    findingId: "run-2:verification",
    runId: "run-2",
    title: "M1 verification failed",
    summary: "cart total mismatch",
    severity: "medium",
    evidenceRefs: ["g:1", "art-1"],
  },
};

describe("renderJson", () => {
  it("serializes the result as exactly one line", () => {
    expect(renderJson(passed)).toBe(`${JSON.stringify(passed)}\n`);
  });
});

describe("renderHuman", () => {
  it("summarizes status, run id and evidence", () => {
    const output = renderHuman(passed);
    expect(output).toContain("Status:  passed");
    expect(output).toContain("Run ID:  run-1");
    expect(output).toContain("Evidence: 1 reference(s)");
  });

  it("includes the finding summary when present", () => {
    const output = renderHuman(finding);
    expect(output).toContain("cart total mismatch");
    expect(output).toContain("Severity: medium");
  });
});

describe("createLogger", () => {
  it("redacts known secret keys and never prints their values", async () => {
    const chunks: string[] = [];
    const logger = createLogger({
      destination: { write: (message: string) => chunks.push(message) },
    });

    logger.info({ apiKey: "sk-secret-value", authorization: "Bearer sk-secret-value" }, "invoking model");

    const output = chunks.join("");
    expect(output).toContain("[Redacted]");
    expect(output).not.toContain("sk-secret-value");
  });
});

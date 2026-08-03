import { describe, expect, it } from "vitest";
import { SkillCompiler } from "@qualigence/skill";
import type { SkillInductionProposal } from "@qualigence/skill";
import type { RecordingSession } from "@qualigence/recording";

const recording: RecordingSession = {
  recordingId: "rec-1",
  projectId: "proj-1",
  targetId: "web-cart",
  targetVersion: "2026.08.01",
  observationSchemaEpoch: "pre-v1",
  startedAt: "2026-08-01T00:00:00.000Z",
  completedAt: "2026-08-01T00:01:00.000Z",
  steps: [
    {
      ordinal: 1,
      beforeGraphRef: "graph-a",
      intent: {
        kind: "input",
        target: { purpose: "cart quantity" },
        valueRef: "test-data.cart.quantity",
      },
      resolvedNode: {
        role: "spinbutton",
        name: "Quantity",
        purpose: "cart quantity",
        sourceNodeId: "node-11",
      },
      outcome: { status: "ok" },
      afterGraphRef: "graph-b",
      checkpoint: { requiredClaims: ["cart.qty==2"], stateFingerprint: "fp-1" },
    },
    {
      ordinal: 2,
      beforeGraphRef: "graph-b",
      intent: { kind: "click", target: { purpose: "add to cart" } },
      resolvedNode: {
        role: "button",
        name: "Add to cart",
        purpose: "add to cart",
        sourceNodeId: "node-22",
      },
      outcome: { status: "ok" },
      afterGraphRef: "graph-c",
      checkpoint: { requiredClaims: ["cart.count>=1"], stateFingerprint: "fp-2" },
    },
  ],
  sourceTraceRefs: ["run-1"],
};

const validProposal: SkillInductionProposal = {
  parameters: [
    {
      name: "quantity",
      valueRef: "test-data.cart.quantity",
      required: true,
      sensitivity: "public",
    },
  ],
  steps: [
    {
      sourceRecordedStepOrdinal: 1,
      intent: {
        kind: "input",
        target: { purpose: "cart quantity" },
        valueRef: "test-data.cart.quantity",
      },
      preconditions: [{ kind: "url_path", path: "/product" }],
      checkpoint: [{ kind: "node_present", target: { purpose: "cart quantity" } }],
      recovery: "reobserve",
    },
    {
      sourceRecordedStepOrdinal: 2,
      intent: { kind: "click", target: { purpose: "add to cart" } },
      preconditions: [],
      checkpoint: [{ kind: "url_path", path: "/cart" }],
      recovery: "stop",
    },
  ],
};

describe("SkillCompiler", () => {
  it("compiles a grounded proposal into a candidate with stable ids and hash", () => {
    const compiler = new SkillCompiler();
    const candidate = compiler.compile(recording, validProposal);

    expect(candidate.parameters[0]?.valueRef).toBe("test-data.cart.quantity");
    expect(candidate.steps.map((step) => step.stepId)).toEqual([
      "step-001",
      "step-002",
    ]);
    expect(candidate.steps[0]?.sourceNodeId).toBe("node-11");
    expect(candidate.sourceRecordingIds).toEqual(["rec-1"]);
    expect(candidate.contentSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic: identical inputs produce an identical content hash", () => {
    const compiler = new SkillCompiler();
    const a = compiler.compile(recording, validProposal);
    const b = compiler.compile(recording, validProposal);
    expect(a.contentSha256).toBe(b.contentSha256);
  });

  it("rejects a proposal that references a nonexistent recorded step", () => {
    const compiler = new SkillCompiler();
    const proposal: SkillInductionProposal = {
      ...validProposal,
      steps: [
        {
          ...validProposal.steps[0]!,
          sourceRecordedStepOrdinal: 99,
        },
      ],
    };
    expect(() => compiler.compile(recording, proposal)).toThrow(
      "InvalidSkillProposal",
    );
  });

  it("rejects a CSS/XPath selector leaked into a semantic target", () => {
    const compiler = new SkillCompiler();
    const proposal: SkillInductionProposal = {
      ...validProposal,
      steps: [
        {
          sourceRecordedStepOrdinal: 2,
          intent: {
            kind: "click",
            target: { purpose: "css=.add-to-cart" },
          },
          preconditions: [],
          checkpoint: [],
          recovery: "stop",
        },
      ],
    };
    expect(() => compiler.compile(recording, proposal)).toThrow(
      "SelectorLeakRejected",
    );
  });

  it("rejects a coordinate leaked into a checkpoint assertion", () => {
    const compiler = new SkillCompiler();
    const proposal: SkillInductionProposal = {
      ...validProposal,
      steps: [
        {
          sourceRecordedStepOrdinal: 2,
          intent: { kind: "click", target: { purpose: "add to cart" } },
          preconditions: [],
          checkpoint: [
            { kind: "node_text", target: { purpose: "at (12, 44)" }, expected: "x" },
          ],
          recovery: "stop",
        },
      ],
    };
    expect(() => compiler.compile(recording, proposal)).toThrow(
      "SelectorLeakRejected",
    );
  });

  it("rejects an input step whose kind does not match the recorded step", () => {
    const compiler = new SkillCompiler();
    const proposal: SkillInductionProposal = {
      ...validProposal,
      steps: [
        {
          sourceRecordedStepOrdinal: 2,
          intent: {
            kind: "input",
            target: { purpose: "add to cart" },
            valueRef: "test-data.cart.quantity",
          },
          preconditions: [],
          checkpoint: [],
          recovery: "stop",
        },
      ],
    };
    expect(() => compiler.compile(recording, proposal)).toThrow(
      "InvalidSkillProposal",
    );
  });

  it("rejects an input valueRef that is not a declared parameter", () => {
    const compiler = new SkillCompiler();
    const proposal: SkillInductionProposal = {
      parameters: [],
      steps: [
        {
          sourceRecordedStepOrdinal: 1,
          intent: {
            kind: "input",
            target: { purpose: "cart quantity" },
            valueRef: "test-data.cart.quantity",
          },
          preconditions: [],
          checkpoint: [],
          recovery: "stop",
        },
      ],
    };
    expect(() => compiler.compile(recording, proposal)).toThrow(
      "InvalidSkillProposal",
    );
  });

  it("rejects a raw secret smuggled onto an input step", () => {
    const compiler = new SkillCompiler();
    const proposal: SkillInductionProposal = {
      ...validProposal,
      steps: [
        {
          sourceRecordedStepOrdinal: 1,
          intent: {
            kind: "input",
            target: { purpose: "cart quantity" },
            valueRef: "test-data.cart.quantity",
            value: "2",
          } as never,
          preconditions: [],
          checkpoint: [],
          recovery: "stop",
        },
      ],
    };
    expect(() => compiler.compile(recording, proposal)).toThrow(
      "InvalidSkillProposal",
    );
  });
});

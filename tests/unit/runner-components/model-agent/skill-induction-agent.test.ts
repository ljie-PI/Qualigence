import { describe, expect, it } from "vitest";
import { SkillInductionAgent } from "@qualigence/model-agent";
import type {
  StructuredModelInvoker,
  StructuredModelRequest,
} from "@qualigence/model-gateway";
import type {
  StructuredOutputContract,
  ValidatedModelResult,
} from "@qualigence/model-provider";
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
  ],
  sourceTraceRefs: ["run-1"],
};

function validOutput(): unknown {
  return {
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
        preconditions: [],
        checkpoint: [{ kind: "url_path", path: "/cart" }],
        recovery: "reobserve",
      },
    ],
  };
}

class ScriptedGateway implements StructuredModelInvoker {
  readonly requests: StructuredModelRequest[] = [];

  constructor(private readonly output: unknown) {}

  async invokeStructured<T>(
    request: StructuredModelRequest,
    contract: StructuredOutputContract<T>,
  ): Promise<ValidatedModelResult<T>> {
    this.requests.push(request);
    return {
      value: contract.parse(this.output),
      model: request.model,
      finishReason: "stop",
    };
  }
}

describe("SkillInductionAgent", () => {
  it("invokes the skill.induction operation and returns a parsed proposal", async () => {
    const gateway = new ScriptedGateway(validOutput());
    const agent = new SkillInductionAgent(gateway, "test-model");

    const proposal = await agent.propose(recording);

    expect(gateway.requests[0]?.operation).toBe("skill.induction");
    expect(proposal.parameters[0]?.valueRef).toBe("test-data.cart.quantity");
    expect(proposal.steps[0]?.sourceRecordedStepOrdinal).toBe(1);
    expect(proposal.steps[0]?.recovery).toBe("reobserve");
  });

  it("rejects a structurally invalid model output", async () => {
    const gateway = new ScriptedGateway({ parameters: [], steps: [] });
    const agent = new SkillInductionAgent(gateway, "test-model");
    await expect(agent.propose(recording)).rejects.toMatchObject({
      name: "StructuredOutputValidationError",
    });
  });

  it("rejects an unknown action kind in the model output", async () => {
    const bad = validOutput() as { steps: { intent: { kind: string } }[] };
    bad.steps[0]!.intent = { kind: "teleport" } as never;
    const gateway = new ScriptedGateway(bad);
    const agent = new SkillInductionAgent(gateway, "test-model");
    await expect(agent.propose(recording)).rejects.toMatchObject({
      name: "StructuredOutputValidationError",
    });
  });
});

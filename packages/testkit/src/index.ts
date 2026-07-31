import {
  canonicalTraceEventHash,
  type TraceEvent,
  type TraceEventHashInput,
} from "@qualigence/runner-protocol";
import type {
  ExecutionDecisionProvider,
  PolicyDecision,
  ProposedAction,
  RunnerPolicyContext,
  RunnerPolicyGate,
  TraceEventInput,
  TraceRecorder,
} from "@qualigence/runner-kernel";

export class ScriptedDecisionProvider implements ExecutionDecisionProvider {
  constructor(private readonly action: ProposedAction) {}

  async decide(
    _context: Parameters<ExecutionDecisionProvider["decide"]>[0],
  ): Promise<ProposedAction> {
    return this.action;
  }
}

export class AllowAllRunnerPolicyGate implements RunnerPolicyGate {
  async authorize(
    _action: RunnerPolicyContext["action"],
    _context: RunnerPolicyContext,
  ): Promise<PolicyDecision> {
    return { status: "allowed", reason: "allowed by test policy" };
  }
}

export class InMemoryTraceRecorder implements TraceRecorder {
  private readonly eventsByRun = new Map<string, TraceEvent[]>();

  async append(input: TraceEventInput): Promise<TraceEvent> {
    const events = this.eventsByRun.get(input.runId) ?? [];
    const event = withHash(withEnvelope(input, events.length + 1));

    events.push(event);
    this.eventsByRun.set(input.runId, events);
    return event;
  }

  eventsFor(runId: string): readonly TraceEvent[] {
    return [...(this.eventsByRun.get(runId) ?? [])];
  }
}

function withEnvelope(
  input: TraceEventInput,
  sequenceNumber: number,
): TraceEventHashInput {
  const base = {
    protocolVersion: "runner-protocol/v1",
    schemaVersion: "trace-event/v1",
    messageId: `${input.runId}:${sequenceNumber}`,
    idempotencyKey: `${input.runId}:${sequenceNumber}`,
    runId: input.runId,
    sequenceNumber,
    occurredAt: "2026-07-30T00:00:00.000Z",
  } as const;

  switch (input.stage) {
    case "observation":
      return { ...base, stage: input.stage, payload: input.payload };
    case "decision":
      return { ...base, stage: input.stage, payload: input.payload };
    case "action_resolved":
      return { ...base, stage: input.stage, payload: input.payload };
    case "policy_authorized":
      return { ...base, stage: input.stage, payload: input.payload };
    case "policy_denied":
      return { ...base, stage: input.stage, payload: input.payload };
    case "action_executed":
      return { ...base, stage: input.stage, payload: input.payload };
    case "verification":
      return { ...base, stage: input.stage, payload: input.payload };
    case "finding":
      return { ...base, stage: input.stage, payload: input.payload };
    case "run_completed":
      return { ...base, stage: input.stage, payload: input.payload };
  }
}

function withHash(event: TraceEventHashInput): TraceEvent {
  return {
    ...event,
    payloadHash: canonicalTraceEventHash(event),
  } as TraceEvent;
}

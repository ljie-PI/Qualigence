import { canonicalPayloadHash, type TraceEvent } from "@qualigence/runner-protocol";
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

  async decide(): Promise<ProposedAction> {
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
    const event = {
      protocolVersion: "runner-protocol/v1",
      schemaVersion: "trace-event/v1",
      messageId: `${input.runId}:${events.length + 1}`,
      idempotencyKey: `${input.runId}:${events.length + 1}`,
      runId: input.runId,
      sequenceNumber: events.length + 1,
      stage: input.stage,
      occurredAt: "2026-07-30T00:00:00.000Z",
      payloadHash: canonicalPayloadHash(input.payload),
      payload: input.payload,
    } as TraceEvent;

    events.push(event);
    this.eventsByRun.set(input.runId, events);
    return event;
  }

  eventsFor(runId: string): readonly TraceEvent[] {
    return [...(this.eventsByRun.get(runId) ?? [])];
  }
}

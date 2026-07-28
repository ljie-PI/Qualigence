import type {
  FindingEnvelope,
  RunId,
  TraceEvent,
} from "../../../contracts/runner-protocol/src/index.js";

export type TraceIngestResult =
  | {
      readonly status: "accepted";
      readonly nextSequenceNumber: number;
    }
  | {
      readonly status: "duplicate";
      readonly nextSequenceNumber: number;
    }
  | {
      readonly status: "sequence_gap";
      readonly code: "SequenceGap";
      readonly expectedSequenceNumber: number;
    }
  | {
      readonly status: "integrity_violation";
      readonly code: "TraceIntegrityViolation";
      readonly existingPayloadHash: string;
    };

export interface TraceStore {
  append(event: TraceEvent): Promise<void>;
  appendFinding(finding: FindingEnvelope): Promise<void>;
  eventAt(runId: RunId, sequenceNumber: number): Promise<TraceEvent | undefined>;
  nextSequenceNumber(runId: RunId): Promise<number>;
}

export class TraceIngestor {
  constructor(private readonly store: TraceStore) {}

  async ingest(event: TraceEvent): Promise<TraceIngestResult> {
    const existing = await this.store.eventAt(event.runId, event.sequenceNumber);

    if (existing) {
      if (existing.payloadHash === event.payloadHash) {
        return {
          status: "duplicate",
          nextSequenceNumber: await this.store.nextSequenceNumber(event.runId),
        };
      }

      return {
        status: "integrity_violation",
        code: "TraceIntegrityViolation",
        existingPayloadHash: existing.payloadHash,
      };
    }

    const expectedSequenceNumber = await this.store.nextSequenceNumber(event.runId);
    if (event.sequenceNumber !== expectedSequenceNumber) {
      return {
        status: "sequence_gap",
        code: "SequenceGap",
        expectedSequenceNumber,
      };
    }

    await this.store.append(event);

    return {
      status: "accepted",
      nextSequenceNumber: event.sequenceNumber + 1,
    };
  }

  async ingestFinding(finding: FindingEnvelope): Promise<void> {
    await this.store.appendFinding(finding);
  }
}

export class InMemoryTraceStore implements TraceStore {
  private readonly eventsByRun = new Map<RunId, TraceEvent[]>();
  private readonly findingsByRun = new Map<RunId, FindingEnvelope[]>();

  async append(event: TraceEvent): Promise<void> {
    const events = this.eventsByRun.get(event.runId) ?? [];
    events.push(event);
    this.eventsByRun.set(event.runId, events);
  }

  async appendFinding(finding: FindingEnvelope): Promise<void> {
    const findings = this.findingsByRun.get(finding.runId) ?? [];
    findings.push(finding);
    this.findingsByRun.set(finding.runId, findings);
  }

  async eventAt(
    runId: RunId,
    sequenceNumber: number,
  ): Promise<TraceEvent | undefined> {
    return this.eventsByRun
      .get(runId)
      ?.find((event) => event.sequenceNumber === sequenceNumber);
  }

  async nextSequenceNumber(runId: RunId): Promise<number> {
    return (this.eventsByRun.get(runId)?.length ?? 0) + 1;
  }

  eventsFor(runId: RunId): readonly TraceEvent[] {
    return [...(this.eventsByRun.get(runId) ?? [])];
  }

  findingsFor(runId: RunId): readonly FindingEnvelope[] {
    return [...(this.findingsByRun.get(runId) ?? [])];
  }
}

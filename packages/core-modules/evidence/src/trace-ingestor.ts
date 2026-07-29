import type {
  FindingEnvelope,
  RunId,
  TraceEvent,
  TraceEventSubmission,
} from "@qualigence/runner-protocol";
import { canonicalPayloadHash } from "@qualigence/runner-protocol";

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
      readonly status: "hash_mismatch";
      readonly code: "PayloadHashMismatch";
      readonly declaredPayloadHash: string;
      readonly computedPayloadHash: string;
    }
  | {
      readonly status: "integrity_violation";
      readonly code: "TraceIntegrityViolation";
      readonly existingPayloadHash: string;
    };

export type FindingIngestResult =
  | { readonly status: "accepted" }
  | { readonly status: "duplicate" }
  | {
      readonly status: "integrity_violation";
      readonly code: "FindingIntegrityViolation";
      readonly existingPayloadHash: string;
    };

export type TraceAppendResult =
  | TraceIngestResult
  | {
      readonly status: "accepted";
      readonly nextSequenceNumber: number;
    };

export type FindingAppendResult = FindingIngestResult;

export interface TraceStore {
  appendTraceEvent(event: TraceEvent): Promise<TraceAppendResult>;
  appendFinding(
    finding: FindingEnvelope,
    payloadHash: string,
  ): Promise<FindingAppendResult>;
  eventAt(runId: RunId, sequenceNumber: number): Promise<TraceEvent | undefined>;
  nextTraceSequenceNumber(runId: RunId): Promise<number>;
}

export class TraceIngestor {
  constructor(private readonly store: TraceStore) {}

  async ingest(submission: TraceEventSubmission): Promise<TraceIngestResult> {
    const computedPayloadHash = canonicalPayloadHash(submission.payload);

    if (
      submission.payloadHash !== undefined &&
      submission.payloadHash !== computedPayloadHash
    ) {
      return {
        status: "hash_mismatch",
        code: "PayloadHashMismatch",
        declaredPayloadHash: submission.payloadHash,
        computedPayloadHash,
      };
    }

    const event = {
      ...submission,
      payloadHash: computedPayloadHash,
    } as TraceEvent;

    return this.store.appendTraceEvent(event);
  }

  async ingestFinding(finding: FindingEnvelope): Promise<FindingIngestResult> {
    return this.store.appendFinding(finding, canonicalPayloadHash(finding));
  }
}

export class InMemoryTraceStore implements TraceStore {
  private readonly eventsByRun = new Map<RunId, TraceEvent[]>();
  private readonly findingsByRun = new Map<RunId, FindingEnvelope[]>();
  private readonly findingHashes = new Map<string, string>();

  async appendTraceEvent(event: TraceEvent): Promise<TraceAppendResult> {
    const events = this.eventsByRun.get(event.runId) ?? [];
    const existing = events.find(
      (stored) => stored.sequenceNumber === event.sequenceNumber,
    );

    if (existing) {
      if (existing.payloadHash === event.payloadHash) {
        return {
          status: "duplicate",
          nextSequenceNumber: events.length + 1,
        };
      }

      return {
        status: "integrity_violation",
        code: "TraceIntegrityViolation",
        existingPayloadHash: existing.payloadHash,
      };
    }

    const expectedSequenceNumber = events.length + 1;
    if (event.sequenceNumber !== expectedSequenceNumber) {
      return {
        status: "sequence_gap",
        code: "SequenceGap",
        expectedSequenceNumber,
      };
    }

    events.push(event);
    this.eventsByRun.set(event.runId, events);

    return {
      status: "accepted",
      nextSequenceNumber: event.sequenceNumber + 1,
    };
  }

  async appendFinding(
    finding: FindingEnvelope,
    payloadHash: string,
  ): Promise<FindingAppendResult> {
    const existingHash = this.findingHashes.get(finding.findingId);
    if (existingHash) {
      if (existingHash === payloadHash) {
        return { status: "duplicate" };
      }

      return {
        status: "integrity_violation",
        code: "FindingIntegrityViolation",
        existingPayloadHash: existingHash,
      };
    }

    const findings = this.findingsByRun.get(finding.runId) ?? [];
    findings.push(finding);
    this.findingsByRun.set(finding.runId, findings);
    this.findingHashes.set(finding.findingId, payloadHash);

    return { status: "accepted" };
  }

  async eventAt(
    runId: RunId,
    sequenceNumber: number,
  ): Promise<TraceEvent | undefined> {
    return this.eventsByRun
      .get(runId)
      ?.find((event) => event.sequenceNumber === sequenceNumber);
  }

  async nextTraceSequenceNumber(runId: RunId): Promise<number> {
    return (this.eventsByRun.get(runId)?.length ?? 0) + 1;
  }

  eventsFor(runId: RunId): readonly TraceEvent[] {
    return [...(this.eventsByRun.get(runId) ?? [])];
  }

  findingsFor(runId: RunId): readonly FindingEnvelope[] {
    return [...(this.findingsByRun.get(runId) ?? [])];
  }
}

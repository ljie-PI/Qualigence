import { randomUUID } from "node:crypto";
import type { TraceIngestor } from "@qualigence/evidence";
import type {
  ExecutionEventAck,
  ExecutionEventBatch,
  FindingEnvelope,
  RunnerCapabilities,
  RunnerHello,
  RunnerWelcome,
} from "@qualigence/runner-protocol";
import { negotiateProtocolMajor } from "@qualigence/runner-protocol";
import type { AuthenticatedRunnerIdentity } from "@qualigence/grpc-runner-protocol";
import { CoreDaemonError } from "../errors.js";
import type { RunnerResumeTokenService } from "./runner-resume-token-service.js";
import type { RunOwnershipService } from "./run-ownership-service.js";

/** Negotiated server parameters advertised to every Runner in its Welcome. */
export interface SessionWelcomeParameters {
  readonly serverVersion: string;
  readonly heartbeatIntervalMs: number;
  readonly leaseDurationMs: number;
  readonly traceBatchMaximumEvents: number;
  readonly traceBatchMaximumBytes: number;
  readonly maximumInFlightBatches: number;
  readonly maximumPendingWriteBytes: number;
}

export interface RunnerSessionServiceOptions {
  readonly welcome: SessionWelcomeParameters;
  readonly resumeTokens: RunnerResumeTokenService;
  readonly traceIngestor: TraceIngestor;
  readonly ownership?: RunOwnershipService;
  readonly generateSessionId?: () => string;
}

export interface RunnerSessionRecord {
  readonly sessionId: string;
  readonly identity: AuthenticatedRunnerIdentity;
  readonly capabilities: RunnerCapabilities;
  readonly protocolMajor: number;
}

/**
 * The Core-side session authority. It negotiates the protocol major, validates
 * and rotates single-use resume credentials, and ingests acknowledged Trace
 * batches through the {@link TraceIngestor} so every accepted event is durably
 * persisted before it is acknowledged. A capability, protocol or resume failure
 * is an explicit structured rejection — never a silent downgrade.
 */
export class RunnerSessionService {
  private readonly sessions = new Map<string, RunnerSessionRecord>();
  private readonly welcome: SessionWelcomeParameters;
  private readonly resumeTokens: RunnerResumeTokenService;
  private readonly traceIngestor: TraceIngestor;
  private readonly ownership: RunOwnershipService | undefined;
  private readonly generateSessionId: () => string;

  constructor(options: RunnerSessionServiceOptions) {
    this.welcome = options.welcome;
    this.resumeTokens = options.resumeTokens;
    this.traceIngestor = options.traceIngestor;
    this.ownership = options.ownership;
    this.generateSessionId = options.generateSessionId ?? ((): string => randomUUID());
  }

  /**
   * Register a connecting Runner. Rejects with `ProtocolVersionMismatch` when no
   * shared protocol major exists and with `RunnerResumeRejected` when a presented
   * resume token is unknown, expired, consumed, or bound to a different identity.
   * A fresh single-use resume token is issued on every successful handshake.
   */
  register(hello: RunnerHello, identity: AuthenticatedRunnerIdentity): RunnerWelcome {
    const negotiation = negotiateProtocolMajor(hello.supportedProtocolMajors);
    if (negotiation.outcome === "rejected") {
      throw new CoreDaemonError("ProtocolVersionMismatch", "no shared protocol major", {
        details: {
          offeredProtocolMajors: negotiation.rejection.offeredProtocolMajors,
          supportedProtocolMajors: negotiation.rejection.supportedProtocolMajors,
        },
      });
    }
    const protocolMajor = negotiation.selectedProtocolMajor;

    if (hello.resumeToken !== undefined) {
      this.resumeTokens.use(hello.resumeToken, {
        runnerId: identity.runnerId,
        certificateFingerprint: identity.certificateFingerprint,
        protocolMajor,
      });
    }

    const sessionId = this.generateSessionId();
    this.sessions.set(sessionId, {
      sessionId,
      identity,
      capabilities: hello.capabilities,
      protocolMajor,
    });

    const resumeToken = this.resumeTokens.issue({
      runnerId: identity.runnerId,
      certificateFingerprint: identity.certificateFingerprint,
      previousSessionId: sessionId,
      protocolMajor,
    });

    return {
      sessionId,
      resumeToken,
      selectedProtocolMajor: protocolMajor,
      serverVersion: this.welcome.serverVersion,
      heartbeatIntervalMs: this.welcome.heartbeatIntervalMs,
      leaseDurationMs: this.welcome.leaseDurationMs,
      traceBatchMaximumEvents: this.welcome.traceBatchMaximumEvents,
      traceBatchMaximumBytes: this.welcome.traceBatchMaximumBytes,
      maximumInFlightBatches: this.welcome.maximumInFlightBatches,
      maximumPendingWriteBytes: this.welcome.maximumPendingWriteBytes,
    };
  }

  session(sessionId: string): RunnerSessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Ingest a Trace batch for a session. Events are ingested sequentially through
   * the {@link TraceIngestor}: a duplicate returns the same Ack, a gap returns the
   * expected sequence number so the Runner resends from there, and a
   * same-sequence/different-hash conflict quarantines the Session by throwing
   * `TraceIntegrityViolation`. When an ownership service is configured, only the
   * original owning Runner identity may upload Trace for a run.
   */
  async ingest(sessionId: string, batch: ExecutionEventBatch): Promise<ExecutionEventAck> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new CoreDaemonError("UnknownSession", `session ${sessionId} is not known`);
    }
    if (this.ownership !== undefined) {
      this.ownership.authorizeTraceUpload(session.identity, batch);
    }

    let nextExpectedSequenceNumber = batch.firstSequenceNumber;
    for (const event of batch.events) {
      const result = await this.traceIngestor.ingest(event);
      switch (result.status) {
        case "accepted":
          nextExpectedSequenceNumber = result.nextSequenceNumber;
          if (event.stage === "finding") {
            await this.traceIngestor.ingestFinding(event.payload as FindingEnvelope);
          }
          break;
        case "duplicate":
          nextExpectedSequenceNumber = result.nextSequenceNumber;
          break;
        case "sequence_gap":
          // Stop at the gap and ask the Runner to resume from the expected
          // sequence; nothing past the gap is accepted.
          return {
            batchId: batch.batchId,
            runId: batch.runId,
            nextExpectedSequenceNumber: result.expectedSequenceNumber,
          };
        case "hash_mismatch":
        case "integrity_violation":
          throw new CoreDaemonError(
            "TraceIntegrityViolation",
            `trace integrity violation at sequence ${event.sequenceNumber} for run ${batch.runId}`,
            { details: { runId: batch.runId, sequenceNumber: event.sequenceNumber } },
          );
      }
    }

    return {
      batchId: batch.batchId,
      runId: batch.runId,
      nextExpectedSequenceNumber,
    };
  }
}

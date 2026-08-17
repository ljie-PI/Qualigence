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
import { advertisedCapabilityTokens, negotiateProtocolMajor } from "@qualigence/runner-protocol";
import type { AuthenticatedRunnerContext, RunnerControlStore } from "@qualigence/runner-control";
import { CoreApplicationError } from "./core-runner-protocol-application.js";
import type { RunnerResumeTokenService } from "./runner-resume-token-service.js";
import type { RunOwnershipService } from "./run-ownership-service.js";

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
  readonly store: RunnerControlStore;
  readonly welcome: SessionWelcomeParameters;
  readonly resumeTokens: RunnerResumeTokenService;
  readonly traceIngestor: TraceIngestor;
  readonly ownership?: RunOwnershipService;
  readonly now?: () => number;
  readonly generateSessionId?: () => string;
}

export interface RunnerSessionRecord {
  readonly sessionId: string;
  readonly identity: AuthenticatedRunnerContext;
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
  private readonly live = new Map<string, RunnerSessionRecord>();
  private readonly store: RunnerControlStore;
  private readonly welcome: SessionWelcomeParameters;
  private readonly resumeTokens: RunnerResumeTokenService;
  private readonly traceIngestor: TraceIngestor;
  private readonly ownership: RunOwnershipService | undefined;
  private readonly now: () => number;
  private readonly generateSessionId: () => string;

  constructor(options: RunnerSessionServiceOptions) {
    this.store = options.store;
    this.welcome = options.welcome;
    this.resumeTokens = options.resumeTokens;
    this.traceIngestor = options.traceIngestor;
    this.ownership = options.ownership;
    this.now = options.now ?? ((): number => Date.now());
    this.generateSessionId = options.generateSessionId ?? ((): string => randomUUID());
  }

  /**
   * Register a connecting Runner. Rejects with `ProtocolVersionMismatch` when no
   * shared protocol major exists and with `RunnerResumeRejected` when a presented
   * resume token is unknown, expired, consumed, or bound to a different identity.
   * A fresh single-use resume token is issued on every successful handshake.
   */
  async register(hello: RunnerHello, identity: AuthenticatedRunnerContext): Promise<RunnerWelcome> {
    const negotiation = negotiateProtocolMajor(hello.supportedProtocolMajors);
    if (negotiation.outcome === "rejected") {
      throw new CoreApplicationError("ProtocolVersionMismatch", "no shared protocol major", {
        details: {
          offeredProtocolMajors: negotiation.rejection.offeredProtocolMajors,
          supportedProtocolMajors: negotiation.rejection.supportedProtocolMajors,
        },
      });
    }
    const protocolMajor = negotiation.selectedProtocolMajor;

    let sessionId = this.generateSessionId();
    if (hello.resumeToken !== undefined) {
      const binding = await this.resumeTokens.use(hello.resumeToken, {
        runnerId: identity.runnerId,
        certificateFingerprint: identity.certificateFingerprint,
        protocolMajor,
      });
      sessionId = binding.previousSessionId;
    }

    const createdAt = new Date(this.now()).toISOString();
    await this.store.saveSession({
      sessionId,
      runnerId: identity.runnerId,
      certificateFingerprint: identity.certificateFingerprint,
      capabilities: [...advertisedCapabilityTokens(hello.capabilities)],
      protocolMajor,
      createdAt,
    });

    const record: RunnerSessionRecord = {
      sessionId,
      identity,
      capabilities: hello.capabilities,
      protocolMajor,
    };
    this.live.set(sessionId, record);

    const resumeToken = await this.resumeTokens.issue({
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
    return this.live.get(sessionId);
  }

  async closeSession(sessionId: string): Promise<void> {
    this.live.delete(sessionId);
    await this.store.closeSession(sessionId, new Date(this.now()).toISOString());
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
    const session = this.live.get(sessionId);
    if (session === undefined) {
      throw new CoreApplicationError("UnknownSession", `session ${sessionId} is not known`);
    }
    if (this.ownership !== undefined) {
      await this.ownership.authorizeTraceUpload(session.identity, batch);
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
          return {
            batchId: batch.batchId,
            runId: batch.runId,
            nextExpectedSequenceNumber: result.expectedSequenceNumber,
          };
        case "hash_mismatch":
        case "integrity_violation":
          throw new CoreApplicationError(
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

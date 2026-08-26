/**
 * Stable domain messages for runner-protocol v1.
 *
 * These types are transport-agnostic: they never import Protobuf or gRPC DTOs.
 * The `grpc-runner-protocol` adapter (LS-05 Task 2) is the only package that maps
 * these messages onto the wire. Field names are frozen for protocol major 1; new
 * optional fields may be added within the major but existing names never change.
 */

import type {
  AcceptedExecutionJob,
  ArtifactUploadChunk,
  ArtifactUploadManifest,
  ArtifactUploadProgress,
  ExecutionCompletion,
  ExecutionJobId,
  RunId,
  TraceEvent,
} from "./index.js";
import type { RunnerCapabilities } from "./capabilities.js";

export type RunnerProtocolMajor = 1;

export const SUPPORTED_PROTOCOL_MAJORS: readonly RunnerProtocolMajor[] = [1];

/**
 * A short-lived, single-use resume credential. It restores protocol identity and
 * the Trace upload cursor only; it never extends a Lease or authorizes new
 * actions. The server persists only its hash.
 */
export type ResumeToken = string;

export interface RunnerHello {
  readonly runnerId: string;
  readonly runnerVersion: string;
  readonly supportedProtocolMajors: readonly number[];
  readonly capabilities: RunnerCapabilities;
  readonly resumeToken?: ResumeToken;
}

export interface RunnerWelcome {
  readonly sessionId: string;
  readonly resumeToken: ResumeToken;
  readonly selectedProtocolMajor: RunnerProtocolMajor;
  readonly serverVersion: string;
  readonly heartbeatIntervalMs: number;
  readonly leaseDurationMs: number;
  readonly traceBatchMaximumEvents: number;
  readonly traceBatchMaximumBytes: number;
  readonly maximumInFlightBatches: number;
  readonly maximumPendingWriteBytes: number;
}

export interface ProtocolVersionMismatch {
  readonly code: "ProtocolVersionMismatch";
  readonly offeredProtocolMajors: readonly number[];
  readonly supportedProtocolMajors: readonly RunnerProtocolMajor[];
}

export type ProtocolNegotiation =
  | { readonly outcome: "selected"; readonly selectedProtocolMajor: RunnerProtocolMajor }
  | { readonly outcome: "rejected"; readonly rejection: ProtocolVersionMismatch };

/**
 * Select the highest protocol major shared by the server and the Runner. When no
 * common major exists the connection is rejected with a structured
 * {@link ProtocolVersionMismatch} rather than downgraded to an incompatible one.
 */
export function negotiateProtocolMajor(offeredProtocolMajors: readonly number[]): ProtocolNegotiation {
  const shared = SUPPORTED_PROTOCOL_MAJORS.filter((major) => offeredProtocolMajors.includes(major));
  const selected = shared.reduce<RunnerProtocolMajor | undefined>(
    (best, major) => (best === undefined || major > best ? major : best),
    undefined,
  );
  if (selected === undefined) {
    return {
      outcome: "rejected",
      rejection: {
        code: "ProtocolVersionMismatch",
        offeredProtocolMajors: [...offeredProtocolMajors],
        supportedProtocolMajors: [...SUPPORTED_PROTOCOL_MAJORS],
      },
    };
  }
  return { outcome: "selected", selectedProtocolMajor: selected };
}

export interface ExecutionJobOffer {
  readonly offerId: string;
  readonly job: AcceptedExecutionJob;
  readonly requiredCapabilities: readonly string[];
  readonly leaseDurationMs: number;
}

/**
 * A single-owner lease over one execution attempt. `leaseEpoch` is stable for the
 * duration of an ownership grant; any re-authorization must use a strictly larger
 * epoch. `runId` identifies exactly one attempt and is never transferred to
 * another Runner.
 */
export interface ExecutionJobLease {
  readonly jobId: ExecutionJobId;
  readonly runId: RunId;
  readonly leaseToken: string;
  readonly leaseEpoch: number;
  readonly expiresAt: string;
}

export interface ExecutionEventBatch {
  readonly batchId: string;
  readonly runId: RunId;
  readonly firstSequenceNumber: number;
  readonly events: readonly TraceEvent[];
}

export interface ExecutionEventAck {
  readonly batchId: string;
  readonly runId: RunId;
  readonly nextExpectedSequenceNumber: number;
}

export interface ArtifactManifestRegistration {
  readonly jobId: ExecutionJobId;
  readonly runId: RunId;
  readonly leaseEpoch: number;
  readonly leaseToken: string;
  readonly manifest: ArtifactUploadManifest;
}

export interface ArtifactChunkUpload {
  readonly jobId: ExecutionJobId;
  readonly runId: RunId;
  readonly leaseEpoch: number;
  readonly leaseToken: string;
  readonly chunk: ArtifactUploadChunk;
}

export type ArtifactUploadAck = ArtifactUploadProgress;

/**
 * The server's response to a submitted Trace batch. A gap asks the Runner to
 * resume from the expected sequence number; an integrity violation quarantines
 * the Session. The batch is never silently dropped.
 */
export type ExecutionEventBatchOutcome =
  | { readonly outcome: "acknowledged"; readonly ack: ExecutionEventAck }
  | { readonly outcome: "gap"; readonly runId: RunId; readonly nextExpectedSequenceNumber: number }
  | {
      readonly outcome: "integrity_violation";
      readonly runId: RunId;
      readonly sequenceNumber: number;
      readonly code: "TraceIntegrityViolation";
    };

export type SessionCloseReason =
  | "client_requested"
  | "protocol_version_mismatch"
  | "resume_rejected"
  | "server_shutdown"
  | "transport_error";

/**
 * Runner Session lifecycle. Each variant carries exactly the data valid for that
 * state, so an established session without a negotiated Welcome (or a closed
 * session without a reason) is unrepresentable.
 */
export type RunnerSessionState =
  | { readonly status: "connecting"; readonly hello: RunnerHello }
  | { readonly status: "established"; readonly welcome: RunnerWelcome }
  | { readonly status: "resuming"; readonly previousSessionId: string; readonly resumeToken: ResumeToken }
  | { readonly status: "closed"; readonly reason: SessionCloseReason };

export type LeaseLostReason = "expired" | "revoked" | "epoch_superseded" | "transport_error";

/**
 * Execution Lease lifecycle. A `held`/`renewed` state always carries its lease
 * bundle and a `completed` state always carries its completion, so partially
 * constructed leases cannot be represented.
 */
export type ExecutionLeaseState =
  | { readonly status: "offered"; readonly offer: ExecutionJobOffer }
  | { readonly status: "held"; readonly lease: ExecutionJobLease }
  | { readonly status: "renewed"; readonly lease: ExecutionJobLease }
  | {
      readonly status: "completed";
      readonly jobId: ExecutionJobId;
      readonly runId: RunId;
      readonly completion: ExecutionCompletion;
    }
  | {
      readonly status: "lost";
      readonly jobId: ExecutionJobId;
      readonly runId: RunId;
      readonly leaseEpoch: number;
      readonly reason: LeaseLostReason;
    };

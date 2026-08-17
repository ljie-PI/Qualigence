import type { RunnerCapabilities } from "@qualigence/runner-protocol";
import type {
  AcceptedExecutionJob,
  ExecutionCompletion,
  ExecutionEventAck,
  ExecutionEventBatch,
  ExecutionJobLease,
  ExecutionJobOffer,
  FindingEnvelope,
  RunnerHello,
  RunnerProtocolMajor,
  RunnerWelcome,
  TargetRef,
  TraceEvent,
  TraceStage,
} from "@qualigence/runner-protocol";

/**
 * Explicit, total mapping between the frozen transport-agnostic domain messages
 * and the snake_case Protobuf wire objects. Every domain field maps to exactly
 * one wire field; optional fields are omitted (not sent as empty) so a decoded
 * absence round-trips back to an absent domain field. This module is the only
 * place that knows both vocabularies.
 */

type Wire = Record<string, unknown>;

function asArray<T>(value: unknown): readonly T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

// --- RunnerCapabilities ---------------------------------------------------

export function capabilitiesToWire(capabilities: RunnerCapabilities): Wire {
  return {
    operating_system: capabilities.operatingSystem,
    architecture: capabilities.architecture,
    target_adapters: [...capabilities.targetAdapters],
    observation_extensions: [...capabilities.observationExtensions],
    action_kinds: [...capabilities.actionKinds],
    model: {
      structured_output: capabilities.model.structuredOutput,
      vision_input: capabilities.model.visionInput,
    },
    maximum_artifact_bytes: capabilities.maximumArtifactBytes,
  };
}

export function capabilitiesFromWire(wire: unknown): RunnerCapabilities {
  const record = (wire ?? {}) as Wire;
  const model = (record.model ?? {}) as Wire;
  return {
    operatingSystem: asString(record.operating_system) as RunnerCapabilities["operatingSystem"],
    architecture: asString(record.architecture) as RunnerCapabilities["architecture"],
    targetAdapters: asArray<string>(record.target_adapters),
    observationExtensions: asArray<string>(record.observation_extensions),
    actionKinds: asArray<string>(record.action_kinds),
    model: {
      structuredOutput: asBoolean(model.structured_output),
      visionInput: asBoolean(model.vision_input),
    },
    maximumArtifactBytes: asNumber(record.maximum_artifact_bytes),
  };
}

// --- RunnerHello ----------------------------------------------------------

export function helloToWire(hello: RunnerHello): Wire {
  const wire: Wire = {
    runner_id: hello.runnerId,
    runner_version: hello.runnerVersion,
    supported_protocol_majors: [...hello.supportedProtocolMajors],
    capabilities: capabilitiesToWire(hello.capabilities),
  };
  if (hello.resumeToken !== undefined) {
    wire.resume_token = hello.resumeToken;
  }
  return wire;
}

export function helloFromWire(wire: Wire): RunnerHello {
  const resumeToken = asString(wire.resume_token);
  const hello: RunnerHello = {
    runnerId: asString(wire.runner_id),
    runnerVersion: asString(wire.runner_version),
    supportedProtocolMajors: asArray<number>(wire.supported_protocol_majors),
    capabilities: capabilitiesFromWire(wire.capabilities),
  };
  return resumeToken === "" ? hello : { ...hello, resumeToken };
}

// --- RunnerWelcome --------------------------------------------------------

export function welcomeToWire(welcome: RunnerWelcome): Wire {
  return {
    session_id: welcome.sessionId,
    resume_token: welcome.resumeToken,
    selected_protocol_major: welcome.selectedProtocolMajor,
    server_version: welcome.serverVersion,
    heartbeat_interval_ms: welcome.heartbeatIntervalMs,
    lease_duration_ms: welcome.leaseDurationMs,
    trace_batch_maximum_events: welcome.traceBatchMaximumEvents,
    trace_batch_maximum_bytes: welcome.traceBatchMaximumBytes,
    maximum_in_flight_batches: welcome.maximumInFlightBatches,
    maximum_pending_write_bytes: welcome.maximumPendingWriteBytes,
  };
}

export function welcomeFromWire(wire: Wire): RunnerWelcome {
  return {
    sessionId: asString(wire.session_id),
    resumeToken: asString(wire.resume_token),
    selectedProtocolMajor: asNumber(wire.selected_protocol_major) as RunnerProtocolMajor,
    serverVersion: asString(wire.server_version),
    heartbeatIntervalMs: asNumber(wire.heartbeat_interval_ms),
    leaseDurationMs: asNumber(wire.lease_duration_ms),
    traceBatchMaximumEvents: asNumber(wire.trace_batch_maximum_events),
    traceBatchMaximumBytes: asNumber(wire.trace_batch_maximum_bytes),
    maximumInFlightBatches: asNumber(wire.maximum_in_flight_batches),
    maximumPendingWriteBytes: asNumber(wire.maximum_pending_write_bytes),
  };
}

// --- TargetRef / AcceptedExecutionJob -------------------------------------

function targetToWire(target: TargetRef): Wire {
  return { web: { url: target.url } };
}

function targetFromWire(wire: unknown): TargetRef {
  const record = (wire ?? {}) as Wire;
  const web = (record.web ?? {}) as Wire;
  return { kind: "web", url: asString(web.url) };
}

export function jobToWire(job: AcceptedExecutionJob): Wire {
  return {
    job_id: job.jobId,
    run_id: job.runId,
    target: targetToWire(job.target),
    objective: job.objective,
  };
}

export function jobFromWire(wire: Wire): AcceptedExecutionJob {
  return {
    jobId: asString(wire.job_id),
    runId: asString(wire.run_id),
    target: targetFromWire(wire.target),
    objective: asString(wire.objective),
  };
}

// --- ExecutionJobOffer ----------------------------------------------------

export function offerToWire(offer: ExecutionJobOffer): Wire {
  return {
    offer_id: offer.offerId,
    job: jobToWire(offer.job),
    required_capabilities: [...offer.requiredCapabilities],
    lease_duration_ms: offer.leaseDurationMs,
  };
}

export function offerFromWire(wire: Wire): ExecutionJobOffer {
  return {
    offerId: asString(wire.offer_id),
    job: jobFromWire((wire.job ?? {}) as Wire),
    requiredCapabilities: asArray<string>(wire.required_capabilities),
    leaseDurationMs: asNumber(wire.lease_duration_ms),
  };
}

// --- ExecutionJobLease ----------------------------------------------------

export function leaseToWire(lease: ExecutionJobLease): Wire {
  return {
    job_id: lease.jobId,
    run_id: lease.runId,
    lease_token: lease.leaseToken,
    lease_epoch: lease.leaseEpoch,
    expires_at: lease.expiresAt,
  };
}

export function leaseFromWire(wire: Wire): ExecutionJobLease {
  return {
    jobId: asString(wire.job_id),
    runId: asString(wire.run_id),
    leaseToken: asString(wire.lease_token),
    leaseEpoch: asNumber(wire.lease_epoch),
    expiresAt: asString(wire.expires_at),
  };
}

// --- AcceptOffer / RenewLease ---------------------------------------------

export function acceptOfferToWire(offerId: string): Wire {
  return { offer_id: offerId };
}

export function acceptOfferFromWire(wire: Wire): string {
  return asString(wire.offer_id);
}

export function renewLeaseToWire(lease: ExecutionJobLease): Wire {
  return {
    job_id: lease.jobId,
    run_id: lease.runId,
    lease_epoch: lease.leaseEpoch,
    lease_token: lease.leaseToken,
  };
}

export function renewLeaseFromWire(wire: Wire): ExecutionJobLease {
  return leaseFromWire(wire);
}

// --- TraceEvent / ExecutionEventBatch -------------------------------------

function traceEventToWire(event: TraceEvent): Wire {
  return {
    protocol_version: event.protocolVersion,
    schema_version: event.schemaVersion,
    message_id: event.messageId,
    idempotency_key: event.idempotencyKey,
    run_id: event.runId,
    sequence_number: event.sequenceNumber,
    stage: event.stage,
    occurred_at: event.occurredAt,
    payload_hash: event.payloadHash,
    payload_json: JSON.stringify(event.payload),
  };
}

function traceEventFromWire(wire: Wire): TraceEvent {
  const envelope = {
    protocolVersion: asString(wire.protocol_version) as TraceEvent["protocolVersion"],
    schemaVersion: asString(wire.schema_version) as TraceEvent["schemaVersion"],
    messageId: asString(wire.message_id),
    idempotencyKey: asString(wire.idempotency_key),
    runId: asString(wire.run_id),
    sequenceNumber: asNumber(wire.sequence_number),
    stage: asString(wire.stage) as TraceStage,
    occurredAt: asString(wire.occurred_at),
    payloadHash: asString(wire.payload_hash),
    payload: JSON.parse(asString(wire.payload_json) || "null") as unknown,
  };
  return envelope as unknown as TraceEvent;
}

export function eventBatchToWire(batch: ExecutionEventBatch): Wire {
  return {
    batch_id: batch.batchId,
    run_id: batch.runId,
    first_sequence_number: batch.firstSequenceNumber,
    events: batch.events.map(traceEventToWire),
  };
}

export function eventBatchFromWire(wire: Wire): ExecutionEventBatch {
  return {
    batchId: asString(wire.batch_id),
    runId: asString(wire.run_id),
    firstSequenceNumber: asNumber(wire.first_sequence_number),
    events: asArray<Wire>(wire.events).map(traceEventFromWire),
  };
}

// --- ExecutionEventAck ----------------------------------------------------

export function eventAckToWire(ack: ExecutionEventAck): Wire {
  return {
    batch_id: ack.batchId,
    run_id: ack.runId,
    next_expected_sequence_number: ack.nextExpectedSequenceNumber,
  };
}

export function eventAckFromWire(wire: Wire): ExecutionEventAck {
  return {
    batchId: asString(wire.batch_id),
    runId: asString(wire.run_id),
    nextExpectedSequenceNumber: asNumber(wire.next_expected_sequence_number),
  };
}

// --- CompleteExecution ----------------------------------------------------

export function completionToWire(completion: ExecutionCompletion): Wire {
  const wire: Wire = {
    job_id: completion.jobId,
    run_id: completion.runId,
    status: completion.status,
  };
  if (completion.status === "finding") {
    wire.finding_json = JSON.stringify(completion.finding);
  } else if (completion.status === "blocked" && completion.errorCode !== undefined) {
    wire.error_code = completion.errorCode;
  } else if (completion.status === "error") {
    wire.error_code = completion.errorCode;
  }
  return wire;
}

export function completionFromWire(wire: Wire): ExecutionCompletion {
  const jobId = asString(wire.job_id);
  const runId = asString(wire.run_id);
  const status = asString(wire.status);
  switch (status) {
    case "passed":
      return { jobId, runId, status: "passed" };
    case "finding":
      return {
        jobId,
        runId,
        status: "finding",
        finding: JSON.parse(asString(wire.finding_json) || "null") as FindingEnvelope,
      };
    case "blocked": {
      const errorCode = asString(wire.error_code);
      return errorCode === ""
        ? { jobId, runId, status: "blocked" }
        : { jobId, runId, status: "blocked", errorCode };
    }
    default:
      return { jobId, runId, status: "error", errorCode: asString(wire.error_code) };
  }
}

// --- Structured server rejections -----------------------------------------

export function protocolVersionMismatchToWire(
  offeredProtocolMajors: readonly number[],
  supportedProtocolMajors: readonly number[],
): Wire {
  return {
    offered_protocol_majors: [...offeredProtocolMajors],
    supported_protocol_majors: [...supportedProtocolMajors],
  };
}

export interface ProtocolVersionMismatchWire {
  readonly offeredProtocolMajors: readonly number[];
  readonly supportedProtocolMajors: readonly number[];
}

export function protocolVersionMismatchFromWire(wire: Wire): ProtocolVersionMismatchWire {
  return {
    offeredProtocolMajors: asArray<number>(wire.offered_protocol_majors),
    supportedProtocolMajors: asArray<number>(wire.supported_protocol_majors),
  };
}

export function capabilityMismatchFromWire(wire: Wire): readonly string[] {
  return asArray<string>(wire.missing_capabilities);
}

export interface TraceGapWire {
  readonly runId: string;
  readonly nextExpectedSequenceNumber: number;
}

export function traceGapFromWire(wire: Wire): TraceGapWire {
  return {
    runId: asString(wire.run_id),
    nextExpectedSequenceNumber: asNumber(wire.next_expected_sequence_number),
  };
}

export interface TraceIntegrityViolationWire {
  readonly runId: string;
  readonly sequenceNumber: number;
}

export function traceIntegrityViolationFromWire(wire: Wire): TraceIntegrityViolationWire {
  return {
    runId: asString(wire.run_id),
    sequenceNumber: asNumber(wire.sequence_number),
  };
}

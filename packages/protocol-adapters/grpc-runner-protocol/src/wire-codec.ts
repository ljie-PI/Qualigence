import { runnerProtoRoot } from "./proto.js";
import { RunnerProtocolError } from "./errors.js";

/** Message names in the frozen `qualigence.runner.v1` schema. */
export type RunnerWireMessageName =
  | "RunnerHello"
  | "RunnerWelcome"
  | "RunnerCapabilities"
  | "ExecutionJobOffer"
  | "ExecutionJobLease"
  | "ExecutionEventBatch"
  | "ExecutionEventAck"
  | "AcceptOffer"
  | "RenewLease"
  | "CompleteExecution"
  | "ProtocolVersionMismatch"
  | "CapabilityMismatch"
  | "TraceGap"
  | "TraceIntegrityViolation"
  | "TargetRef"
  | "AcceptedExecutionJob"
  | "TraceEventEnvelope";

const PACKAGE = "qualigence.runner.v1";

const DECODE_OPTIONS = {
  longs: Number,
  enums: String,
  defaults: false,
  oneofs: true,
} as const;

/**
 * Encodes a mapped wire object to protobuf bytes using the frozen schema,
 * exercising the published field numbers. The complement of
 * {@link decodeWireMessage}.
 */
export function encodeWireMessage(name: RunnerWireMessageName, wire: object): Uint8Array {
  const type = runnerProtoRoot().lookupType(`${PACKAGE}.${name}`);
  const invalid = type.verify(wire);
  if (invalid) {
    throw new RunnerProtocolError("ProtocolViolation", `invalid ${name} wire message: ${invalid}`);
  }
  return type.encode(type.fromObject(wire)).finish();
}

/** Decodes protobuf bytes to a snake_case wire object using the frozen schema. */
export function decodeWireMessage(
  name: RunnerWireMessageName,
  bytes: Uint8Array,
): Record<string, unknown> {
  const type = runnerProtoRoot().lookupType(`${PACKAGE}.${name}`);
  return type.toObject(type.decode(bytes), DECODE_OPTIONS) as Record<string, unknown>;
}

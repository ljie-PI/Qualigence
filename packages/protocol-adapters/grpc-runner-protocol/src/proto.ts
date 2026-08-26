import { fileURLToPath } from "node:url";
import * as protoLoader from "@grpc/proto-loader";
import * as grpc from "@grpc/grpc-js";
import protobuf from "protobufjs";

/**
 * Resolves the frozen runner-protocol v1 wire schema and exposes it in the two
 * shapes this adapter needs: a gRPC {@link grpc.GrpcObject} for the live
 * bidirectional transport, and a {@link protobuf.Root} for standalone message
 * encode/decode used by the mappers. The `.proto` file is located relative to the
 * resolved `@qualigence/runner-protocol` package so the path stays correct
 * regardless of where the workspace is installed.
 */

const RUNNER_PROTO_URL = new URL(
  "../proto/qualigence/runner/v1/runner.proto",
  import.meta.resolve("@qualigence/runner-protocol"),
);

const RUNNER_PROTO_PATH = fileURLToPath(RUNNER_PROTO_URL);

const LOADER_OPTIONS: protoLoader.Options = {
  keepCase: true,
  longs: Number,
  enums: String,
  defaults: false,
  oneofs: true,
};

export interface RunnerServiceClientConstructor {
  new (
    address: string,
    credentials: grpc.ChannelCredentials,
    options?: grpc.ClientOptions,
  ): grpc.Client & {
    Connect(): grpc.ClientDuplexStream<RunnerFrameWire, ServerFrameWire>;
  };
}

export interface RunnerServiceDefinition {
  readonly service: grpc.ServiceDefinition;
  readonly clientConstructor: RunnerServiceClientConstructor;
}

let cachedService: RunnerServiceDefinition | undefined;
let cachedRoot: protobuf.Root | undefined;

export function runnerServiceDefinition(): RunnerServiceDefinition {
  if (cachedService === undefined) {
    const packageDefinition = protoLoader.loadSync(RUNNER_PROTO_PATH, LOADER_OPTIONS);
    const loaded = grpc.loadPackageDefinition(packageDefinition) as unknown as {
      qualigence: { runner: { v1: { RunnerService: RunnerServiceClientConstructor } } };
    };
    const clientConstructor = loaded.qualigence.runner.v1.RunnerService;
    cachedService = {
      clientConstructor,
      service: (clientConstructor as unknown as { service: grpc.ServiceDefinition }).service,
    };
  }
  return cachedService;
}

export function runnerProtoRoot(): protobuf.Root {
  if (cachedRoot === undefined) {
    const root = new protobuf.Root();
    root.loadSync(RUNNER_PROTO_PATH, { keepCase: true });
    cachedRoot = root;
  }
  return cachedRoot;
}

/** Wire (snake_case) envelope for every Runner-originated frame. */
export interface RunnerFrameWire {
  correlation_id: string;
  payload?: string;
  hello?: Record<string, unknown>;
  accept_offer?: Record<string, unknown>;
  renew_lease?: Record<string, unknown>;
  event_batch?: Record<string, unknown>;
  complete_execution?: Record<string, unknown>;
  register_artifact_manifest?: Record<string, unknown>;
  upload_artifact_chunk?: Record<string, unknown>;
}

/** Wire (snake_case) envelope for every Server-originated frame. */
export interface ServerFrameWire {
  correlation_id: string;
  payload?: string;
  welcome?: Record<string, unknown>;
  protocol_version_mismatch?: Record<string, unknown>;
  offer?: Record<string, unknown>;
  lease?: Record<string, unknown>;
  capability_mismatch?: Record<string, unknown>;
  event_ack?: Record<string, unknown>;
  trace_gap?: Record<string, unknown>;
  trace_integrity_violation?: Record<string, unknown>;
  artifact_manifest_ack?: Record<string, unknown>;
  artifact_chunk_ack?: Record<string, unknown>;
}

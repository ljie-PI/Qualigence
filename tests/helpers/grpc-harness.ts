import * as grpc from "@grpc/grpc-js";
import { capabilities } from "@qualigence/runner-protocol";
import type { RunnerHello } from "@qualigence/runner-protocol";
import {
  CertificateRunnerIdentity,
  GrpcRunnerProtocolClient,
  GrpcRunnerProtocolServer,
} from "@qualigence/grpc-runner-protocol";
import type {
  GrpcRunnerProtocolServerOptions,
  WelcomeParameters,
} from "@qualigence/grpc-runner-protocol";
import { runnerServiceDefinition } from "../../packages/protocol-adapters/grpc-runner-protocol/src/proto.js";
import type {
  RunnerFrameWire,
  ServerFrameWire,
} from "../../packages/protocol-adapters/grpc-runner-protocol/src/proto.js";
import type { CertificateMaterial, GrpcTestPki } from "./grpc-test-pki.js";

export function welcomeParameters(overrides: Partial<WelcomeParameters> = {}): WelcomeParameters {
  return {
    serverVersion: "0.1.0",
    heartbeatIntervalMs: 5_000,
    leaseDurationMs: 30_000,
    traceBatchMaximumEvents: 128,
    traceBatchMaximumBytes: 262_144,
    maximumInFlightBatches: 2,
    maximumPendingWriteBytes: 4_096,
    ...overrides,
  };
}

export async function startTestServer(
  pki: GrpcTestPki,
  overrides: Partial<GrpcRunnerProtocolServerOptions> = {},
): Promise<{ server: GrpcRunnerProtocolServer; port: number }> {
  const server = new GrpcRunnerProtocolServer({
    tls: { ca: pki.ca, key: pki.server.key, cert: pki.server.cert },
    identity: new CertificateRunnerIdentity(),
    welcome: welcomeParameters(),
    ...overrides,
  });
  const port = await server.listen();
  return { server, port };
}

export function makeTestClient(
  pki: GrpcTestPki,
  port: number,
  cert?: CertificateMaterial,
): GrpcRunnerProtocolClient {
  return new GrpcRunnerProtocolClient({
    address: `127.0.0.1:${port}`,
    tls: cert === undefined ? { ca: pki.ca } : { ca: pki.ca, key: cert.key, cert: cert.cert },
    authority: "localhost",
  });
}

export interface RawTestStream {
  readonly stream: grpc.ClientDuplexStream<RunnerFrameWire, ServerFrameWire>;
  close(): void;
}

export function makeRawTestStream(
  pki: GrpcTestPki,
  port: number,
  cert: CertificateMaterial,
): RawTestStream {
  const credentials = grpc.credentials.createSsl(pki.ca, cert.key, cert.cert);
  const Stub = runnerServiceDefinition().clientConstructor;
  const client = new Stub(`127.0.0.1:${port}`, credentials, {
    "grpc.ssl_target_name_override": "localhost",
    "grpc.default_authority": "localhost",
  });
  const stream = client.Connect();
  stream.on("error", () => undefined);
  return {
    stream,
    close: (): void => client.close(),
  };
}

export function makeHello(
  runnerId: string,
  options: { readonly supportedProtocolMajors?: readonly number[]; readonly resumeToken?: string } = {},
): RunnerHello {
  const base: RunnerHello = {
    runnerId,
    runnerVersion: "0.1.0",
    supportedProtocolMajors: options.supportedProtocolMajors ?? [1],
    capabilities: capabilities({ targetAdapters: ["web-playwright"] }),
  };
  return options.resumeToken === undefined ? base : { ...base, resumeToken: options.resumeToken };
}

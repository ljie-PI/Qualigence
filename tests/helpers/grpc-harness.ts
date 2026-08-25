import * as grpc from "@grpc/grpc-js";
import { capabilities, negotiateCapabilities, negotiateProtocolMajor } from "@qualigence/runner-protocol";
import type {
  AcceptedExecutionJob,
  ExecutionCompletion,
  ExecutionEventAck,
  ExecutionEventBatch,
  ExecutionJobLease,
  ExecutionJobOffer,
  RunnerHello,
  RunnerWelcome,
} from "@qualigence/runner-protocol";
import {
  CertificateRunnerIdentity,
  GrpcRunnerProtocolClient,
  GrpcRunnerProtocolServer,
  RunnerProtocolError,
} from "@qualigence/grpc-runner-protocol";
import type {
  AuthenticatedRunnerContext,
  GrpcRunnerProtocolServerOptions,
  RunnerProtocolApplication,
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

export class RecordingRunnerProtocolApplication implements RunnerProtocolApplication {
  readonly calls: string[] = [];
  ingestBarrier: Promise<void> = Promise.resolve();
  private readonly sessions = new Map<string, { identity: AuthenticatedRunnerContext; capabilities: RunnerHello["capabilities"] }>();
  private readonly resumeTokens = new Map<string, { runnerId: string; certificateFingerprint: string; sessionId: string }>();
  private readonly offers = new Map<string, ExecutionJobOffer>();
  private readonly leases = new Map<string, ExecutionJobLease>();
  private readonly cursors = new Map<string, number>();
  private readonly completions = new Map<string, ExecutionCompletion>();
  private sessionSeq = 0;

  constructor(private readonly welcome: WelcomeParameters) {}

  async openSession(hello: RunnerHello, identity: AuthenticatedRunnerContext): Promise<RunnerWelcome> {
    this.calls.push("openSession");
    const negotiation = negotiateProtocolMajor(hello.supportedProtocolMajors);
    if (negotiation.outcome === "rejected") {
      throw new RunnerProtocolError("ProtocolVersionMismatch", "no shared protocol major");
    }
    let sessionId = `session-${(this.sessionSeq += 1)}`;
    if (hello.resumeToken !== undefined) {
      const record = this.resumeTokens.get(hello.resumeToken);
      this.resumeTokens.delete(hello.resumeToken);
      if (
        record === undefined ||
        record.runnerId !== identity.runnerId ||
        record.certificateFingerprint !== identity.certificateFingerprint
      ) {
        throw new RunnerProtocolError("ResumeRejected", "resume token rejected");
      }
      sessionId = record.sessionId;
    }
    this.sessions.set(sessionId, { identity, capabilities: hello.capabilities });
    const resumeToken = `resume-${sessionId}-${this.sessionSeq}`;
    this.resumeTokens.set(resumeToken, {
      runnerId: identity.runnerId,
      certificateFingerprint: identity.certificateFingerprint,
      sessionId,
    });
    return {
      sessionId,
      resumeToken,
      selectedProtocolMajor: negotiation.selectedProtocolMajor,
      serverVersion: this.welcome.serverVersion,
      heartbeatIntervalMs: this.welcome.heartbeatIntervalMs,
      leaseDurationMs: this.welcome.leaseDurationMs,
      traceBatchMaximumEvents: this.welcome.traceBatchMaximumEvents,
      traceBatchMaximumBytes: this.welcome.traceBatchMaximumBytes,
      maximumInFlightBatches: this.welcome.maximumInFlightBatches,
      maximumPendingWriteBytes: this.welcome.maximumPendingWriteBytes,
    };
  }

  async createOffer(
    sessionId: string,
    job: AcceptedExecutionJob,
    requirements: readonly string[],
  ): Promise<ExecutionJobOffer> {
    this.calls.push("createOffer");
    const session = this.requireSession(sessionId);
    const negotiation = negotiateCapabilities(session.capabilities, requirements);
    if (negotiation.outcome === "rejected") {
      throw new RunnerProtocolError("CapabilityMismatch", "runner is missing required capabilities");
    }
    const offer: ExecutionJobOffer = {
      offerId: `${sessionId}:offer:${this.offers.size + 1}`,
      job,
      requiredCapabilities: [...requirements],
      leaseDurationMs: this.welcome.leaseDurationMs,
    };
    this.offers.set(offer.offerId, offer);
    return offer;
  }

  async accept(sessionId: string, offerId: string): Promise<ExecutionJobLease> {
    this.calls.push("accept");
    this.requireSession(sessionId);
    const offer = this.offers.get(offerId);
    if (offer === undefined) {
      throw new RunnerProtocolError("UnknownOffer", `offer ${offerId} is not known`);
    }
    const existing = this.leases.get(offer.job.runId);
    if (existing !== undefined) return existing;
    const lease: ExecutionJobLease = {
      jobId: offer.job.jobId,
      runId: offer.job.runId,
      leaseToken: `token-${offer.job.runId}`,
      leaseEpoch: 1,
      expiresAt: new Date(Date.now() + this.welcome.leaseDurationMs).toISOString(),
    };
    this.leases.set(offer.job.runId, lease);
    return lease;
  }

  async renew(sessionId: string, lease: ExecutionJobLease): Promise<ExecutionJobLease> {
    this.calls.push("renew");
    this.requireSession(sessionId);
    const held = this.leases.get(lease.runId);
    if (held === undefined || held.leaseToken !== lease.leaseToken) {
      throw new RunnerProtocolError("LeaseLost", `lease for run ${lease.runId} is no longer valid`);
    }
    const renewed = {
      ...held,
      expiresAt: new Date(Date.now() + this.welcome.leaseDurationMs).toISOString(),
    };
    this.leases.set(lease.runId, renewed);
    return renewed;
  }

  async ingest(sessionId: string, batch: ExecutionEventBatch): Promise<ExecutionEventAck> {
    this.calls.push("ingest");
    this.requireSession(sessionId);
    await this.ingestBarrier;
    const expected = this.cursors.get(batch.runId) ?? 1;
    const next = batch.firstSequenceNumber <= expected
      ? Math.max(expected, batch.firstSequenceNumber + batch.events.length)
      : expected;
    this.cursors.set(batch.runId, next);
    return {
      batchId: batch.batchId,
      runId: batch.runId,
      nextExpectedSequenceNumber: next,
    };
  }

  async complete(
    sessionId: string,
    lease: ExecutionJobLease,
    completion: ExecutionCompletion,
  ): Promise<void> {
    this.calls.push("complete");
    this.requireSession(sessionId);
    this.completions.set(lease.runId, completion);
  }

  async closeSession(sessionId: string): Promise<void> {
    this.calls.push("closeSession");
    this.sessions.delete(sessionId);
  }

  nextExpectedSequence(runId: string): number {
    return this.cursors.get(runId) ?? 1;
  }

  completionOf(runId: string): ExecutionCompletion | undefined {
    return this.completions.get(runId);
  }

  private requireSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new RunnerProtocolError("UnknownSession", `session ${sessionId} is not known`);
    }
    return session;
  }
}

export async function startTestServer(
  pki: GrpcTestPki,
  overrides: Partial<GrpcRunnerProtocolServerOptions> & {
    readonly welcome?: Partial<WelcomeParameters>;
  } = {},
): Promise<{
  server: GrpcRunnerProtocolServer;
  port: number;
  application: RecordingRunnerProtocolApplication | RunnerProtocolApplication;
}> {
  const welcome = welcomeParameters(overrides.welcome);
  const application = overrides.application ?? new RecordingRunnerProtocolApplication(welcome);
  const { welcome: _welcome, ...serverOverrides } = overrides;
  const server = new GrpcRunnerProtocolServer({
    tls: { ca: pki.ca, key: pki.server.key, cert: pki.server.cert },
    authenticator: new CertificateRunnerIdentity(),
    application,
    ...serverOverrides,
  });
  const port = await server.listen();
  return { server, port, application };
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
    capabilities: capabilities({ targetAdapters: ["web-playwright"], observationExtensions: ["observation-graph/v1", "web/v1"] }),
  };
  return options.resumeToken === undefined ? base : { ...base, resumeToken: options.resumeToken };
}

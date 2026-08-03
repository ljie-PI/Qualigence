import { randomBytes, randomUUID } from "node:crypto";
import type { PeerCertificate } from "node:tls";
import * as grpc from "@grpc/grpc-js";
import type {
  AcceptedExecutionJob,
  ExecutionJobLease,
  RunnerWelcome,
} from "@qualigence/runner-protocol";
import { negotiateProtocolMajor, SUPPORTED_PROTOCOL_MAJORS } from "@qualigence/runner-protocol";
import { createDeferred } from "./async.js";
import type { Deferred } from "./async.js";
import { RunnerProtocolError } from "./errors.js";
import {
  acceptOfferFromWire,
  eventAckToWire,
  eventBatchFromWire,
  helloFromWire,
  jobToWire,
  leaseToWire,
  offerToWire,
  protocolVersionMismatchToWire,
  renewLeaseFromWire,
  welcomeToWire,
} from "./mappers.js";
import type { RunnerConnectionPort, WelcomeParameters } from "./ports.js";
import { runnerServiceDefinition } from "./proto.js";
import type { RunnerFrameWire, ServerFrameWire } from "./proto.js";
import { InMemoryResumeTokenStore } from "./resume-token-store.js";
import type { ResumeTokenStore } from "./resume-token-store.js";
import type { TlsRunnerIdentity } from "./tls-runner-identity.js";

const DEFAULT_MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

export interface GrpcRunnerProtocolServerOptions {
  readonly tls: { readonly ca: Buffer; readonly key: Buffer; readonly cert: Buffer };
  readonly identity: TlsRunnerIdentity;
  readonly welcome: WelcomeParameters;
  readonly host?: string;
  readonly port?: number;
  readonly resumeStore?: ResumeTokenStore;
  readonly maxMessageBytes?: number;
  readonly generateId?: () => string;
  readonly now?: () => Date;
}

type Duplex = grpc.ServerDuplexStream<RunnerFrameWire, ServerFrameWire>;

export class GrpcRunnerProtocolServer {
  private readonly server: grpc.Server;
  private readonly options: GrpcRunnerProtocolServerOptions;
  private readonly resumeStore: ResumeTokenStore;
  private readonly generateId: () => string;
  private readonly now: () => Date;
  readonly leaseDurationMs: number;
  private readonly connections = new Map<string, ServerRunnerConnection>();
  private readonly connectionWaiters = new Map<string, Array<Deferred<RunnerConnectionPort>>>();
  /** Trace upload cursor per runId; survives reconnects so resume continues it. */
  private readonly traceCursors = new Map<string, number>();
  private boundPort: number | undefined;

  constructor(options: GrpcRunnerProtocolServerOptions) {
    this.options = options;
    this.resumeStore = options.resumeStore ?? new InMemoryResumeTokenStore();
    this.generateId = options.generateId ?? ((): string => randomUUID());
    this.now = options.now ?? ((): Date => new Date());
    this.leaseDurationMs = options.welcome.leaseDurationMs;
    const maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    this.server = new grpc.Server({
      "grpc.max_receive_message_length": maxMessageBytes,
      "grpc.max_send_message_length": maxMessageBytes,
    });
    this.server.addService(runnerServiceDefinition().service, {
      Connect: (call: Duplex): void => this.handleConnect(call),
    } as unknown as grpc.UntypedServiceImplementation);
  }

  async listen(): Promise<number> {
    const host = this.options.host ?? "127.0.0.1";
    const port = this.options.port ?? 0;
    const credentials = grpc.ServerCredentials.createSsl(
      this.options.tls.ca,
      [{ private_key: this.options.tls.key, cert_chain: this.options.tls.cert }],
      true,
    );
    this.boundPort = await new Promise<number>((resolve, reject) => {
      this.server.bindAsync(`${host}:${port}`, credentials, (error, bound) => {
        if (error) reject(error);
        else resolve(bound);
      });
    });
    return this.boundPort;
  }

  connection(runnerId: string): RunnerConnectionPort | undefined {
    return this.connections.get(runnerId);
  }

  waitForConnection(runnerId: string, signal?: AbortSignal): Promise<RunnerConnectionPort> {
    const existing = this.connections.get(runnerId);
    if (existing) {
      return Promise.resolve(existing);
    }
    const deferred = createDeferred<RunnerConnectionPort>();
    const waiters = this.connectionWaiters.get(runnerId) ?? [];
    waiters.push(deferred);
    this.connectionWaiters.set(runnerId, waiters);
    if (signal) {
      signal.addEventListener(
        "abort",
        () => deferred.reject(signal.reason ?? new Error("aborted")),
        { once: true },
      );
    }
    return deferred.promise;
  }

  async shutdown(): Promise<void> {
    for (const connection of this.connections.values()) {
      connection.dispose(new RunnerProtocolError("SessionClosed", "server shutting down"));
    }
    this.connections.clear();
    await new Promise<void>((resolve) => {
      this.server.tryShutdown((error) => {
        if (error) this.server.forceShutdown();
        resolve();
      });
    });
  }

  nextTraceAck(runId: string, firstSequenceNumber: number, eventCount: number): number {
    const expected = this.traceCursors.get(runId) ?? 1;
    if (firstSequenceNumber > expected) {
      return expected;
    }
    const next = Math.max(expected, firstSequenceNumber + eventCount);
    this.traceCursors.set(runId, next);
    return next;
  }

  private handleConnect(call: Duplex): void {
    let established = false;
    let connection: ServerRunnerConnection | undefined;

    call.on("data", (frame: RunnerFrameWire) => {
      if (!established) {
        established = true;
        connection = this.establishSession(call, frame);
        return;
      }
      if (connection) {
        connection.handleFrame(frame);
      }
    });

    const teardown = (reason: unknown): void => {
      if (connection) {
        this.releaseConnection(connection);
        connection.dispose(reason);
        connection = undefined;
      }
    };

    call.on("end", () => {
      call.end();
      teardown(new RunnerProtocolError("SessionClosed", "runner ended the stream"));
    });
    call.on("error", (error) => teardown(error));
    call.on("cancelled", () =>
      teardown(new RunnerProtocolError("SessionClosed", "runner cancelled the stream")),
    );
  }

  private establishSession(call: Duplex, frame: RunnerFrameWire): ServerRunnerConnection | undefined {
    if (frame.hello === undefined) {
      failCall(call, grpc.status.FAILED_PRECONDITION, "ProtocolViolation");
      return undefined;
    }

    const peer = peerCertificate(call);
    const hello = helloFromWire(frame.hello);

    let identity;
    try {
      identity = this.options.identity.authenticate(peer, hello.runnerId);
    } catch (error) {
      if (error instanceof RunnerProtocolError) {
        failCall(call, grpc.status.UNAUTHENTICATED, error.code);
        return undefined;
      }
      failCall(call, grpc.status.UNAUTHENTICATED, "TlsPeerRejected");
      return undefined;
    }

    const negotiation = negotiateProtocolMajor(hello.supportedProtocolMajors);
    if (negotiation.outcome === "rejected") {
      call.write({
        correlation_id: frame.correlation_id,
        protocol_version_mismatch: protocolVersionMismatchToWire(
          negotiation.rejection.offeredProtocolMajors,
          negotiation.rejection.supportedProtocolMajors,
        ),
      });
      call.end();
      return undefined;
    }

    if (hello.resumeToken !== undefined) {
      const resumed = this.resumeStore.consume(hello.resumeToken, {
        runnerId: identity.runnerId,
        certificateFingerprint: identity.certificateFingerprint,
      });
      if (resumed === undefined) {
        failCall(call, grpc.status.UNAUTHENTICATED, "ResumeRejected");
        return undefined;
      }
    }

    const sessionId = this.generateId();
    const resumeToken = this.resumeStore.issue({
      runnerId: identity.runnerId,
      certificateFingerprint: identity.certificateFingerprint,
      previousSessionId: sessionId,
    });

    const welcome: RunnerWelcome = {
      sessionId,
      resumeToken,
      selectedProtocolMajor: negotiation.selectedProtocolMajor,
      serverVersion: this.options.welcome.serverVersion,
      heartbeatIntervalMs: this.options.welcome.heartbeatIntervalMs,
      leaseDurationMs: this.options.welcome.leaseDurationMs,
      traceBatchMaximumEvents: this.options.welcome.traceBatchMaximumEvents,
      traceBatchMaximumBytes: this.options.welcome.traceBatchMaximumBytes,
      maximumInFlightBatches: this.options.welcome.maximumInFlightBatches,
      maximumPendingWriteBytes: this.options.welcome.maximumPendingWriteBytes,
    };

    call.write({ correlation_id: frame.correlation_id, welcome: welcomeToWire(welcome) });

    const connection = new ServerRunnerConnection(this, call, identity.runnerId, sessionId);
    this.registerConnection(connection);
    return connection;
  }

  private registerConnection(connection: ServerRunnerConnection): void {
    this.connections.set(connection.runnerId, connection);
    const waiters = this.connectionWaiters.get(connection.runnerId);
    if (waiters) {
      this.connectionWaiters.delete(connection.runnerId);
      for (const waiter of waiters) waiter.resolve(connection);
    }
  }

  private releaseConnection(connection: ServerRunnerConnection): void {
    if (this.connections.get(connection.runnerId) === connection) {
      this.connections.delete(connection.runnerId);
    }
  }

  issueLease(job: AcceptedExecutionJob, leaseEpoch: number): ExecutionJobLease {
    return {
      jobId: job.jobId,
      runId: job.runId,
      leaseToken: randomBytes(32).toString("base64url"),
      leaseEpoch,
      expiresAt: new Date(this.now().getTime() + this.options.welcome.leaseDurationMs).toISOString(),
    };
  }
}

class ServerRunnerConnection implements RunnerConnectionPort {
  private readonly pendingOffers = new Map<string, Deferred<ExecutionJobLease>>();
  private readonly offeredJobs = new Map<string, { job: AcceptedExecutionJob; epoch: number }>();
  private leaseEpoch = 0;
  private disposed = false;

  constructor(
    private readonly server: GrpcRunnerProtocolServer,
    private readonly call: Duplex,
    readonly runnerId: string,
    readonly sessionId: string,
  ) {}

  offer(job: AcceptedExecutionJob, requirements: readonly string[]): Promise<ExecutionJobLease> {
    if (this.disposed) {
      return Promise.reject(new RunnerProtocolError("SessionClosed", "runner connection is closed"));
    }
    const offerId = `${this.sessionId}:offer:${this.offeredJobs.size + 1}`;
    this.leaseEpoch += 1;
    this.offeredJobs.set(offerId, { job, epoch: this.leaseEpoch });
    const deferred = createDeferred<ExecutionJobLease>();
    this.pendingOffers.set(offerId, deferred);
    this.call.write({
      correlation_id: offerId,
      offer: offerToWire({
        offerId,
        job,
        requiredCapabilities: requirements,
        leaseDurationMs: this.server.leaseDurationMs,
      }),
    });
    return deferred.promise;
  }

  cancel(_jobId: string, reason: string): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.dispose(new RunnerProtocolError("SessionClosed", `cancelled: ${reason}`));
    this.call.end();
    return Promise.resolve();
  }

  handleFrame(frame: RunnerFrameWire): void {
    if (frame.accept_offer !== undefined) {
      this.handleAcceptOffer(frame);
      return;
    }
    if (frame.event_batch !== undefined) {
      this.handleEventBatch(frame);
      return;
    }
    if (frame.renew_lease !== undefined) {
      this.handleRenewLease(frame);
      return;
    }
    // complete_execution and any unknown frames are accepted without a reply.
  }

  private handleAcceptOffer(frame: RunnerFrameWire): void {
    const offerId = acceptOfferFromWire(frame.accept_offer as Record<string, unknown>);
    const offered = this.offeredJobs.get(offerId);
    const deferred = this.pendingOffers.get(offerId);
    if (offered === undefined || deferred === undefined) {
      return;
    }
    this.pendingOffers.delete(offerId);
    const lease = this.server.issueLease(offered.job, offered.epoch);
    this.call.write({ correlation_id: offerId, lease: leaseToWire(lease) });
    deferred.resolve(lease);
  }

  private handleEventBatch(frame: RunnerFrameWire): void {
    const batch = eventBatchFromWire(frame.event_batch as Record<string, unknown>);
    const nextExpected = this.server.nextTraceAck(
      batch.runId,
      batch.firstSequenceNumber,
      batch.events.length,
    );
    this.call.write({
      correlation_id: frame.correlation_id,
      event_ack: eventAckToWire({
        batchId: batch.batchId,
        runId: batch.runId,
        nextExpectedSequenceNumber: nextExpected,
      }),
    });
  }

  private handleRenewLease(frame: RunnerFrameWire): void {
    const request = renewLeaseFromWire(frame.renew_lease as Record<string, unknown>);
    const lease = this.server.issueLease(
      { jobId: request.jobId, runId: request.runId } as AcceptedExecutionJob,
      request.leaseEpoch,
    );
    this.call.write({ correlation_id: frame.correlation_id, lease: leaseToWire(lease) });
  }

  dispose(reason: unknown): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const deferred of this.pendingOffers.values()) {
      deferred.reject(reason);
    }
    this.pendingOffers.clear();
  }
}

function peerCertificate(call: Duplex): PeerCertificate | undefined {
  const authContext = call.getAuthContext();
  return authContext?.sslPeerCertificate;
}

function failCall(call: Duplex, status: grpc.status, code: string): void {
  call.emit("error", { code: status, details: code });
}

export { SUPPORTED_PROTOCOL_MAJORS };

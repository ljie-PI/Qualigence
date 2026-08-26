import type { PeerCertificate } from "node:tls";
import * as grpc from "@grpc/grpc-js";
import type { AuthenticatedRunnerContext, RunnerProtocolApplication, RunnerProtocolApplicationResolver } from "@qualigence/runner-control";
import type {
  AcceptedExecutionJob,
  ExecutionJobLease,
} from "@qualigence/runner-protocol";
import { SUPPORTED_PROTOCOL_MAJORS } from "@qualigence/runner-protocol";
import { createDeferred } from "./async.js";
import type { Deferred } from "./async.js";
import { RunnerProtocolError } from "./errors.js";
import {
  acceptOfferFromWire,
  artifactChunkUploadFromWire,
  artifactManifestRegistrationFromWire,
  artifactUploadAckToWire,
  completionFromWire,
  eventAckToWire,
  eventBatchFromWire,
  helloFromWire,
  leaseToWire,
  offerToWire,
  protocolVersionMismatchToWire,
  renewLeaseFromWire,
  welcomeToWire,
} from "./mappers.js";
import type { RunnerConnectionPort } from "./ports.js";
import { runnerServiceDefinition } from "./proto.js";
import type { RunnerFrameWire, ServerFrameWire } from "./proto.js";
import type { RunnerPeerAuthenticator } from "./tls-runner-identity.js";

const DEFAULT_MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAXIMUM_HANDSHAKE_PENDING_FRAMES = 32;
const DEFAULT_MAXIMUM_HANDSHAKE_PENDING_BYTES = 1024 * 1024;

export interface GrpcRunnerProtocolServerOptions {
  readonly tls: { readonly ca: Buffer; readonly key: Buffer; readonly cert: Buffer };
  readonly authenticator: RunnerPeerAuthenticator;
  readonly application?: RunnerProtocolApplication;
  readonly applicationResolver?: RunnerProtocolApplicationResolver;
  readonly host?: string;
  readonly port?: number;
  readonly maxMessageBytes?: number;
  readonly maximumHandshakePendingFrames?: number;
  readonly maximumHandshakePendingBytes?: number;
  readonly maximumConnectionPendingFrames?: number;
  readonly maximumConnectionPendingBytes?: number;
  readonly beforeWelcome?: () => Promise<void>;
  readonly beforeHandleFrame?: () => Promise<void>;
}

type Duplex = grpc.ServerDuplexStream<RunnerFrameWire, ServerFrameWire>;

export interface RunnerConnectionLookup {
  readonly tenantId: string;
  readonly runnerId: string;
}

type RunnerConnectionSelector = string | RunnerConnectionLookup;

export class GrpcRunnerProtocolServer {
  private readonly server: grpc.Server;
  private readonly options: GrpcRunnerProtocolServerOptions;
  private readonly connections = new Map<string, ServerRunnerConnection>();
  private readonly connectionWaiters = new Map<string, Array<Deferred<RunnerConnectionPort>>>();
  private readonly generations = new Map<string, number>();
  private readonly establishingConnectionKeys = new Set<string>();
  private readonly lastReleased = new Map<string, ServerRunnerConnection>();
  private readonly activeCalls = new Set<Duplex>();
  private readonly handshakes = new Set<Promise<ServerRunnerConnection | undefined>>();
  private readonly ingestCursors = new Map<string, number>();
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | undefined;

  constructor(options: GrpcRunnerProtocolServerOptions) {
    if (options.application === undefined && options.applicationResolver === undefined) {
      throw new Error("GrpcRunnerProtocolServer requires an application or applicationResolver");
    }
    this.options = options;
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
    const credentials = grpc.ServerCredentials.createSsl(
      this.options.tls.ca,
      [{ private_key: this.options.tls.key, cert_chain: this.options.tls.cert }],
      true,
    );
    return new Promise<number>((resolve, reject) => {
      this.server.bindAsync(
        listenerAddress(this.options.host ?? "127.0.0.1", this.options.port ?? 0),
        credentials,
        (error, bound) => {
          if (error) reject(error);
          else resolve(bound);
        },
      );
    });
  }

  connection(runnerId: string): RunnerConnectionPort | undefined {
    return this.connections.get(connectionKey({ kind: "local", runnerId }));
  }

  connectionFor(lookup: RunnerConnectionLookup): RunnerConnectionPort | undefined {
    return this.connections.get(connectionKey({ kind: "tenant", ...lookup }));
  }

  waitForConnection(runnerId: string, signal?: AbortSignal): Promise<RunnerConnectionPort>;
  waitForConnection(lookup: RunnerConnectionLookup, signal?: AbortSignal): Promise<RunnerConnectionPort>;
  waitForConnection(lookup: RunnerConnectionSelector, signal?: AbortSignal): Promise<RunnerConnectionPort> {
    if (this.shuttingDown) {
      return Promise.reject(new RunnerProtocolError("SessionClosed", "server is shutting down"));
    }
    const key = connectionKeyForLookup(lookup);
    const existing = this.connections.get(key);
    if (existing) {
      return Promise.resolve(existing);
    }
    const deferred = createDeferred<RunnerConnectionPort>();
    const waiters = this.connectionWaiters.get(key) ?? [];
    waiters.push(deferred);
    this.connectionWaiters.set(key, waiters);
    if (signal) {
      signal.addEventListener(
        "abort",
        () => deferred.reject(signal.reason ?? new Error("aborted")),
        { once: true },
      );
    }
    return deferred.promise;
  }

  shutdown(): Promise<void> {
    this.shutdownPromise ??= this.shutdownOnce();
    return this.shutdownPromise;
  }

  private async shutdownOnce(): Promise<void> {
    this.shuttingDown = true;
    const reason = new RunnerProtocolError("SessionClosed", "server shutting down");
    for (const waiters of this.connectionWaiters.values()) {
      for (const waiter of waiters) waiter.reject(reason);
    }
    this.connectionWaiters.clear();
    for (const connection of this.connections.values()) {
      connection.dispose(reason);
    }
    this.connections.clear();
    for (const call of this.activeCalls) call.end();
    this.activeCalls.clear();
    await Promise.allSettled([...this.handshakes]);
    await new Promise<void>((resolve) => {
      this.server.tryShutdown((error) => {
        if (error) this.server.forceShutdown();
        resolve();
      });
    });
  }

  nextExpectedSequence(runId: string): number {
    return this.ingestCursors.get(runId) ?? 1;
  }

  recordIngestCursor(runId: string, nextExpectedSequenceNumber: number): void {
    this.ingestCursors.set(runId, nextExpectedSequenceNumber);
  }

  async waitBeforeHandleFrame(): Promise<void> {
    if (this.options.beforeHandleFrame !== undefined) {
      await this.options.beforeHandleFrame();
      return;
    }
    await Promise.resolve();
  }

  private handleConnect(call: Duplex): void {
    if (this.shuttingDown) {
      failCall(call, grpc.status.UNAVAILABLE, "SessionClosed");
      return;
    }
    this.activeCalls.add(call);
    let handshakeStarted = false;
    let terminated = false;
    let connection: ServerRunnerConnection | undefined;
    const buffered: RunnerFrameWire[] = [];
    let bufferedBytes = 0;

    call.on("data", (frame: RunnerFrameWire) => {
      if (!handshakeStarted) {
        handshakeStarted = true;
        const handshake = this.establishSession(call, frame, () => terminated || this.shuttingDown);
        this.handshakes.add(handshake);
        void handshake
          .then((established) => {
            if (established === undefined) return;
            connection = established;
            for (const pending of buffered.splice(0)) established.enqueue(pending);
          }, (error: unknown) => failApplicationCall(call, error))
          .finally(() => this.handshakes.delete(handshake));
        return;
      }
      if (connection !== undefined) {
        connection.enqueue(frame);
        return;
      }
      const frameBytes = frameSize(frame);
      const maximumFrames =
        this.options.maximumHandshakePendingFrames ?? DEFAULT_MAXIMUM_HANDSHAKE_PENDING_FRAMES;
      const maximumBytes =
        this.options.maximumHandshakePendingBytes ?? DEFAULT_MAXIMUM_HANDSHAKE_PENDING_BYTES;
      if (buffered.length >= maximumFrames || bufferedBytes + frameBytes > maximumBytes) {
        terminated = true;
        buffered.length = 0;
        bufferedBytes = 0;
        failCall(call, grpc.status.INVALID_ARGUMENT, "ProtocolViolation");
        return;
      }
      buffered.push(frame);
      bufferedBytes += frameBytes;
    });

    const teardown = (reason: unknown): void => {
      terminated = true;
      this.activeCalls.delete(call);
      buffered.length = 0;
      bufferedBytes = 0;
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

  private async establishSession(
    call: Duplex,
    frame: RunnerFrameWire,
    terminated: () => boolean,
  ): Promise<ServerRunnerConnection | undefined> {
    if (frame.hello === undefined) {
      failCall(call, grpc.status.FAILED_PRECONDITION, "ProtocolViolation");
      return undefined;
    }

    const hello = helloFromWire(frame.hello);
    let identity;
    try {
      identity = await this.options.authenticator.authenticate(peerCertificate(call), hello);
    } catch (error) {
      failCall(
        call,
        grpc.status.UNAUTHENTICATED,
        errorCode(error) === "ProtocolViolation" ? "TlsPeerRejected" : errorCode(error),
      );
      return undefined;
    }

    if (this.options.beforeWelcome !== undefined) {
      await this.options.beforeWelcome();
    } else {
      await Promise.resolve();
    }
    if (terminated()) return undefined;

    const key = connectionKeyFromIdentity(identity);
    if (this.establishingConnectionKeys.has(key)) {
      failCall(call, grpc.status.FAILED_PRECONDITION, "RunnerAlreadyConnected");
      return undefined;
    }

    const existing = this.connections.get(key);
    if (existing !== undefined && hello.resumeToken === undefined) {
      failCall(call, grpc.status.FAILED_PRECONDITION, "RunnerAlreadyConnected");
      return undefined;
    }

    this.establishingConnectionKeys.add(key);
    let application: RunnerProtocolApplication | undefined;
    try {
      if (terminated()) return undefined;
      application = await this.applicationFor(identity);
      const welcome = await application.openSession(hello, identity);
      if (terminated()) {
        await application.closeSession(welcome.sessionId).catch(() => undefined);
        return undefined;
      }

      const generation = (this.generations.get(key) ?? 0) + 1;
      this.generations.set(key, generation);
      if (existing !== undefined) {
        this.releaseConnection(existing);
        existing.dispose(new RunnerProtocolError("SessionClosed", "runner connection superseded"));
      }

      call.write({ correlation_id: frame.correlation_id, welcome: welcomeToWire(welcome) });
      const connection = new ServerRunnerConnection(
        this,
        application,
        call,
        identity,
        key,
        capabilityTokens(hello),
        welcome.sessionId,
        generation,
        this.options.maximumConnectionPendingFrames ?? DEFAULT_MAXIMUM_HANDSHAKE_PENDING_FRAMES,
        this.options.maximumConnectionPendingBytes ?? DEFAULT_MAXIMUM_HANDSHAKE_PENDING_BYTES,
      );
      this.registerConnection(connection);
      return connection;
    } catch (error) {
      const code = errorCode(error);
      if (code === "ProtocolVersionMismatch") {
        const details = (error as { readonly details?: { readonly offeredProtocolMajors?: readonly number[]; readonly supportedProtocolMajors?: readonly number[] } }).details;
        call.write({
          correlation_id: frame.correlation_id,
          protocol_version_mismatch: protocolVersionMismatchToWire(
            details?.offeredProtocolMajors ?? hello.supportedProtocolMajors,
            details?.supportedProtocolMajors ?? [...SUPPORTED_PROTOCOL_MAJORS],
          ),
        });
        call.end();
        return undefined;
      }
      failApplicationCall(call, error);
      return undefined;
    } finally {
      this.establishingConnectionKeys.delete(key);
    }
  }

  private async applicationFor(identity: AuthenticatedRunnerContext): Promise<RunnerProtocolApplication> {
    const resolved = this.options.applicationResolver === undefined
      ? this.options.application
      : await this.options.applicationResolver.resolve(identity);
    if (resolved === undefined) {
      throw new RunnerProtocolError("ProtocolViolation", "runner application could not be resolved");
    }
    return resolved;
  }

  private registerConnection(connection: ServerRunnerConnection): void {
    this.connections.set(connection.connectionKey, connection);
    const waiters = this.connectionWaiters.get(connection.connectionKey);
    if (waiters) {
      this.connectionWaiters.delete(connection.connectionKey);
      for (const waiter of waiters) waiter.resolve(connection);
    }
  }

  private releaseConnection(connection: ServerRunnerConnection): void {
    if (this.connections.get(connection.connectionKey) === connection) {
      this.connections.delete(connection.connectionKey);
    }
    this.lastReleased.set(connection.connectionKey, connection);
  }

  supersededConnection(runnerId: string): ServerRunnerConnection | undefined {
    return this.lastReleased.get(connectionKey({ kind: "local", runnerId }));
  }

  connectionGeneration(runnerId: string): number | undefined {
    return this.generations.get(connectionKey({ kind: "local", runnerId }));
  }

  isCurrentGeneration(connectionKeyOrRunnerId: string, generation: number): boolean {
    return (
      this.generations.get(connectionKeyOrRunnerId) ??
      this.generations.get(connectionKey({ kind: "local", runnerId: connectionKeyOrRunnerId }))
    ) === generation;
  }

  isCurrentConnection(connection: ServerRunnerConnection): boolean {
    return (
      this.connections.get(connection.connectionKey) === connection &&
      this.isCurrentGeneration(connection.connectionKey, connection.generation)
    );
  }
}

class ServerRunnerConnection implements RunnerConnectionPort {
  private readonly pendingOffers = new Map<string, Deferred<ExecutionJobLease>>();
  private readonly lastLeases = new Map<string, ExecutionJobLease>();
  private processing: Promise<void> = Promise.resolve();
  private pendingFrameCount = 0;
  private pendingFrameBytes = 0;
  private disposed = false;

  constructor(
    private readonly server: GrpcRunnerProtocolServer,
    private readonly application: RunnerProtocolApplication,
    private readonly call: Duplex,
    readonly identity: Awaited<ReturnType<RunnerPeerAuthenticator["authenticate"]>>,
    readonly connectionKey: string,
    capabilities: readonly string[],
    readonly sessionId: string,
    readonly generation: number,
    private readonly maximumPendingFrames: number,
    private readonly maximumPendingBytes: number,
  ) {
    this.authenticatedRunner = { runnerId: identity.runnerId, scope: identity.scope, capabilities };
  }

  readonly authenticatedRunner: RunnerConnectionPort["authenticatedRunner"];
  get runnerId(): string { return this.identity.runnerId; }

  async offer(job: AcceptedExecutionJob, requirements: readonly string[]): Promise<ExecutionJobLease> {
    this.assertCurrent("runner connection is closed");
    this.authorizePayloadAdmission(job, requirements);
    const offer = await this.application.createOffer(this.sessionId, job, requirements);
    this.assertCurrent("runner connection closed while creating offer");
    const existing = this.pendingOffers.get(offer.offerId);
    if (existing !== undefined) return existing.promise;
    const deferred = createDeferred<ExecutionJobLease>();
    this.pendingOffers.set(offer.offerId, deferred);
    this.call.write({
      correlation_id: offer.offerId,
      offer: offerToWire(offer),
    });
    return deferred.promise;
  }

  private assertCurrent(message: string): void {
    if (this.disposed || !this.server.isCurrentConnection(this)) {
      throw new RunnerProtocolError("SessionClosed", message);
    }
  }

  cancel(_jobId: string, reason: string): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.dispose(new RunnerProtocolError("SessionClosed", `cancelled: ${reason}`));
    return Promise.resolve();
  }

  private authorizePayloadAdmission(job: AcceptedExecutionJob, requirements: readonly string[]): void {
    const runner = this.authenticatedRunner;
    if (runner.scope.kind === "tenant" && !runner.scope.projectIds.includes(job.projectId)) {
      throw new RunnerProtocolError(
        "RunnerScopeViolation",
        `runner ${runner.runnerId} is not authorized for project ${job.projectId}`,
        { details: { runnerId: runner.runnerId, tenantId: runner.scope.tenantId, projectId: job.projectId } },
      );
    }
    const advertised = new Set(runner.capabilities);
    const missingCapabilities = requirements.filter((requirement) => !advertised.has(requirement));
    if (missingCapabilities.length > 0) {
      throw new RunnerProtocolError("CapabilityMismatch", "runner is missing required capabilities", {
        details: { missingCapabilities },
      });
    }
  }

  drain(): Promise<void> {
    return this.processing;
  }

  enqueue(frame: RunnerFrameWire): void {
    if (!this.server.isCurrentGeneration(this.connectionKey, this.generation)) {
      return;
    }
    if (this.disposed) return;
    const frameBytes = frameSize(frame);
    if (
      this.pendingFrameCount >= this.maximumPendingFrames ||
      this.pendingFrameBytes + frameBytes > this.maximumPendingBytes
    ) {
      const error = new RunnerProtocolError("ProtocolViolation", "runner frame queue limit exceeded");
      failCall(this.call, grpc.status.INVALID_ARGUMENT, error.code);
      this.dispose(error);
      return;
    }
    this.pendingFrameCount += 1;
    this.pendingFrameBytes += frameBytes;
    this.processing = this.processing
      .then(async () => {
        if (!this.disposed) await this.handleFrame(frame);
      })
      .catch((error: unknown) => {
        failApplicationCall(this.call, error);
        this.dispose(error);
      })
      .finally(() => {
        this.pendingFrameCount -= 1;
        this.pendingFrameBytes -= frameBytes;
      });
  }

  async handleFrame(frame: RunnerFrameWire): Promise<void> {
    await this.server.waitBeforeHandleFrame();
    if (this.disposed) {
      throw new RunnerProtocolError("SessionClosed", "runner connection is closed");
    }
    if (!this.server.isCurrentGeneration(this.connectionKey, this.generation)) {
      return;
    }
    if (frame.accept_offer !== undefined) {
      const offerId = acceptOfferFromWire(frame.accept_offer as Record<string, unknown>);
      const lease = await this.application.accept(this.sessionId, offerId);
      this.lastLeases.set(lease.runId, lease);
      this.call.write({ correlation_id: frame.correlation_id, lease: leaseToWire(lease) });
      const pending = this.pendingOffers.get(offerId);
      if (pending !== undefined) {
        this.pendingOffers.delete(offerId);
        pending.resolve(lease);
      }
      return;
    }
    if (frame.event_batch !== undefined) {
      const ack = await this.application.ingest(
        this.sessionId,
        eventBatchFromWire(frame.event_batch as Record<string, unknown>),
      );
      this.server.recordIngestCursor(ack.runId, ack.nextExpectedSequenceNumber);
      this.call.write({
        correlation_id: frame.correlation_id,
        event_ack: eventAckToWire(ack),
      });
      return;
    }
    if (frame.renew_lease !== undefined) {
      const lease = await this.application.renew(
        this.sessionId,
        renewLeaseFromWire(frame.renew_lease as Record<string, unknown>),
      );
      this.lastLeases.set(lease.runId, lease);
      this.call.write({ correlation_id: frame.correlation_id, lease: leaseToWire(lease) });
      return;
    }
    if (frame.register_artifact_manifest !== undefined) {
      const ack = await this.application.registerArtifactManifest(
        this.sessionId,
        artifactManifestRegistrationFromWire(frame.register_artifact_manifest as Record<string, unknown>),
      );
      this.call.write({ correlation_id: frame.correlation_id, artifact_manifest_ack: artifactUploadAckToWire(ack) });
      return;
    }
    if (frame.upload_artifact_chunk !== undefined) {
      const ack = await this.application.uploadArtifactChunk(
        this.sessionId,
        artifactChunkUploadFromWire(frame.upload_artifact_chunk as Record<string, unknown>),
      );
      this.call.write({ correlation_id: frame.correlation_id, artifact_chunk_ack: artifactUploadAckToWire(ack) });
      return;
    }
    if (frame.complete_execution !== undefined) {
      const completion = completionFromWire(frame.complete_execution as Record<string, unknown>);
      const lease = this.lastLeases.get(completion.runId);
      if (lease === undefined) {
        await this.application.complete(this.sessionId, {
          jobId: completion.jobId,
          runId: completion.runId,
          leaseToken: "",
          leaseEpoch: 0,
          expiresAt: new Date(0).toISOString(),
        }, completion);
        return;
      }
      await this.application.complete(this.sessionId, lease, completion);
    }
  }

  dispose(reason: unknown): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const deferred of this.pendingOffers.values()) {
      deferred.reject(reason);
    }
    this.pendingOffers.clear();
    this.call.end();
    if (this.server.isCurrentGeneration(this.connectionKey, this.generation)) {
      void this.application.closeSession(this.sessionId).catch(() => undefined);
    }
  }
}

function frameSize(frame: RunnerFrameWire): number {
  return Buffer.byteLength(JSON.stringify(frame), "utf8");
}

function peerCertificate(call: Duplex): PeerCertificate | undefined {
  const authContext = call.getAuthContext();
  return authContext?.sslPeerCertificate;
}

function errorCode(error: unknown): string {
  if (error instanceof RunnerProtocolError) return error.code;
  const candidate = (error ?? {}) as { readonly code?: unknown };
  if (candidate.code === "RunnerResumeRejected") return "ResumeRejected";
  return typeof candidate.code === "string" ? candidate.code : "ProtocolViolation";
}

function failApplicationCall(call: Duplex, error: unknown): void {
  const code = errorCode(error);
  const status =
    code === "LeaseLost" || code === "RunIdentityMismatch" || code === "ArtifactUnacknowledged" || code === "ArtifactUploadRejected"
      ? grpc.status.FAILED_PRECONDITION
      : grpc.status.INVALID_ARGUMENT;
  failCall(call, status, code);
}

function failCall(call: Duplex, status: grpc.status, code: string): void {
  call.emit("error", { code: status, details: code });
}

export { SUPPORTED_PROTOCOL_MAJORS };

function listenerAddress(host: string, port: number): string {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

function connectionKeyForLookup(lookup: RunnerConnectionSelector): string {
  return typeof lookup === "string"
    ? connectionKey({ kind: "local", runnerId: lookup })
    : connectionKey({ kind: "tenant", tenantId: lookup.tenantId, runnerId: lookup.runnerId });
}

function connectionKeyFromIdentity(identity: AuthenticatedRunnerContext): string {
  return identity.scope.kind === "tenant"
    ? connectionKey({ kind: "tenant", tenantId: identity.scope.tenantId, runnerId: identity.runnerId })
    : connectionKey({ kind: "local", runnerId: identity.runnerId });
}

function connectionKey(input: { readonly kind: "local"; readonly runnerId: string } | { readonly kind: "tenant"; readonly tenantId: string; readonly runnerId: string }): string {
  return input.kind === "local"
    ? JSON.stringify(["local", input.runnerId])
    : JSON.stringify(["tenant", input.tenantId, input.runnerId]);
}

function capabilityTokens(hello: import("@qualigence/runner-protocol").RunnerHello): readonly string[] {
  return [
    ...hello.capabilities.targetAdapters.map((value) => `target:${value}`),
    ...hello.capabilities.observationExtensions.map((value) => `observation:${value}`),
    ...hello.capabilities.actionKinds.map((value) => `action:${value}`),
    ...(hello.capabilities.model.structuredOutput ? ["model:structured-output"] : []),
    ...(hello.capabilities.model.visionInput ? ["model:vision-input"] : []),
  ];
}

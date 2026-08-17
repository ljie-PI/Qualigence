import { randomUUID } from "node:crypto";
import * as grpc from "@grpc/grpc-js";
import type {
  ExecutionCompletion,
  ExecutionEventAck,
  ExecutionEventBatch,
  ExecutionJobLease,
  ExecutionJobOffer,
  RunnerHello,
  RunnerWelcome,
} from "@qualigence/runner-protocol";
import { AsyncBlockingQueue, createDeferred, Semaphore } from "./async.js";
import type { Deferred } from "./async.js";
import { RunnerProtocolError } from "./errors.js";
import type { RunnerProtocolErrorCode } from "./errors.js";
import {
  acceptOfferToWire,
  capabilityMismatchFromWire,
  completionToWire,
  eventAckFromWire,
  eventBatchToWire,
  helloToWire,
  leaseFromWire,
  offerFromWire,
  protocolVersionMismatchFromWire,
  renewLeaseToWire,
  traceGapFromWire,
  traceIntegrityViolationFromWire,
  welcomeFromWire,
} from "./mappers.js";
import type { RunnerClientPort, RunnerSession } from "./ports.js";
import { runnerServiceDefinition } from "./proto.js";
import type { RunnerFrameWire, ServerFrameWire } from "./proto.js";

const DEFAULT_MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

const APPLICATION_ERROR_CODES: ReadonlySet<string> = new Set<RunnerProtocolErrorCode>([
  "RunnerIdentityMismatch",
  "ResumeRejected",
  "LeaseLost",
  "ProtocolViolation",
  "CapabilityMismatch",
  "TlsPeerRejected",
]);

export interface GrpcRunnerProtocolClientOptions {
  readonly address: string;
  readonly tls: { readonly ca: Buffer; readonly key?: Buffer; readonly cert?: Buffer };
  readonly authority?: string;
  readonly maxMessageBytes?: number;
  readonly handshakeTimeoutMs?: number;
  readonly generateId?: () => string;
}

type ClientDuplex = grpc.ClientDuplexStream<RunnerFrameWire, ServerFrameWire>;

interface RunnerServiceStub extends grpc.Client {
  Connect(): ClientDuplex;
}

export class GrpcRunnerProtocolClient implements RunnerClientPort {
  private readonly stub: RunnerServiceStub;
  private readonly generateId: () => string;
  private readonly handshakeTimeoutMs: number;
  private activeSession: ClientRunnerSession | undefined;

  constructor(options: GrpcRunnerProtocolClientOptions) {
    this.generateId = options.generateId ?? ((): string => randomUUID());
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    const maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;

    const credentials =
      options.tls.key !== undefined && options.tls.cert !== undefined
        ? grpc.credentials.createSsl(options.tls.ca, options.tls.key, options.tls.cert)
        : grpc.credentials.createSsl(options.tls.ca);

    const channelOptions: grpc.ClientOptions = {
      "grpc.max_receive_message_length": maxMessageBytes,
      "grpc.max_send_message_length": maxMessageBytes,
    };
    if (options.authority !== undefined) {
      channelOptions["grpc.ssl_target_name_override"] = options.authority;
      channelOptions["grpc.default_authority"] = options.authority;
    }

    const Stub = runnerServiceDefinition().clientConstructor;
    this.stub = new Stub(options.address, credentials, channelOptions) as RunnerServiceStub;
  }

  connect(hello: RunnerHello): Promise<RunnerSession> {
    const stream = this.stub.Connect();
    const correlationId = this.generateId();
    const handshake = createDeferred<RunnerSession>();
    let session: ClientRunnerSession | undefined;
    let settled = false;

    const timer = setTimeout(() => {
      if (session === undefined && !settled) {
        settled = true;
        stream.cancel();
        handshake.reject(new RunnerProtocolError("TransportError", "handshake timed out"));
      }
    }, this.handshakeTimeoutMs);
    timer.unref?.();

    stream.on("data", (frame: ServerFrameWire) => {
      if (session) {
        session.dispatch(frame);
        return;
      }
      if (frame.welcome !== undefined) {
        settled = true;
        clearTimeout(timer);
        const welcome: RunnerWelcome = welcomeFromWire(frame.welcome);
        session = new ClientRunnerSession(stream, welcome, this.generateId);
        this.activeSession = session;
        handshake.resolve(session);
        return;
      }
      if (frame.protocol_version_mismatch !== undefined) {
        settled = true;
        clearTimeout(timer);
        const mismatch = protocolVersionMismatchFromWire(frame.protocol_version_mismatch);
        handshake.reject(
          new RunnerProtocolError("ProtocolVersionMismatch", "no shared protocol major", {
            details: {
              offeredProtocolMajors: mismatch.offeredProtocolMajors,
              supportedProtocolMajors: mismatch.supportedProtocolMajors,
            },
          }),
        );
        return;
      }
      settled = true;
      clearTimeout(timer);
      handshake.reject(new RunnerProtocolError("ProtocolViolation", "unexpected frame before welcome"));
    });

    stream.on("error", (error: unknown) => {
      const mapped = mapTransportError(error);
      if (session) {
        session.fail(mapped);
      } else if (!settled) {
        settled = true;
        clearTimeout(timer);
        handshake.reject(mapped);
      }
    });

    stream.on("end", () => {
      const closed = new RunnerProtocolError("SessionClosed", "server closed the stream");
      if (session) {
        session.fail(closed);
      } else if (!settled) {
        settled = true;
        clearTimeout(timer);
        handshake.reject(closed);
      }
    });

    stream.write({ correlation_id: correlationId, hello: helloToWire(hello) });
    return handshake.promise;
  }

  async close(): Promise<void> {
    if (this.activeSession) {
      await this.activeSession.close();
      this.activeSession = undefined;
    }
    this.stub.close();
  }
}

class ClientRunnerSession implements RunnerSession {
  private readonly pending = new Map<string, Deferred<unknown>>();
  private readonly offers = new AsyncBlockingQueue<ExecutionJobOffer>();
  private readonly inFlight: Semaphore;
  private closed = false;

  constructor(
    private readonly stream: ClientDuplex,
    readonly welcome: RunnerWelcome,
    private readonly generateId: () => string,
  ) {
    this.inFlight = new Semaphore(welcome.maximumInFlightBatches);
  }

  dispatch(frame: ServerFrameWire): void {
    if (frame.offer !== undefined) {
      this.offers.push(offerFromWire(frame.offer));
      return;
    }
    if (frame.lease !== undefined) {
      this.resolvePending(frame.correlation_id, leaseFromWire(frame.lease));
      return;
    }
    if (frame.event_ack !== undefined) {
      this.resolvePending(frame.correlation_id, eventAckFromWire(frame.event_ack));
      return;
    }
    if (frame.trace_gap !== undefined) {
      const gap = traceGapFromWire(frame.trace_gap);
      this.rejectPending(
        frame.correlation_id,
        new RunnerProtocolError("TraceGap", "trace gap detected", { details: { ...gap } }),
      );
      return;
    }
    if (frame.trace_integrity_violation !== undefined) {
      const violation = traceIntegrityViolationFromWire(frame.trace_integrity_violation);
      this.rejectPending(
        frame.correlation_id,
        new RunnerProtocolError("TraceIntegrityViolation", "trace integrity violation", {
          details: { ...violation },
        }),
      );
      return;
    }
    if (frame.capability_mismatch !== undefined) {
      this.rejectPending(
        frame.correlation_id,
        new RunnerProtocolError("CapabilityMismatch", "capability mismatch", {
          details: { missingCapabilities: capabilityMismatchFromWire(frame.capability_mismatch) },
        }),
      );
    }
  }

  nextOffer(signal: AbortSignal): Promise<ExecutionJobOffer> {
    return this.offers.take(signal);
  }

  accept(offerId: string): Promise<ExecutionJobLease> {
    return this.request<ExecutionJobLease>(offerId, {
      correlation_id: offerId,
      accept_offer: acceptOfferToWire(offerId),
    });
  }

  renew(lease: ExecutionJobLease): Promise<ExecutionJobLease> {
    const correlationId = this.generateId();
    return this.request<ExecutionJobLease>(correlationId, {
      correlation_id: correlationId,
      renew_lease: renewLeaseToWire(lease),
    });
  }

  async submit(batch: ExecutionEventBatch): Promise<ExecutionEventAck> {
    const release = await this.inFlight.acquire();
    try {
      return await this.request<ExecutionEventAck>(batch.batchId, {
        correlation_id: batch.batchId,
        event_batch: eventBatchToWire(batch),
      });
    } finally {
      release();
    }
  }

  complete(lease: ExecutionJobLease, result: ExecutionCompletion): Promise<void> {
    if (this.closed) {
      return Promise.reject(new RunnerProtocolError("SessionClosed", "session is closed"));
    }
    this.stream.write({
      correlation_id: lease.runId,
      complete_execution: completionToWire(result),
    });
    return Promise.resolve();
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.fail(new RunnerProtocolError("SessionClosed", "session closed by client"));
    this.stream.end();
    return Promise.resolve();
  }

  fail(reason: unknown): void {
    if (this.closed) return;
    this.closed = true;
    for (const deferred of this.pending.values()) {
      deferred.reject(reason);
    }
    this.pending.clear();
    this.offers.fail(reason);
  }

  private request<T>(correlationId: string, frame: RunnerFrameWire): Promise<T> {
    if (this.closed) {
      return Promise.reject(new RunnerProtocolError("SessionClosed", "session is closed"));
    }
    const existing = this.pending.get(correlationId);
    if (existing !== undefined) {
      return existing.promise as Promise<T>;
    }
    const deferred = createDeferred<unknown>();
    this.pending.set(correlationId, deferred);
    this.stream.write(frame);
    return deferred.promise as Promise<T>;
  }

  private resolvePending(correlationId: string, value: unknown): void {
    const deferred = this.pending.get(correlationId);
    if (deferred) {
      this.pending.delete(correlationId);
      deferred.resolve(value);
    }
  }

  private rejectPending(correlationId: string, reason: unknown): void {
    const deferred = this.pending.get(correlationId);
    if (deferred) {
      this.pending.delete(correlationId);
      deferred.reject(reason);
    }
  }
}

function mapTransportError(error: unknown): RunnerProtocolError {
  if (error instanceof RunnerProtocolError) {
    return error;
  }
  const record = (error ?? {}) as { code?: unknown; details?: unknown; message?: unknown };
  const details = typeof record.details === "string" ? record.details : undefined;
  if (details !== undefined && APPLICATION_ERROR_CODES.has(details)) {
    return new RunnerProtocolError(details as RunnerProtocolErrorCode, details, { cause: error });
  }
  const message = typeof record.message === "string" ? record.message : (details ?? "transport error");
  const haystack = `${message} ${details ?? ""}`;
  if (
    record.code === grpc.status.UNAVAILABLE ||
    /certificate|ssl|handshake|peer|tls/i.test(haystack)
  ) {
    return new RunnerProtocolError("TlsPeerRejected", message, { cause: error });
  }
  return new RunnerProtocolError("TransportError", message, { cause: error });
}

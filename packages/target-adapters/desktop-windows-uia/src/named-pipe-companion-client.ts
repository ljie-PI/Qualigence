import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import type { Duplex } from "node:stream";
import {
  buildCompanionProofBytes,
  COMPANION_IPC_LIMITS,
  PROTOCOL_MAJOR,
  assertDeclaredFrameLength,
  createCompanionRequestEnvelope,
  expectedResponseTypeForRequest,
  parseCompanionResponse,
  type AppSession,
  type AppTarget,
  type CompanionProofSignatureAlgorithm,
  type CompanionRequestPayloadByType,
  type CompanionRequestType,
  type CompanionResponse,
  type CompanionResponsePayloadByType,
  type CompanionResponseType,
  type CompanionStableError,
  type ExpectedCompanionResponseType,
  type LocalActionOutcomeReport,
  type LocalApprovalDecision,
  type LocalPermitRequest,
} from "@qualigence/desktop-contracts";
import type { UiaSource } from "./uia-source.js";
import {
  DesktopExecutionError,
  type ActionOutcomeReport,
  type CompanionClient,
  type DesktopActionExecuteRequest,
  type UiaCaptureRequest,
} from "./companion-client.js";

type CompanionSocket = Duplex & {
  readonly destroyed?: boolean;
  destroy(error?: Error): void;
  end(callback?: () => void): Duplex;
  setNoDelay?(noDelay?: boolean): Duplex;
};

export type NamedPipeCompanionClientErrorCode =
  | "CompanionUnavailable"
  | "CompanionIdentityRejected"
  | "CompanionUnauthenticated"
  | "CompanionProtocolViolation"
  | "CompanionBackpressure"
  | "CompanionRequestTimeout"
  | "CompanionCorrelationError"
  | "CompanionMessageTooLarge";

export class NamedPipeCompanionClientError extends Error {
  readonly code: NamedPipeCompanionClientErrorCode;
  readonly outcomeUnknown: boolean;

  constructor(code: NamedPipeCompanionClientErrorCode, message: string, options: { readonly outcomeUnknown?: boolean } = {}) {
    super(`${code}: ${message}`);
    this.name = "NamedPipeCompanionClientError";
    this.code = code;
    this.outcomeUnknown = options.outcomeUnknown === true;
  }
}

export class CompanionResponseError extends Error {
  readonly responseError: CompanionStableError;
  readonly outcomeUnknown: boolean;

  constructor(error: CompanionStableError, options: { readonly outcomeUnknown?: boolean } = {}) {
    super(`${error.code}: ${error.safeMessage}`);
    this.name = "CompanionResponseError";
    this.responseError = error;
    this.outcomeUnknown = options.outcomeUnknown === true;
  }
}

export interface CompanionProofSignature {
  readonly signatureBase64: string;
  readonly signatureAlgorithm: CompanionProofSignatureAlgorithm;
}

/** Injected bridge to the existing Runner mTLS certificate/key profile. */
export interface RunnerCertificateProofSigner {
  readonly runnerId: string;
  readonly certificatePem: string;
  readonly certificateSha256Fingerprint?: string;
  signCompanionProof(bytes: Uint8Array): Promise<CompanionProofSignature>;
}

export interface NamedPipeCompanionClientOptions {
  readonly pipePath: string;
  readonly signer: RunnerCertificateProofSigner;
  readonly expectedCompanionInstanceId?: string;
  readonly connectTimeoutMs?: number;
  readonly handshakeDeadlineMs?: number;
  readonly defaultRequestDeadlineMs?: number;
  readonly maxFrameBytes?: number;
  readonly maxBufferedBytes?: number;
  readonly maxInFlightRequests?: number;
  readonly requestIdFactory?: () => string;
  readonly socketFactory?: (pipePath: string) => CompanionSocket | Promise<CompanionSocket>;
}

interface PendingRequest {
  readonly requestId: string;
  readonly expectedResponseType: CompanionResponseType;
  readonly sideEffecting: boolean;
  readonly failStopOnFailure: boolean;
  dispatched: boolean;
  readonly deadlineTimer: ReturnType<typeof setTimeout>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
}

function isProofAlgorithm(value: string): value is CompanionProofSignatureAlgorithm {
  return value === "ecdsa-p256-sha256" || value === "rsa-pss-sha256";
}

function isCompanionProofSignature(value: unknown): value is CompanionProofSignature {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { readonly signatureBase64?: unknown }).signatureBase64 === "string" &&
    typeof (value as { readonly signatureAlgorithm?: unknown }).signatureAlgorithm === "string"
  );
}

export function assertLocalNamedPipePath(pipePath: string): void {
  const normalized = pipePath.replaceAll("/", "\\");
  if (!/^\\\\[.?]\\pipe\\[^\\]+/.test(normalized)) {
    throw new NamedPipeCompanionClientError(
      "CompanionUnavailable",
      "Companion endpoint must be a configured local Windows Named Pipe path",
    );
  }
}

function frameForJson(value: unknown, maxFrameBytes: number): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  assertDeclaredFrameLength(body.byteLength);
  if (body.byteLength > maxFrameBytes) {
    throw new NamedPipeCompanionClientError("CompanionMessageTooLarge", "outbound Companion frame exceeds configured bound");
  }
  const frame = Buffer.allocUnsafe(4 + body.byteLength);
  frame.writeUInt32BE(body.byteLength, 0);
  body.copy(frame, 4);
  return frame;
}

function localSocketFactory(pipePath: string): CompanionSocket {
  return createConnection(pipePath) as CompanionSocket;
}

function mapStableErrorCode(code: CompanionStableError["code"]): NamedPipeCompanionClientErrorCode | undefined {
  switch (code) {
    case "CompanionUnavailable":
    case "CompanionIdentityRejected":
    case "CompanionUnauthenticated":
    case "CompanionBackpressure":
    case "CompanionRequestTimeout":
    case "CompanionMessageTooLarge":
      return code;
    case "CompanionProtocolViolation":
      return "CompanionProtocolViolation";
    case "CompanionCorrelationError":
      return "CompanionCorrelationError";
    default:
      return undefined;
  }
}

function isSideEffectingRequest(type: CompanionRequestType): boolean {
  return type === "app.launch" || type === "app.reset" || type === "app.shutdown" || type === "permit.request" || type === "action.execute";
}

function isHandshakeRequest(type: CompanionRequestType): boolean {
  return type === "handshake.begin" || type === "handshake.prove";
}

export class NamedPipeCompanionClient implements CompanionClient {
  private readonly pipePath: string;
  private readonly signer: RunnerCertificateProofSigner;
  private readonly expectedCompanionInstanceId: string | undefined;
  private readonly connectTimeoutMs: number;
  private readonly handshakeDeadlineMs: number;
  private readonly defaultRequestDeadlineMs: number;
  private readonly maxFrameBytes: number;
  private readonly maxBufferedBytes: number;
  private readonly maxInFlightRequests: number;
  private readonly requestIdFactory: () => string;
  private readonly socketFactory: (pipePath: string) => CompanionSocket | Promise<CompanionSocket>;

  private socket: CompanionSocket | undefined;
  private buffered = Buffer.alloc(0);
  private readonly pending = new Map<string, PendingRequest>();
  private connectionPromise: Promise<void> | undefined;
  private authenticationPromise: Promise<void> | undefined;
  private readonly closeWaiters = new Set<(error: NamedPipeCompanionClientError) => void>();
  private closeReason: NamedPipeCompanionClientError | undefined;
  private authenticated = false;
  private closed = false;

  constructor(options: NamedPipeCompanionClientOptions) {
    assertLocalNamedPipePath(options.pipePath);
    this.pipePath = options.pipePath;
    this.signer = options.signer;
    this.expectedCompanionInstanceId = options.expectedCompanionInstanceId;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 5000;
    this.handshakeDeadlineMs = options.handshakeDeadlineMs ?? 5000;
    this.defaultRequestDeadlineMs = options.defaultRequestDeadlineMs ?? 30_000;
    this.maxFrameBytes = options.maxFrameBytes ?? COMPANION_IPC_LIMITS.maxFrameBytes;
    this.maxBufferedBytes = options.maxBufferedBytes ?? COMPANION_IPC_LIMITS.maxBufferedBytes;
    this.maxInFlightRequests = options.maxInFlightRequests ?? COMPANION_IPC_LIMITS.maxInFlightRequests;
    this.requestIdFactory = options.requestIdFactory ?? randomUUID;
    this.socketFactory = options.socketFactory ?? localSocketFactory;
  }

  async authenticate(): Promise<void> {
    this.throwIfClosed();
    if (this.authenticated) {
      return;
    }
    this.authenticationPromise ??= this.authenticateOnce().finally(() => {
      this.authenticationPromise = undefined;
    });
    await this.authenticationPromise;
    this.throwIfClosed();
  }

  close(): void {
    if (this.closed) {
      return;
    }
    const error = new NamedPipeCompanionClientError("CompanionUnavailable", "Companion client closed");
    this.closed = true;
    this.closeReason = error;
    this.rejectCloseWaiters(error);
    this.failStop(error);
  }

  async probe(): Promise<void> {
    await this.authenticate();
  }

  async launch(target: AppTarget): Promise<AppSession> {
    await this.authenticate();
    return this.request("app.launch", { target }, this.defaultRequestDeadlineMs);
  }

  async reset(sessionId: string): Promise<void> {
    await this.authenticate();
    await this.request("app.reset", { sessionId }, this.defaultRequestDeadlineMs);
  }

  async shutdown(sessionId: string): Promise<void> {
    await this.authenticate();
    await this.request("app.shutdown", { sessionId }, this.defaultRequestDeadlineMs);
  }

  async capture(request: UiaCaptureRequest): Promise<UiaSource> {
    await this.authenticate();
    return this.request("uia.capture", request, request.deadlineMs) as Promise<UiaSource>;
  }

  async requestPermit(request: LocalPermitRequest): Promise<LocalApprovalDecision> {
    await this.authenticate();
    return this.request("permit.request", { request }, this.defaultRequestDeadlineMs);
  }

  async execute(request: DesktopActionExecuteRequest): Promise<ActionOutcomeReport> {
    await this.authenticate();
    try {
      return await this.request("action.execute", request, request.deadlineMs) as LocalActionOutcomeReport;
    } catch (error) {
      if (error instanceof CompanionResponseError && error.responseError.code === "ActionOutcomeUnknown") {
        throw new DesktopExecutionError("ActionOutcomeUnknown", error.responseError.safeMessage);
      }
      if (error instanceof NamedPipeCompanionClientError && error.outcomeUnknown) {
        throw new DesktopExecutionError("ActionOutcomeUnknown", error.message);
      }
      throw error;
    }
  }

  private closedError(): NamedPipeCompanionClientError {
    return this.closeReason ?? new NamedPipeCompanionClientError("CompanionUnavailable", "Companion client is closed");
  }

  private throwIfClosed(): void {
    if (this.closed) {
      throw this.closedError();
    }
  }

  private raceClosed<T>(promise: Promise<T>): Promise<T> {
    this.throwIfClosed();
    return new Promise<T>((resolve, reject) => {
      const onClose = (error: NamedPipeCompanionClientError): void => {
        reject(error);
      };
      this.closeWaiters.add(onClose);
      promise.then(resolve, reject).finally(() => {
        this.closeWaiters.delete(onClose);
      });
    });
  }

  private rejectCloseWaiters(error: NamedPipeCompanionClientError): void {
    for (const waiter of this.closeWaiters) {
      waiter(error);
    }
    this.closeWaiters.clear();
  }

  private assertCurrentSocket(socket: CompanionSocket | undefined): void {
    this.throwIfClosed();
    if (socket === undefined || this.socket !== socket || socket.destroyed) {
      throw new NamedPipeCompanionClientError("CompanionUnavailable", "Companion authentication connection was closed");
    }
  }

  private async authenticateOnce(): Promise<void> {
    await this.ensureConnected();
    const handshakeSocket = this.socket;
    this.assertCurrentSocket(handshakeSocket);
    const challenge = await this.requestWithoutAuthentication("handshake.begin", {
      runnerId: this.signer.runnerId,
      certificatePem: this.signer.certificatePem,
    }, this.handshakeDeadlineMs);
    this.assertCurrentSocket(handshakeSocket);

    if (this.expectedCompanionInstanceId !== undefined && challenge.companionInstanceId !== this.expectedCompanionInstanceId) {
      this.failStop(new NamedPipeCompanionClientError("CompanionIdentityRejected", "Companion instance mismatch"));
      throw new NamedPipeCompanionClientError("CompanionIdentityRejected", "Companion instance mismatch");
    }

    const proofBytes = buildCompanionProofBytes({
      protocolMajor: PROTOCOL_MAJOR,
      companionInstanceId: challenge.companionInstanceId,
      nonceBase64: challenge.nonceBase64,
      runnerId: this.signer.runnerId,
    });
    const signature = await this.signCompanionProofBeforeDeadline(proofBytes);
    this.assertCurrentSocket(handshakeSocket);
    if (!isCompanionProofSignature(signature) || signature.signatureBase64.length === 0 || !isProofAlgorithm(signature.signatureAlgorithm)) {
      this.failStop(new NamedPipeCompanionClientError("CompanionIdentityRejected", "Runner certificate signer returned an invalid proof"));
      throw new NamedPipeCompanionClientError("CompanionIdentityRejected", "Runner certificate signer returned an invalid proof");
    }

    const accepted = await this.requestWithoutAuthentication("handshake.prove", {
      challengeId: challenge.challengeId,
      companionInstanceId: challenge.companionInstanceId,
      nonceBase64: challenge.nonceBase64,
      signatureBase64: signature.signatureBase64,
      signatureAlgorithm: signature.signatureAlgorithm,
    }, this.handshakeDeadlineMs);
    this.assertCurrentSocket(handshakeSocket);

    if (accepted.runnerId !== this.signer.runnerId || accepted.companionInstanceId !== challenge.companionInstanceId) {
      this.failStop(new NamedPipeCompanionClientError("CompanionIdentityRejected", "Companion accepted identity does not match the proof"));
      throw new NamedPipeCompanionClientError("CompanionIdentityRejected", "Companion accepted identity does not match the proof");
    }
    if (
      this.signer.certificateSha256Fingerprint !== undefined &&
      accepted.certificateSha256Fingerprint !== undefined &&
      accepted.certificateSha256Fingerprint.toLowerCase() !== this.signer.certificateSha256Fingerprint.toLowerCase()
    ) {
      this.failStop(new NamedPipeCompanionClientError("CompanionIdentityRejected", "Companion accepted a different Runner certificate"));
      throw new NamedPipeCompanionClientError("CompanionIdentityRejected", "Companion accepted a different Runner certificate");
    }

    this.authenticated = true;
  }

  private async signCompanionProofBeforeDeadline(proofBytes: Uint8Array): Promise<CompanionProofSignature> {
    this.throwIfClosed();
    try {
      return await new Promise<CompanionProofSignature>((resolve, reject) => {
        let settled = false;
        const cleanup = (): void => {
          settled = true;
          clearTimeout(timer);
          this.closeWaiters.delete(onClose);
        };
        const rejectOnce = (error: unknown): void => {
          if (settled) {
            return;
          }
          cleanup();
          reject(error);
        };
        const resolveOnce = (signature: CompanionProofSignature): void => {
          if (settled) {
            return;
          }
          cleanup();
          resolve(signature);
        };
        const onClose = (error: NamedPipeCompanionClientError): void => {
          rejectOnce(error);
        };
        const timer = setTimeout(() => {
          rejectOnce(new NamedPipeCompanionClientError("CompanionRequestTimeout", "Companion proof signing deadline expired"));
        }, this.handshakeDeadlineMs);

        this.closeWaiters.add(onClose);
        Promise.resolve()
          .then(() => this.signer.signCompanionProof(proofBytes))
          .then(resolveOnce, rejectOnce);
      });
    } catch (error) {
      const stableError = this.toStableProofSigningError(error);
      this.failStop(stableError);
      throw stableError;
    }
  }

  private toStableProofSigningError(error: unknown): NamedPipeCompanionClientError {
    if (error instanceof NamedPipeCompanionClientError) {
      if (error.code === "CompanionUnavailable" || error.code === "CompanionRequestTimeout") {
        return error;
      }
    }
    return new NamedPipeCompanionClientError(
      "CompanionIdentityRejected",
      "Runner certificate signer failed to produce a Companion proof",
    );
  }

  private async ensureConnected(): Promise<void> {
    this.throwIfClosed();
    if (this.socket !== undefined && !this.socket.destroyed) {
      this.throwIfClosed();
      return;
    }
    this.connectionPromise ??= this.connectOnce().finally(() => {
      this.connectionPromise = undefined;
    });
    await this.connectionPromise;
    this.throwIfClosed();
  }

  private async connectOnce(): Promise<void> {
    this.throwIfClosed();
    const socketPromise = Promise.resolve(this.socketFactory(this.pipePath));
    socketPromise.then((socket) => {
      if (this.closed && !socket.destroyed) {
        socket.destroy();
      }
    }).catch(() => undefined);

    const socket = await this.raceClosed(socketPromise);
    if (this.closed) {
      if (!socket.destroyed) {
        socket.destroy();
      }
      throw this.closedError();
    }
    this.socket = socket;
    this.authenticated = false;
    this.buffered = Buffer.alloc(0);
    socket.setNoDelay?.(true);
    socket.on("data", (chunk: Buffer) => {
      if (this.socket === socket) {
        this.onData(chunk);
      }
    });
    socket.on("error", () => {
      if (this.socket === socket) {
        this.failStop(new NamedPipeCompanionClientError("CompanionUnavailable", "Companion pipe error"));
      }
    });
    socket.on("close", () => {
      if (this.socket === socket) {
        this.failStop(new NamedPipeCompanionClientError("CompanionUnavailable", "Companion pipe closed"));
      }
    });

    if ((socket as { readonly connecting?: boolean }).connecting !== true) {
      this.throwIfClosed();
      return;
    }
    await this.raceClosed(new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        socket.destroy();
        reject(new NamedPipeCompanionClientError("CompanionUnavailable", "Companion pipe connect timed out"));
      }, this.connectTimeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        socket.off("connect", onConnect);
        socket.off("error", onError);
        socket.off("close", onClose);
      };
      const onConnect = (): void => {
        cleanup();
        resolve();
      };
      const onError = (): void => {
        cleanup();
        reject(new NamedPipeCompanionClientError("CompanionUnavailable", "Companion pipe connect failed"));
      };
      const onClose = (): void => {
        cleanup();
        reject(new NamedPipeCompanionClientError("CompanionUnavailable", "Companion pipe closed before connect"));
      };
      socket.once("connect", onConnect);
      socket.once("error", onError);
      socket.once("close", onClose);
    }));
    this.throwIfClosed();
  }

  private requestWithoutAuthentication<T extends CompanionRequestType>(
    type: T,
    payload: CompanionRequestPayloadByType[T],
    deadlineMs: number,
  ): Promise<CompanionResponsePayloadByType[ExpectedCompanionResponseType<T>]> {
    return this.send(type, payload, deadlineMs);
  }

  private async request<T extends Exclude<CompanionRequestType, "handshake.begin" | "handshake.prove">>(
    type: T,
    payload: CompanionRequestPayloadByType[T],
    deadlineMs: number,
  ): Promise<CompanionResponsePayloadByType[ExpectedCompanionResponseType<T>]> {
    this.throwIfClosed();
    if (!this.authenticated) {
      throw new NamedPipeCompanionClientError("CompanionUnauthenticated", "Companion request attempted before authentication");
    }
    return this.send(type, payload, deadlineMs);
  }

  private async send<T extends CompanionRequestType>(
    type: T,
    payload: CompanionRequestPayloadByType[T],
    deadlineMs: number,
  ): Promise<CompanionResponsePayloadByType[ExpectedCompanionResponseType<T>]> {
    await this.ensureConnected();
    this.throwIfClosed();
    if (deadlineMs < COMPANION_IPC_LIMITS.minDeadlineMs || deadlineMs > COMPANION_IPC_LIMITS.maxDeadlineMs) {
      throw new NamedPipeCompanionClientError("CompanionRequestTimeout", "Companion request deadline is outside the allowed bound");
    }
    if (this.pending.size >= this.maxInFlightRequests) {
      throw new NamedPipeCompanionClientError("CompanionBackpressure", "Companion in-flight request bound exceeded");
    }

    const requestId = this.nextRequestId();
    const expectedResponseType = expectedResponseTypeForRequest(type);
    const envelope = createCompanionRequestEnvelope(requestId, type, payload);
    const frame = frameForJson(envelope, this.maxFrameBytes);
    const socket = this.socket;
    if (socket === undefined || socket.destroyed) {
      throw new NamedPipeCompanionClientError("CompanionUnavailable", "Companion pipe is not connected");
    }
    this.throwIfClosed();

    return await new Promise<CompanionResponsePayloadByType[ExpectedCompanionResponseType<T>]>((resolve, reject) => {
      const entry: PendingRequest = {
        requestId,
        expectedResponseType,
        sideEffecting: isSideEffectingRequest(type),
        failStopOnFailure: isHandshakeRequest(type),
        dispatched: false,
        deadlineTimer: setTimeout(() => {
          this.pending.delete(requestId);
          const error = new NamedPipeCompanionClientError(
            "CompanionRequestTimeout",
            "Companion request deadline expired",
            { outcomeUnknown: entry.dispatched && entry.sideEffecting },
          );
          reject(error);
          if (entry.failStopOnFailure || this.hasPartialInboundFrame()) {
            this.failStop(error);
          }
        }, deadlineMs),
        resolve: (value: unknown) => resolve(value as CompanionResponsePayloadByType[ExpectedCompanionResponseType<T>]),
        reject,
      };
      this.pending.set(requestId, entry);
      try {
        this.throwIfClosed();
        entry.dispatched = true;
        socket.write(frame);
      } catch (error) {
        this.pending.delete(requestId);
        clearTimeout(entry.deadlineTimer);
        reject(error instanceof Error ? error : new NamedPipeCompanionClientError("CompanionUnavailable", "Companion frame write failed"));
      }
    });
  }

  private nextRequestId(): string {
    const requestId = this.requestIdFactory();
    if (requestId.length === 0 || requestId.length > COMPANION_IPC_LIMITS.maxRequestIdLength || this.pending.has(requestId)) {
      throw new NamedPipeCompanionClientError("CompanionCorrelationError", "invalid or duplicate Companion requestId");
    }
    return requestId;
  }

  private hasPartialInboundFrame(): boolean {
    return this.buffered.byteLength > 0;
  }

  private onData(chunk: Buffer): void {
    try {
      this.buffered = Buffer.concat([this.buffered, chunk]);
      if (this.buffered.byteLength > this.maxBufferedBytes + 4) {
        throw new NamedPipeCompanionClientError("CompanionMessageTooLarge", "Companion buffered data exceeded configured bound");
      }
      while (this.buffered.byteLength >= 4) {
        const declaredLength = this.buffered.readUInt32BE(0);
        assertDeclaredFrameLength(declaredLength);
        if (declaredLength > this.maxFrameBytes) {
          throw new NamedPipeCompanionClientError("CompanionMessageTooLarge", "Companion frame exceeded configured bound");
        }
        if (this.buffered.byteLength < declaredLength + 4) {
          return;
        }
        const body = this.buffered.subarray(4, 4 + declaredLength);
        this.buffered = this.buffered.subarray(4 + declaredLength);
        this.acceptResponseFrame(body);
      }
    } catch (error) {
      this.failStop(error instanceof Error ? error : new NamedPipeCompanionClientError("CompanionProtocolViolation", "Companion frame parse failed"));
    }
  }

  private acceptResponseFrame(body: Buffer): void {
    let decoded: unknown;
    try {
      decoded = JSON.parse(body.toString("utf8"));
    } catch {
      throw new NamedPipeCompanionClientError("CompanionProtocolViolation", "Companion frame body is not valid JSON");
    }
    const response = parseCompanionResponse(decoded);
    this.deliverResponse(response);
  }

  private deliverResponse(response: CompanionResponse): void {
    const entry = this.pending.get(response.requestId);
    if (entry === undefined) {
      throw new NamedPipeCompanionClientError("CompanionCorrelationError", "Companion response used an unknown or completed requestId");
    }
    if (response.type !== entry.expectedResponseType) {
      throw new NamedPipeCompanionClientError("CompanionCorrelationError", "Companion response type did not match the request");
    }
    this.pending.delete(response.requestId);
    clearTimeout(entry.deadlineTimer);
    if (response.status === "error") {
      const mapped = mapStableErrorCode(response.error.code);
      const outcomeUnknown = entry.dispatched && entry.sideEffecting;
      if (mapped === "CompanionProtocolViolation" || mapped === "CompanionCorrelationError") {
        const protocolError = new NamedPipeCompanionClientError(mapped, response.error.safeMessage, { outcomeUnknown });
        entry.reject(protocolError);
        this.failStop(protocolError);
        return;
      }
      const responseError = new CompanionResponseError(response.error, { outcomeUnknown });
      entry.reject(responseError);
      if (entry.failStopOnFailure) {
        this.failStop(responseError);
      }
      return;
    }
    entry.resolve(response.payload);
  }

  private failStop(error: Error): void {
    const socket = this.socket;
    this.socket = undefined;
    this.authenticated = false;
    this.buffered = Buffer.alloc(0);
    if (socket !== undefined && !socket.destroyed) {
      socket.destroy();
    }
    for (const entry of this.pending.values()) {
      clearTimeout(entry.deadlineTimer);
      const outcomeUnknown = entry.dispatched && entry.sideEffecting;
      if (error instanceof NamedPipeCompanionClientError && outcomeUnknown && !error.outcomeUnknown) {
        entry.reject(new NamedPipeCompanionClientError(error.code, error.message.replace(`${error.code}: `, ""), { outcomeUnknown }));
      } else {
        entry.reject(error);
      }
    }
    this.pending.clear();
  }
}

import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash, createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  NamedPipeCompanionClient,
  type CompanionProofSignature,
  type RunnerCertificateProofSigner,
} from "@qualigence/desktop-windows-uia";
import {
  DESKTOP_UIA_V1_CAPABILITY_TOKENS,
  advertisedCapabilityTokens,
  negotiateCapabilities,
  canonicalTraceEventHash,
  type AcceptedExecutionJob,
  type TraceEvent,
} from "@qualigence/runner-protocol";
import {
  DeterministicRunnerPolicyGate,
  ExecutionRuntime,
  type ActionResolver,
  type TraceEventInput,
} from "@qualigence/runner-kernel";
import type { AppTarget } from "@qualigence/desktop-contracts";
import type { RunnerConfig } from "../../../apps/runner/src/config.js";
import { runnerCapabilities } from "../../../apps/runner/src/offer-runtime.js";
import { TargetRuntimeFactory } from "../../../apps/runner/src/target-runtime-factory.js";

const FIXTURE_SOURCE = String.raw`
import { createServer } from "node:net";
import { Buffer } from "node:buffer";
import { createHash, createVerify } from "node:crypto";

const pipePath = process.env.TICKET28_PIPE_PATH;
const scenario = process.env.TICKET28_SCENARIO;
if (!pipePath || !scenario) {
  throw new Error("TICKET28_FIXTURE_CONFIG_MISSING");
}

const PROTOCOL_MAJOR = 1;
const companionInstanceId = "ticket28-e2e-companion";
const challengeId = "ticket28-e2e-challenge";
const nonceBase64 = Buffer.from("ticket28-e2e-nonce", "utf8").toString("base64");
const secretPlaintext = "alice.ticket28@example.test";
const sockets = new Set();
const socketBuffers = new WeakMap();
let authenticated = false;
let runnerId;
let certificatePem;
let certificateFingerprint;
let consumedPermit = false;
let permitSequence = 0;

function sendMessage(message) {
  if (process.send) process.send(message);
}

function event(payload) {
  sendMessage({ kind: "event", ...payload });
}

function ok(requestId, type, payload) {
  return { protocolMajor: PROTOCOL_MAJOR, requestId, type, status: "ok", payload };
}

function errorResponse(requestId, type, code, safeMessage) {
  return { protocolMajor: PROTOCOL_MAJOR, requestId, type, status: "error", error: { code, safeMessage } };
}

function writeFrame(socket, value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const frame = Buffer.alloc(4 + body.byteLength);
  frame.writeUInt32BE(body.byteLength, 0);
  body.copy(frame, 4);
  socket.write(frame);
}

function proofBytes() {
  return Buffer.from(
    "qualigence-companion-proof/v1\n" +
      PROTOCOL_MAJOR + "\n" +
      companionInstanceId + "\n" +
      nonceBase64 + "\n" +
      runnerId + "\n",
    "utf8",
  );
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function utf8ByteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function valueBindingForPlaintext(valueRef, plaintext) {
  return {
    valueRef,
    valueSha256: sha256Hex(Buffer.from(plaintext, "utf8")),
    valueByteLength: utf8ByteLength(plaintext),
  };
}

function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  return "{" + Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => JSON.stringify(key) + ":" + canonicalize(value[key]))
    .join(",") + "}";
}

function desktopActionDigestSha256(input) {
  return sha256Hex(Buffer.from(canonicalize({
    schema: "qualigence-desktop-action-digest/v1",
    sessionId: input.sessionId,
    runId: input.runId,
    action: input.action,
    decisionId: input.decisionId,
    policyId: input.policyId,
    risk: input.risk,
    expiresAt: input.expiresAt,
    nonceBase64: input.nonceBase64,
    valueBinding: input.valueBinding,
  }), "utf8"));
}

function handleHandshake(socket, request) {
  if (request.type === "handshake.begin") {
    runnerId = request.payload.runnerId;
    certificatePem = request.payload.certificatePem;
    certificateFingerprint = sha256Hex(Buffer.from(certificatePem, "utf8"));
    writeFrame(socket, ok(request.requestId, "handshake.challenge", { challengeId, companionInstanceId, nonceBase64 }));
    return true;
  }

  if (request.type === "handshake.prove") {
    const expectedBytes = proofBytes();
    const verifier = createVerify("SHA256");
    verifier.update(expectedBytes);
    verifier.end();
    const verified = verifier.verify(certificatePem, Buffer.from(request.payload.signatureBase64, "base64"));
    event({ event: "proof", verified, proofPayload: expectedBytes.toString("utf8") });
    if (
      request.payload.challengeId !== challengeId ||
      request.payload.companionInstanceId !== companionInstanceId ||
      request.payload.nonceBase64 !== nonceBase64 ||
      request.payload.signatureAlgorithm !== "ecdsa-p256-sha256" ||
      !verified
    ) {
      writeFrame(socket, errorResponse(request.requestId, "handshake.accepted", "CompanionIdentityRejected", "proof rejected"));
      socket.destroy();
      return true;
    }
    authenticated = true;
    writeFrame(socket, ok(request.requestId, "handshake.accepted", {
      companionInstanceId,
      runnerId,
      certificateSha256Fingerprint: certificateFingerprint,
      acceptedAt: "2026-08-26T00:00:00.000Z",
    }));
    return true;
  }
  return false;
}

function handleFrame(socket, body) {
  const request = body;
  event({ event: "request", type: request.type, requestId: request.requestId, payload: request.payload });
  if (handleHandshake(socket, request)) return;

  if (!authenticated) {
    writeFrame(socket, errorResponse(request.requestId, "handshake.accepted", "CompanionUnauthenticated", "authenticate first"));
    socket.destroy();
    return;
  }

  switch (request.type) {
    case "companion.probe":
      if (
        request.payload.targetAdapter !== "desktop-windows-uia" ||
        request.payload.observationExtension !== "uia/v1"
      ) {
        writeFrame(socket, errorResponse(request.requestId, "companion.probe", "CapabilityMismatch", "probe contract mismatch"));
        return;
      }
      writeFrame(socket, ok(request.requestId, "companion.probe", {
        ready: true,
        protocolMajor: PROTOCOL_MAJOR,
        targetAdapter: "desktop-windows-uia",
        observationExtension: "uia/v1",
        checkedAt: "2026-08-26T00:00:01.000Z",
      }));
      return;
    case "app.launch":
      writeFrame(socket, ok(request.requestId, "app.launch", appSession));
      return;
    case "uia.capture":
      writeFrame(socket, ok(request.requestId, "uia.capture", capturePayload(request.payload.sessionId)));
      return;
    case "permit.request": {
      const permitRequest = request.payload.request;
      const authorization = permitRequest.authorization;
      const valueBinding = authorization.valueBinding;
      const containsPlaintext = JSON.stringify(permitRequest).includes(secretPlaintext);
      let expectedDigest;
      try {
        expectedDigest = desktopActionDigestSha256({
          sessionId: permitRequest.sessionId,
          runId: permitRequest.runId,
          action: permitRequest.action,
          decisionId: authorization.decisionId,
          policyId: authorization.policyId,
          risk: authorization.risk,
          expiresAt: authorization.expiresAt,
          nonceBase64: authorization.nonceBase64,
          valueBinding,
        });
      } catch (error) {
        writeFrame(socket, errorResponse(request.requestId, "permit.request", "LocalPermitInvalid", "digest construction failed"));
        return;
      }
      if (
        containsPlaintext ||
        authorization.actionDigestSha256 !== expectedDigest ||
        permitRequest.action.valueRef !== valueBinding?.valueRef ||
        valueBinding.valueSha256 !== valueBindingForPlaintext(permitRequest.action.valueRef, secretPlaintext).valueSha256 ||
        valueBinding.valueByteLength !== utf8ByteLength(secretPlaintext)
      ) {
        writeFrame(socket, errorResponse(request.requestId, "permit.request", "LocalPermitInvalid", "authorization binding mismatch"));
        return;
      }
      permitSequence += 1;
      consumedPermit = false;
      const permit = {
        permitToken: "ticket28-permit-" + permitSequence,
        nonceBase64: authorization.nonceBase64,
        sessionId: permitRequest.sessionId,
        runId: permitRequest.runId,
        actionId: permitRequest.action.actionId,
        actionDigestSha256: authorization.actionDigestSha256,
        graphId: permitRequest.action.graphId,
        decisionId: authorization.decisionId,
        policyId: authorization.policyId,
        risk: authorization.risk,
        issuedAt: "2026-08-26T00:00:02.000Z",
        expiresAt: authorization.expiresAt,
        valueBinding,
      };
      event({ event: "permit-approved", containsPlaintext, valueBinding, actionDigestSha256: permit.actionDigestSha256 });
      writeFrame(socket, ok(request.requestId, "permit.request", {
        status: "approved",
        approvalId: permitRequest.approvalId,
        decidedAt: "2026-08-26T00:00:02.000Z",
        permit,
      }));
      return;
    }
    case "action.execute": {
      const payload = request.payload;
      const value = payload.value;
      const expectedBinding = valueBindingForPlaintext(payload.action.valueRef, secretPlaintext);
      const expectedDigest = desktopActionDigestSha256({
        sessionId: payload.permit.sessionId,
        runId: payload.permit.runId,
        action: payload.action,
        decisionId: payload.permit.decisionId,
        policyId: payload.permit.policyId,
        risk: payload.permit.risk,
        expiresAt: payload.permit.expiresAt,
        nonceBase64: payload.permit.nonceBase64,
        valueBinding: payload.permit.valueBinding,
      });
      const bindingMatches =
        payload.sessionId === payload.permit.sessionId &&
        payload.action.actionId === payload.permit.actionId &&
        payload.action.graphId === payload.permit.graphId &&
        payload.permit.actionDigestSha256 === expectedDigest &&
        value?.plaintext === secretPlaintext &&
        value?.valueRef === expectedBinding.valueRef &&
        value?.valueSha256 === expectedBinding.valueSha256 &&
        value?.valueByteLength === expectedBinding.valueByteLength &&
        payload.permit.valueBinding?.valueRef === expectedBinding.valueRef &&
        payload.permit.valueBinding?.valueSha256 === expectedBinding.valueSha256 &&
        payload.permit.valueBinding?.valueByteLength === expectedBinding.valueByteLength;
      event({
        event: "dispatch",
        actionId: payload.action.actionId,
        targetKind: payload.action.targetKind,
        kind: payload.action.kind,
        value,
        bindingMatches,
        alreadyConsumed: consumedPermit,
      });
      if (!bindingMatches) {
        writeFrame(socket, errorResponse(request.requestId, "action.execute", "LocalPermitInvalid", "action binding mismatch"));
        return;
      }
      if (consumedPermit) {
        writeFrame(socket, ok(request.requestId, "action.execute", { status: "failed", errorCode: "LocalPermitConsumed" }));
        return;
      }
      consumedPermit = true;
      if (scenario === "post-dispatch-disconnect") {
        socket.destroy();
        return;
      }
      writeFrame(socket, ok(request.requestId, "action.execute", { status: "ok" }));
      return;
    }
    case "app.shutdown":
      writeFrame(socket, ok(request.requestId, "app.shutdown", { sessionId: request.payload.sessionId, completedAt: "2026-08-26T00:00:04.000Z" }));
      return;
    default:
      writeFrame(socket, errorResponse(request.requestId, "session.show", "UnsupportedRequest", "request not supported by fixture"));
  }
}

function onData(socket, chunk) {
  try {
    const previous = socketBuffers.get(socket) ?? Buffer.alloc(0);
    let buffered = Buffer.concat([previous, chunk]);
    while (buffered.byteLength >= 4) {
      const declaredLength = buffered.readUInt32BE(0);
      if (declaredLength > 1024 * 1024) {
        throw new Error("frame too large");
      }
      if (buffered.byteLength < declaredLength + 4) {
        break;
      }
      const body = buffered.subarray(4, 4 + declaredLength);
      buffered = buffered.subarray(4 + declaredLength);
      handleFrame(socket, JSON.parse(body.toString("utf8")));
    }
    socketBuffers.set(socket, buffered);
  } catch (error) {
    event({ event: "fixture-error", message: error instanceof Error ? error.message : String(error) });
    socket.destroy();
  }
}

const appSession = {
  sessionId: "sess-ticket28",
  processId: 8428,
  processCreationTime: "2026-08-26T00:00:00.000Z",
  processGroupId: "job:ticket28-reference",
  rootWindowHandle: "0x2800",
  startedAt: "2026-08-26T00:00:01.000Z",
};

function capturePayload(sessionId) {
  return {
    sessionId,
    capturedAt: "2026-08-26T00:00:02.000Z",
    rootNodeIds: ["root"],
    nodes: [
      {
        nodeId: "root",
        role: "window",
        controlTypeId: 50032,
        name: "Ticket 28 Reference App",
        processId: 8428,
        isOffscreen: false,
        isKeyboardFocusable: true,
        hasKeyboardFocus: false,
        isPassword: false,
        nativeWindowHandle: "0x2800",
        patterns: [{ pattern: "Window", available: true }],
        children: ["username"],
      },
      {
        nodeId: "username",
        role: "textbox",
        controlTypeId: 50004,
        name: "Username",
        automationId: "UsernameTextBox",
        frameworkId: "WPF",
        processId: 8428,
        isOffscreen: false,
        isKeyboardFocusable: true,
        hasKeyboardFocus: true,
        isPassword: false,
        patterns: [{ pattern: "Value", available: true }],
        children: [],
      },
    ],
  };
}

const server = createServer((socket) => {
  sockets.add(socket);
  socket.on("data", (chunk) => onData(socket, chunk));
  socket.on("close", () => sockets.delete(socket));
  socket.on("error", () => undefined);
});

server.on("error", (error) => {
  sendMessage({ kind: "error", message: error.message });
});

server.listen(pipePath, () => {
  sendMessage({ kind: "ready", pid: process.pid });
});

process.on("message", (message) => {
  if (message && message.type === "shutdown") {
    for (const socket of sockets) socket.destroy();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 250).unref();
  }
});
`;

const SECRET_REF = "secret.username";
const SECRET_PLAINTEXT = "alice.ticket28@example.test";
const RUN_ID = "run-ticket28";
const ACTION_TIMEOUT_MS = 1_000;

interface FixtureEvent {
  readonly event: string;
  readonly type?: string;
  readonly requestId?: string;
  readonly verified?: boolean;
  readonly proofPayload?: string;
  readonly payload?: unknown;
  readonly value?: unknown;
  readonly valueBinding?: unknown;
  readonly bindingMatches?: boolean;
  readonly targetKind?: string;
  readonly kind?: string;
  readonly alreadyConsumed?: boolean;
  readonly containsPlaintext?: boolean;
  readonly message?: string;
}

interface FixtureHandle {
  readonly child: ChildProcess;
  readonly pipePath: string;
  readonly events: FixtureEvent[];
  readonly stdout: string[];
  readonly stderr: string[];
  waitForEvent(predicate: (event: FixtureEvent) => boolean, timeoutMs?: number): Promise<FixtureEvent>;
  stop(): Promise<void>;
}

function requireWindowsNamedPipes(): void {
  if (process.platform !== "win32") {
    throw new Error(
      `TICKET28_E2E_ENVIRONMENT_UNAVAILABLE: tests/e2e/windows/desktop-runner.test.ts requires a win32 Node.js process with local Named Pipe support for the separate-process authenticated Companion contract fixture; current platform is ${process.platform}. This is a fail-closed environment error, not a skip or synthetic success.`,
    );
  }
}

async function startFixture(scenario: "happy" | "post-dispatch-disconnect"): Promise<FixtureHandle> {
  requireWindowsNamedPipes();
  const pipePath = `\\\\.\\pipe\\qualigence-ticket28-${process.pid}-${Date.now()}-${randomUUID()}`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", FIXTURE_SOURCE], {
    cwd: process.cwd(),
    env: { ...process.env, TICKET28_PIPE_PATH: pipePath, TICKET28_SCENARIO: scenario },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  const events: FixtureEvent[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const eventWaiters = new Set<(event: FixtureEvent) => void>();

  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));

  const ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`TICKET28_E2E_ENVIRONMENT_UNAVAILABLE: fixture ${scenario} did not become ready; stdout=${stdout.join("")} stderr=${stderr.join("")}`));
    }, 5_000);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`TICKET28_E2E_ENVIRONMENT_UNAVAILABLE: fixture ${scenario} exited before ready code=${code ?? "null"} signal=${signal ?? "null"}; stdout=${stdout.join("")} stderr=${stderr.join("")}`));
    });
    child.on("message", (message: unknown) => {
      if (!isFixtureMessage(message)) return;
      if (message.kind === "ready") {
        clearTimeout(timeout);
        resolve();
        return;
      }
      if (message.kind === "error") {
        clearTimeout(timeout);
        reject(new Error(`TICKET28_E2E_ENVIRONMENT_UNAVAILABLE: fixture ${scenario} failed: ${message.message}`));
        return;
      }
      events.push(message);
      for (const waiter of eventWaiters) waiter(message);
    });
  });

  await ready;

  return {
    child,
    pipePath,
    events,
    stdout,
    stderr,
    waitForEvent(predicate: (event: FixtureEvent) => boolean, timeoutMs = 2_000): Promise<FixtureEvent> {
      const existing = events.find(predicate);
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise<FixtureEvent>((resolve, reject) => {
        const timeout = setTimeout(() => {
          eventWaiters.delete(onEvent);
          reject(new Error(`fixture ${scenario} did not observe expected event; events=${JSON.stringify(events)} stdout=${stdout.join("")} stderr=${stderr.join("")}`));
        }, timeoutMs);
        const onEvent = (event: FixtureEvent): void => {
          if (predicate(event)) {
            clearTimeout(timeout);
            eventWaiters.delete(onEvent);
            resolve(event);
          }
        };
        eventWaiters.add(onEvent);
      });
    },
    async stop(): Promise<void> {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.send?.({ type: "shutdown" });
      const timeout = setTimeout(() => child.kill(), 1_000);
      await once(child, "exit").catch(() => undefined);
      clearTimeout(timeout);
    },
  };
}

function isFixtureMessage(message: unknown): message is ({ readonly kind: "ready" } | { readonly kind: "error"; readonly message: string } | ({ readonly kind: "event" } & FixtureEvent)) {
  return typeof message === "object" && message !== null && typeof (message as { readonly kind?: unknown }).kind === "string";
}

function createSigner(): RunnerCertificateProofSigner {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const certificatePem = exportPublicKeyPem(publicKey);
  return {
    runnerId: "runner-ticket28",
    certificatePem,
    certificateSha256Fingerprint: createHash("sha256").update(certificatePem, "utf8").digest("hex"),
    async signCompanionProof(bytes: Uint8Array): Promise<CompanionProofSignature> {
      const signer = createSign("SHA256");
      signer.update(bytes);
      signer.end();
      return { signatureBase64: signer.sign(privateKey).toString("base64"), signatureAlgorithm: "ecdsa-p256-sha256" };
    },
  };
}

function exportPublicKeyPem(publicKey: KeyObject): string {
  const exported = publicKey.export({ type: "spki", format: "pem" });
  return typeof exported === "string" ? exported : exported.toString("utf8");
}

function createClient(handle: FixtureHandle): NamedPipeCompanionClient {
  let sequence = 0;
  return new NamedPipeCompanionClient({
    pipePath: handle.pipePath,
    signer: createSigner(),
    requestIdFactory: () => `ticket28-${++sequence}`,
    connectTimeoutMs: 1_000,
    handshakeDeadlineMs: 1_000,
    defaultRequestDeadlineMs: ACTION_TIMEOUT_MS,
  });
}

const appTarget: AppTarget = {
  targetId: "ticket28-reference",
  platform: "windows",
  launch: {
    executable: "C:\\Apps\\Ticket28Reference\\Reference.exe",
    args: ["--fixture"],
    workingDirectory: "C:\\Apps\\Ticket28Reference",
  },
  process: {
    expectedImageName: "Reference.exe",
    allowedChildImageNames: [],
  },
  window: { titlePattern: "Ticket 28 Reference" },
  reset: { command: "C:\\Apps\\Ticket28Reference\\Reset.exe", args: [], timeoutMs: 5_000 },
  shutdown: { gracefulTimeoutMs: 3_000, forceAfterTimeout: true },
};

function desktopJob(runId = RUN_ID): AcceptedExecutionJob {
  return {
    jobId: `job-${runId}`,
    runId,
    projectId: "project-ticket28",
    target: { kind: "desktop", app: appTarget },
    objective: "enter the Ticket 28 username through the Desktop Target Runtime",
    policy: {
      policyId: "policy-ticket28-desktop",
      environment: "isolated_test",
      allowedOrigins: ["https://ticket28-reference.test"],
      allowedActionKinds: ["input"],
      maximumRisk: "ExternalSideEffect",
      explorationAllowed: false,
      issuedAt: "2026-08-26T00:00:00.000Z",
      expiresAt: "2026-08-26T00:10:00.000Z",
    },
    plan: {
      missionId: "mission-ticket28",
      missionRevision: 1,
      testCaseId: "case-ticket28-input",
      steps: [{ stepIndex: 0, kind: "input", target: { role: "textbox", name: "Username", purpose: "username entry" }, valueRef: SECRET_REF }],
      expectedClaimIds: ["username.entered"],
      budget: { maximumStepsPerJob: 3, maximumWallClockMs: 10_000, maximumModelTokens: 1_000 },
    },
  } satisfies AcceptedExecutionJob;
}

function runnerConfig(): RunnerConfig {
  return {
    runnerId: "runner-ticket28",
    coreAddress: "127.0.0.1:50555",
    authority: "localhost",
    tls: {
      ca: Buffer.from("ticket28-e2e-unused-ca"),
      cert: Buffer.from("ticket28-e2e-unused-cert"),
      key: Buffer.from("ticket28-e2e-unused-key"),
    },
    dataDir: ".ticket28-e2e-runner-data-unused",
    model: {
      baseUrl: "http://127.0.0.1:9/v1",
      apiKey: "unused-ticket28-e2e",
      modelName: "unused-ticket28-e2e",
      maximumTokensPerCall: 1_000,
    },
    headed: false,
    navigationTimeoutMs: ACTION_TIMEOUT_MS,
    actionTimeoutMs: ACTION_TIMEOUT_MS,
  };
}

function makeTraceRecorder(events: TraceEvent[]): { readonly append: (input: TraceEventInput) => Promise<TraceEvent> } {
  let sequence = 0;
  return {
    async append(input: TraceEventInput): Promise<TraceEvent> {
      sequence += 1;
      const event = {
        protocolVersion: "runner-protocol/v1" as const,
        schemaVersion: "trace-event/v1" as const,
        messageId: `trace-${sequence}`,
        idempotencyKey: `trace-${sequence}`,
        runId: input.runId,
        sequenceNumber: sequence,
        ...(input.stepIndex === undefined ? {} : { stepIndex: input.stepIndex }),
        stage: input.stage,
        occurredAt: `2026-08-26T00:00:${String(sequence).padStart(2, "0")}.000Z`,
        payloadHash: "0".repeat(64),
        payload: input.payload,
      } as TraceEvent;
      const hashed = { ...event, payloadHash: canonicalTraceEventHash(event) } as TraceEvent;
      events.push(hashed);
      return hashed;
    },
  };
}

async function runDesktopRuntimeWithFixture(handle: FixtureHandle, options: { readonly runId?: string } = {}): Promise<{
  readonly client: NamedPipeCompanionClient;
  readonly completion: Awaited<ReturnType<ExecutionRuntime<"input">["run"]>>;
  readonly traces: TraceEvent[];
  readonly valueProviderCalls: string[];
  readonly webFallbackAttempts: number;
}> {
  const client = createClient(handle);
  let webFallbackAttempts = 0;
  const valueProviderCalls: string[] = [];
  const traces: TraceEvent[] = [];
  const job = desktopJob(options.runId ?? RUN_ID);
  const factory = new TargetRuntimeFactory({
    config: runnerConfig(),
    verifier: { async verify() { return { status: "passed" as const, summary: "Ticket 28 Desktop TypeScript boundary verified", claims: [] as const }; } },
    valueProvider: {
      async resolve(valueRef: string): Promise<string> {
        valueProviderCalls.push(valueRef);
        if (valueRef !== SECRET_REF) throw new Error(`unexpected valueRef ${valueRef}`);
        return SECRET_PLAINTEXT;
      },
    },
    companion: client,
    platform: "win32",
    createWebTarget: () => {
      webFallbackAttempts += 1;
      throw new Error("Ticket 28 Desktop E2E attempted Web fallback");
    },
  });
  const resources = await factory.open(job);
  try {
    const runtime = new ExecutionRuntime<"input">({
      observer: resources.observer,
      decisionProvider: {
        async decide() {
          return { kind: "input", target: { nodeId: "username" }, valueRef: SECRET_REF, reason: "Ticket 28 Desktop valueRef dispatch" };
        },
      },
      resolver: resources.resolver as unknown as ActionResolver<"input">,
      policyGate: new DeterministicRunnerPolicyGate(job.policy, { now: () => Date.parse("2026-08-26T00:01:00.000Z") }),
      actionExecutor: resources.actionExecutor,
      verifier: resources.verifier,
      traceRecorder: makeTraceRecorder(traces),
      objectiveOnlyMaximumWallClockMs: 10_000,
      objectiveOnlyMaximumModelTokens: 1_000,
      terminalRecordingTimeoutMs: 1_000,
    });
    const completion = await runtime.run(job);
    return { client, completion, traces, valueProviderCalls, webFallbackAttempts };
  } finally {
    await resources.close();
  }
}

async function withFixture<T>(scenario: "happy" | "post-dispatch-disconnect", run: (handle: FixtureHandle) => Promise<T>): Promise<T> {
  const handle = await startFixture(scenario);
  try {
    return await run(handle);
  } finally {
    await handle.stop();
  }
}

function requestTypes(handle: FixtureHandle): string[] {
  return handle.events
    .filter((event) => event.event === "request")
    .map((event) => event.type)
    .filter((type): type is string => type !== undefined);
}

function fixtureRequests(handle: FixtureHandle, type: string): FixtureEvent[] {
  return handle.events.filter((event) => event.event === "request" && event.type === type);
}

function expectNoPlaintextInTrace(traces: readonly TraceEvent[]): void {
  const traceJson = JSON.stringify(traces);
  expect(traceJson).not.toContain(SECRET_PLAINTEXT);
  expect(traceJson).toContain(SECRET_REF);
}

describe("Ticket 28 Desktop Runner Target Runtime E2E (TypeScript boundary)", () => {
  beforeAll(() => {
    requireWindowsNamedPipes();
  });

  it("authenticates and probes before Desktop capability/admission, then executes valueRef dispatch without Web fallback", async () => {
    await withFixture("happy", async (handle) => {
      const startupClient = createClient(handle);
      const beforeProbeCapabilities = runnerCapabilities(undefined, { desktopReady: false, platform: "win32" });
      expect([...advertisedCapabilityTokens(beforeProbeCapabilities)]).not.toContain(DESKTOP_UIA_V1_CAPABILITY_TOKENS[0]);
      expect(negotiateCapabilities(beforeProbeCapabilities, DESKTOP_UIA_V1_CAPABILITY_TOKENS)).toMatchObject({
        outcome: "rejected",
        rejection: { code: "CapabilityMismatch" },
      });

      await startupClient.authenticate();
      await startupClient.probe();
      await handle.waitForEvent((event) => event.event === "proof" && event.verified === true);
      expect(requestTypes(handle)).toEqual(["handshake.begin", "handshake.prove", "companion.probe"]);

      const afterProbeCapabilities = runnerCapabilities({ resolve: async () => SECRET_PLAINTEXT }, { desktopReady: true, platform: "win32" });
      expect(negotiateCapabilities(afterProbeCapabilities, DESKTOP_UIA_V1_CAPABILITY_TOKENS)).toEqual({ outcome: "accepted" });
      expect([...advertisedCapabilityTokens(afterProbeCapabilities)]).toEqual(expect.arrayContaining([
        "target:desktop-windows-uia",
        "observation:uia/v1",
        "action:input",
      ]));
      startupClient.close();

      const { client, completion, traces, valueProviderCalls, webFallbackAttempts } = await runDesktopRuntimeWithFixture(handle);
      client.close();

      expect(completion).toEqual({ jobId: "job-run-ticket28", runId: RUN_ID, status: "passed" });
      expect(webFallbackAttempts).toBe(0);
      expect(valueProviderCalls).toEqual([SECRET_REF, SECRET_REF]);

      const allRequestTypes = requestTypes(handle);
      expect(allRequestTypes).toEqual([
        "handshake.begin",
        "handshake.prove",
        "companion.probe",
        "handshake.begin",
        "handshake.prove",
        "companion.probe",
        "app.launch",
        "uia.capture",
        "permit.request",
        "action.execute",
        "uia.capture",
        "app.shutdown",
      ]);
      expect(allRequestTypes.indexOf("companion.probe", 3)).toBeLessThan(allRequestTypes.indexOf("app.launch"));
      expect(fixtureRequests(handle, "permit.request")).toHaveLength(1);
      expect(fixtureRequests(handle, "action.execute")).toHaveLength(1);

      const permitEvent = handle.events.find((event) => event.event === "permit-approved");
      expect(permitEvent).toMatchObject({ containsPlaintext: false });
      const dispatch = await handle.waitForEvent((event) => event.event === "dispatch");
      expect(dispatch).toMatchObject({ targetKind: "desktop", kind: "input", bindingMatches: true, alreadyConsumed: false });
      expect(JSON.stringify(dispatch.value)).toContain(SECRET_PLAINTEXT);
      expect(JSON.stringify(permitEvent?.valueBinding)).not.toContain(SECRET_PLAINTEXT);
      expectNoPlaintextInTrace(traces);
      expect(traces.map((event) => event.stage)).toEqual([
        "observation",
        "decision",
        "action_resolved",
        "policy_authorized",
        "action_executed",
        "observation",
        "verification",
        "run_completed",
      ]);
      expect(traces.at(-1)?.payload).toEqual({ status: "passed" });
    });
  });

  it("terminalizes a post-dispatch Companion disconnect as ActionOutcomeUnknown without replaying the Permit/action", async () => {
    await withFixture("post-dispatch-disconnect", async (handle) => {
      const result = await (async () => {
        const client = createClient(handle);
        let webFallbackAttempts = 0;
        const traces: TraceEvent[] = [];
        const valueProviderCalls: string[] = [];
        const job = desktopJob("run-ticket28-unknown");
        const factory = new TargetRuntimeFactory({
          config: runnerConfig(),
          verifier: { async verify() { return { status: "passed" as const, summary: "not reached after unknown outcome", claims: [] as const }; } },
          valueProvider: {
            async resolve(valueRef: string): Promise<string> {
              valueProviderCalls.push(valueRef);
              return SECRET_PLAINTEXT;
            },
          },
          companion: client,
          platform: "win32",
          createWebTarget: () => {
            webFallbackAttempts += 1;
            throw new Error("Ticket 28 Desktop E2E attempted Web fallback");
          },
        });
        const resources = await factory.open(job);
        try {
          const runtime = new ExecutionRuntime<"input">({
            observer: resources.observer,
            decisionProvider: {
              async decide() {
                return { kind: "input", target: { nodeId: "username" }, valueRef: SECRET_REF, reason: "Ticket 28 unknown outcome dispatch" };
              },
            },
            resolver: resources.resolver as unknown as ActionResolver<"input">,
            policyGate: new DeterministicRunnerPolicyGate(job.policy, { now: () => Date.parse("2026-08-26T00:01:00.000Z") }),
            actionExecutor: resources.actionExecutor,
            verifier: resources.verifier,
            traceRecorder: makeTraceRecorder(traces),
            objectiveOnlyMaximumWallClockMs: 10_000,
            objectiveOnlyMaximumModelTokens: 1_000,
            terminalRecordingTimeoutMs: 1_000,
          });
          const completion = await runtime.run(job);
          return { client, resources, completion, traces, valueProviderCalls, webFallbackAttempts };
        } catch (error) {
          client.close();
          await resources.close().catch(() => undefined);
          throw error;
        }
      })();
      result.client.close();
      await result.resources.close().catch(() => undefined);

      expect(result.completion).toEqual({
        jobId: "job-run-ticket28-unknown",
        runId: "run-ticket28-unknown",
        status: "error",
        errorCode: "ActionOutcomeUnknown",
      });
      expect(result.webFallbackAttempts).toBe(0);
      expect(result.valueProviderCalls).toEqual([SECRET_REF, SECRET_REF]);
      await handle.waitForEvent((event) => event.event === "dispatch");
      expect(fixtureRequests(handle, "permit.request")).toHaveLength(1);
      expect(fixtureRequests(handle, "action.execute")).toHaveLength(1);
      expect(handle.events.filter((event) => event.event === "dispatch")).toHaveLength(1);
      expect(result.traces.map((event) => event.stage)).toEqual([
        "observation",
        "decision",
        "action_resolved",
        "policy_authorized",
        "run_completed",
      ]);
      expect(result.traces.at(-1)?.payload).toEqual({ status: "error", errorCode: "ActionOutcomeUnknown" });
      expectNoPlaintextInTrace(result.traces);
    });
  });
});

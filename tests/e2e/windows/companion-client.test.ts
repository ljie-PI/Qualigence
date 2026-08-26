import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash, createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  NamedPipeCompanionClient,
  type CompanionProofSignature,
  type RunnerCertificateProofSigner,
} from "@qualigence/desktop-windows-uia";
import type {
  AppTarget,
  LocalExecutionPermit,
  LocalPermitRequest,
  ResolvedDesktopAction,
} from "@qualigence/desktop-contracts";

const fixtureSource = String.raw`
import { createServer } from "node:net";
import { Buffer } from "node:buffer";
import { createHash, createVerify } from "node:crypto";
import { parseCompanionRequest } from "@qualigence/desktop-contracts";

const pipePath = process.env.TICKET27_PIPE_PATH;
const scenario = process.env.TICKET27_SCENARIO;
if (!pipePath || !scenario) {
  throw new Error("missing fixture configuration");
}

const PROTOCOL_MAJOR = 1;
const companionInstanceId = "ticket27-e2e-companion";
const challengeId = "ticket27-e2e-challenge";
const nonceBase64 = Buffer.from("ticket27-e2e-nonce", "utf8").toString("base64");
const sockets = new Set();
let authenticated = false;
let runnerId;
let certificatePem;
let certificateFingerprint;
let buffered = Buffer.alloc(0);
const heldCaptures = [];

function sendMessage(message) {
  if (process.send) {
    process.send(message);
  }
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

function writeOversizedLength(socket) {
  const frame = Buffer.alloc(4);
  frame.writeUInt32BE(1024 * 1024 + 1, 0);
  socket.write(frame);
}

function writePartialFrame(socket, value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const frame = Buffer.alloc(4 + body.byteLength);
  frame.writeUInt32BE(body.byteLength, 0);
  body.copy(frame, 4);
  socket.write(frame.subarray(0, 12));
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

function handleFrame(socket, frame) {
  const request = parseCompanionRequest(frame.body);
  event({ event: "request", type: request.type, requestId: request.requestId, declaredLength: frame.declaredLength });
  if (request.type === "handshake.begin") {
    runnerId = request.payload.runnerId;
    certificatePem = request.payload.certificatePem;
    certificateFingerprint = createHash("sha256").update(certificatePem, "utf8").digest("hex");
    writeFrame(socket, ok(request.requestId, "handshake.challenge", { challengeId, companionInstanceId, nonceBase64 }));
    return;
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
      return;
    }
    authenticated = true;
    writeFrame(socket, ok(request.requestId, "handshake.accepted", {
      companionInstanceId,
      runnerId,
      certificateSha256Fingerprint: certificateFingerprint,
      acceptedAt: "2026-08-26T00:00:00.000Z",
    }));
    return;
  }

  if (!authenticated) {
    writeFrame(socket, errorResponse(request.requestId, "handshake.accepted", "CompanionUnauthenticated", "authenticate first"));
    socket.destroy();
    return;
  }

  if (scenario === "disconnect" && request.type === "app.launch") {
    socket.destroy();
    return;
  }

  if (scenario === "partial" && request.type === "uia.capture") {
    writePartialFrame(socket, ok(request.requestId, "uia.capture", capturePayload(request.payload.sessionId)));
    return;
  }

  if (scenario === "oversized" && request.type === "uia.capture") {
    writeOversizedLength(socket);
    return;
  }

  if (scenario === "stall" && request.type === "uia.capture") {
    return;
  }

  switch (request.type) {
    case "app.launch":
      writeFrame(socket, ok(request.requestId, "app.launch", appSession));
      break;
    case "uia.capture":
      if (scenario === "happy" && request.payload.sessionId.startsWith("capture-")) {
        heldCaptures.push(request);
        if (heldCaptures.length === 2) {
          const second = heldCaptures[1];
          const first = heldCaptures[0];
          writeFrame(socket, ok(second.requestId, "uia.capture", capturePayload(second.payload.sessionId)));
          writeFrame(socket, ok(first.requestId, "uia.capture", capturePayload(first.payload.sessionId)));
        }
        break;
      }
      writeFrame(socket, ok(request.requestId, "uia.capture", capturePayload(request.payload.sessionId)));
      break;
    case "permit.request":
      writeFrame(socket, ok(request.requestId, "permit.request", {
        status: "approved",
        approvalId: request.payload.request.approvalId,
        decidedAt: "2026-08-26T00:00:02.000Z",
        permit,
      }));
      break;
    case "action.execute":
      writeFrame(socket, ok(request.requestId, "action.execute", { status: "ok" }));
      break;
    case "app.reset":
      writeFrame(socket, ok(request.requestId, "app.reset", { sessionId: request.payload.sessionId, completedAt: "2026-08-26T00:00:03.000Z" }));
      break;
    case "app.shutdown":
      writeFrame(socket, ok(request.requestId, "app.shutdown", { sessionId: request.payload.sessionId, completedAt: "2026-08-26T00:00:04.000Z" }));
      break;
    default:
      writeFrame(socket, errorResponse(request.requestId, "session.show", "UnsupportedRequest", "request not supported by fixture"));
      break;
  }
}

function onData(socket, chunk) {
  try {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.byteLength >= 4) {
      const declaredLength = buffered.readUInt32BE(0);
      if (buffered.byteLength < declaredLength + 4) {
        return;
      }
      const body = buffered.subarray(4, 4 + declaredLength);
      buffered = buffered.subarray(4 + declaredLength);
      handleFrame(socket, { declaredLength, body: JSON.parse(body.toString("utf8")) });
    }
  } catch (error) {
    event({ event: "fixture-error", message: error instanceof Error ? error.message : String(error) });
    socket.destroy();
  }
}

const appSession = {
  sessionId: "sess-e2e",
  processId: 4321,
  processCreationTime: "2026-08-26T00:00:00.000Z",
  processGroupId: "group-e2e",
  rootWindowHandle: "0x200",
  startedAt: "2026-08-26T00:00:01.000Z",
};

const permit = {
  permitToken: "dGlja2V0MjctcGVybWl0",
  nonceBase64: "dGlja2V0MjctcGVybWl0LW5vbmNl",
  sessionId: "sess-e2e",
  runId: "run-e2e",
  actionId: "act-e2e",
  actionDigestSha256: "a".repeat(64),
  graphId: "graph-e2e",
  risk: "Normal",
  issuedAt: "2026-08-26T00:00:02.000Z",
  expiresAt: "2026-08-26T00:05:02.000Z",
};

function capturePayload(sessionId) {
  return {
    sessionId,
    capturedAt: "2026-08-26T00:00:02.000Z",
    rootNodeIds: ["root"],
    nodes: [{
      nodeId: "root",
      role: "window",
      controlTypeId: 50032,
      processId: 4321,
      isOffscreen: false,
      isKeyboardFocusable: true,
      hasKeyboardFocus: false,
      isPassword: false,
      value: "Reference App",
      patterns: [{ pattern: "Window", available: true }],
      children: [],
    }],
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
    for (const socket of sockets) {
      socket.destroy();
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 250).unref();
  }
});
`;

interface FixtureEvent {
  readonly event: string;
  readonly type?: string;
  readonly requestId?: string;
  readonly declaredLength?: number;
  readonly verified?: boolean;
  readonly proofPayload?: string;
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
      `Ticket 27 Windows Companion client acceptance requires Node named-pipe support on win32; current platform is ${process.platform}. ` +
      "This is an environment blocker, not a skipped or synthetic pass.",
    );
  }
}

async function startFixture(scenario: string): Promise<FixtureHandle> {
  requireWindowsNamedPipes();
  const pipePath = `\\\\.\\pipe\\qualigence-ticket27-${process.pid}-${Date.now()}-${randomUUID()}`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", fixtureSource], {
    cwd: process.cwd(),
    env: { ...process.env, TICKET27_PIPE_PATH: pipePath, TICKET27_SCENARIO: scenario },
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
      reject(new Error(`fixture ${scenario} did not become ready; stdout=${stdout.join("")} stderr=${stderr.join("")}`));
    }, 5000);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`fixture ${scenario} exited before ready code=${code ?? "null"} signal=${signal ?? "null"}; stdout=${stdout.join("")} stderr=${stderr.join("")}`));
    });
    child.on("message", (message: unknown) => {
      if (!isFixtureMessage(message)) {
        return;
      }
      if (message.kind === "ready") {
        clearTimeout(timeout);
        resolve();
        return;
      }
      if (message.kind === "error") {
        clearTimeout(timeout);
        reject(new Error(`fixture ${scenario} failed: ${message.message}`));
        return;
      }
      if (message.kind === "event") {
        events.push(message);
        for (const waiter of eventWaiters) {
          waiter(message);
        }
      }
    });
  });

  await ready;

  return {
    child,
    pipePath,
    events,
    stdout,
    stderr,
    waitForEvent(predicate: (event: FixtureEvent) => boolean, timeoutMs = 2000): Promise<FixtureEvent> {
      const existing = events.find(predicate);
      if (existing !== undefined) {
        return Promise.resolve(existing);
      }
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
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      child.send?.({ type: "shutdown" });
      const timeout = setTimeout(() => child.kill(), 1000);
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
    runnerId: "runner-e2e",
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

function createClient(handle: FixtureHandle, options: {
  readonly requestIds?: readonly string[];
  readonly defaultRequestDeadlineMs?: number;
  readonly maxInFlightRequests?: number;
} = {}): NamedPipeCompanionClient {
  const requestIds = [...(options.requestIds ?? ["h1", "h2", "r1", "r2", "r3", "r4", "r5", "r6"] )];
  return new NamedPipeCompanionClient({
    pipePath: handle.pipePath,
    signer: createSigner(),
    requestIdFactory: () => requestIds.shift() ?? `req-${requestIds.length}`,
    connectTimeoutMs: 1000,
    handshakeDeadlineMs: 1000,
    defaultRequestDeadlineMs: options.defaultRequestDeadlineMs ?? 500,
    ...(options.maxInFlightRequests === undefined ? {} : { maxInFlightRequests: options.maxInFlightRequests }),
  });
}

const target: AppTarget = {
  targetId: "ticket27-reference",
  platform: "windows",
  launch: {
    executable: "C:\\Apps\\Ticket27Reference\\Reference.exe",
    args: ["--fixture"],
    workingDirectory: "C:\\Apps\\Ticket27Reference",
  },
  process: {
    expectedImageName: "Reference.exe",
    allowedChildImageNames: [],
  },
  window: { titlePattern: "Ticket 27 Reference" },
  reset: { command: "C:\\Apps\\Ticket27Reference\\Reset.exe", args: [], timeoutMs: 5000 },
  shutdown: { gracefulTimeoutMs: 3000, forceAfterTimeout: true },
};

const action: ResolvedDesktopAction = {
  targetKind: "desktop",
  kind: "click",
  actionId: "act-e2e",
  graphId: "graph-e2e",
  nodeId: "root",
  resolution: "semantic",
};

const permit: LocalExecutionPermit = {
  permitToken: "dGlja2V0MjctcGVybWl0",
  nonceBase64: "dGlja2V0MjctcGVybWl0LW5vbmNl",
  sessionId: "sess-e2e",
  runId: "run-e2e",
  actionId: "act-e2e",
  actionDigestSha256: "a".repeat(64),
  graphId: "graph-e2e",
  risk: "Normal",
  issuedAt: "2026-08-26T00:00:02.000Z",
  expiresAt: "2026-08-26T00:05:02.000Z",
};

const permitRequest: LocalPermitRequest = {
  approvalId: "approval-e2e",
  sessionId: "sess-e2e",
  runId: "run-e2e",
  action,
  authorization: {
    decisionId: "decision-e2e",
    policyId: "policy-e2e",
    actionDigestSha256: "a".repeat(64),
    risk: "Normal",
    expiresAt: "2026-08-26T00:05:02.000Z",
  },
  safeSummary: "Click the Ticket 27 reference root node",
  expiresAt: "2026-08-26T00:05:02.000Z",
};

async function withFixture<T>(scenario: string, run: (handle: FixtureHandle) => Promise<T>): Promise<T> {
  const handle = await startFixture(scenario);
  try {
    return await run(handle);
  } finally {
    await handle.stop();
  }
}

describe("Ticket 27 Windows separate-process Companion client acceptance", () => {
  it("authenticates over a real local Named Pipe and correlates out-of-order responses", async () => {
    await withFixture("happy", async (handle) => {
      const client = createClient(handle, { requestIds: ["h1", "h2", "launch", "cap-1", "cap-2", "permit", "action"] });

      await expect(client.launch(target)).resolves.toMatchObject({ sessionId: "sess-e2e", processId: 4321 });
      const [firstCapture, secondCapture] = await Promise.all([
        client.capture({ sessionId: "capture-1", deadlineMs: 500 }),
        client.capture({ sessionId: "capture-2", deadlineMs: 500 }),
      ]);
      await expect(client.requestPermit(permitRequest)).resolves.toMatchObject({ status: "approved", permit });
      await expect(client.execute({ sessionId: "sess-e2e", action, permit, deadlineMs: 500 })).resolves.toEqual({ status: "ok" });
      client.close();

      expect(firstCapture.sessionId).toBe("capture-1");
      expect(secondCapture.sessionId).toBe("capture-2");
      await handle.waitForEvent((event) => event.event === "proof" && event.verified === true);
      expect(handle.events.filter((event) => event.event === "request").map((event) => event.type)).toEqual([
        "handshake.begin",
        "handshake.prove",
        "app.launch",
        "uia.capture",
        "uia.capture",
        "permit.request",
        "action.execute",
      ]);
      const proof = handle.events.find((event) => event.event === "proof");
      expect(proof?.proofPayload).toBe("qualigence-companion-proof/v1\n1\nticket27-e2e-companion\ndGlja2V0MjctZTJlLW5vbmNl\nrunner-e2e\n");
      expect(handle.events.filter((event) => event.event === "request").every((event) => typeof event.declaredLength === "number" && event.declaredLength > 0)).toBe(true);
    });
  });

  it("treats a post-dispatch pipe disconnect as an unknown side-effect outcome", async () => {
    await withFixture("disconnect", async (handle) => {
      const client = createClient(handle, { requestIds: ["h1", "h2", "launch"], defaultRequestDeadlineMs: 500 });

      await expect(client.launch(target)).rejects.toMatchObject({ code: "CompanionUnavailable", outcomeUnknown: true });
      await handle.waitForEvent((event) => event.event === "request" && event.type === "app.launch");
      client.close();
    });
  });

  it("fails closed on partial and oversized response frames from the separate process", async () => {
    await withFixture("partial", async (handle) => {
      const client = createClient(handle, { requestIds: ["h1", "h2", "partial"], defaultRequestDeadlineMs: 80 });

      await expect(client.capture({ sessionId: "partial", deadlineMs: 80 })).rejects.toMatchObject({ code: "CompanionRequestTimeout" });
      await handle.waitForEvent((event) => event.event === "request" && event.type === "uia.capture");
      client.close();
    });

    await withFixture("oversized", async (handle) => {
      const client = createClient(handle, { requestIds: ["h1", "h2", "oversized"], defaultRequestDeadlineMs: 500 });

      await expect(client.capture({ sessionId: "oversized", deadlineMs: 500 })).rejects.toMatchObject({ code: "CompanionMessageTooLarge" });
      await handle.waitForEvent((event) => event.event === "request" && event.type === "uia.capture");
      client.close();
    });
  });

  it("enforces request deadlines and the bounded in-flight flood limit against a stalled separate process", async () => {
    await withFixture("stall", async (handle) => {
      const client = createClient(handle, {
        requestIds: ["h1", "h2", "first-capture", "second-capture"],
        defaultRequestDeadlineMs: 80,
        maxInFlightRequests: 1,
      });
      await client.authenticate();

      const first = client.capture({ sessionId: "first-capture", deadlineMs: 80 });
      const firstResult = first.then(
        (value: unknown) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await handle.waitForEvent((event) => event.event === "request" && event.requestId === "first-capture");
      await expect(client.capture({ sessionId: "second-capture", deadlineMs: 80 })).rejects.toMatchObject({ code: "CompanionBackpressure" });
      await expect(firstResult).resolves.toMatchObject({ error: { code: "CompanionRequestTimeout" } });
      expect(handle.events.filter((event) => event.event === "request" && event.type === "uia.capture").map((event) => event.requestId)).toEqual(["first-capture"]);
      client.close();
    });
  });
});

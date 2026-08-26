import { Buffer } from "node:buffer";
import { Duplex } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  PROTOCOL_MAJOR,
  COMPANION_IPC_LIMITS,
  parseCompanionRequest,
  type CompanionRequestEnvelope,
  type CompanionResponse,
  type CompanionResponseType,
} from "@qualigence/desktop-contracts";
import {
  NamedPipeCompanionClient,
  NamedPipeCompanionClientError,
  assertLocalNamedPipePath,
  type CompanionProofSignature,
  type RunnerCertificateProofSigner,
} from "@qualigence/desktop-windows-uia";

class MemorySocket extends Duplex {
  peer: MemorySocket | undefined;

  _read(): void {}

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.peer?.push(Buffer.from(chunk));
    callback();
  }

  override destroy(error?: Error): this {
    super.destroy(error);
    queueMicrotask(() => this.emit("close"));
    return this;
  }
}

function socketPair(): readonly [MemorySocket, MemorySocket] {
  const a = new MemorySocket();
  const b = new MemorySocket();
  a.peer = b;
  b.peer = a;
  return [a, b] as const;
}

function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const frame = Buffer.alloc(4 + body.byteLength);
  frame.writeUInt32BE(body.byteLength, 0);
  body.copy(frame, 4);
  return frame;
}

function oversizedFrame(length: number): Buffer {
  const frame = Buffer.alloc(4);
  frame.writeUInt32BE(length, 0);
  return frame;
}

function attachFrameReader(socket: MemorySocket, onFrame: (frame: CompanionRequestEnvelope) => void): void {
  let buffered = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.byteLength >= 4) {
      const length = buffered.readUInt32BE(0);
      if (buffered.byteLength < length + 4) {
        return;
      }
      const body = buffered.subarray(4, 4 + length);
      buffered = buffered.subarray(4 + length);
      onFrame(parseCompanionRequest(JSON.parse(body.toString("utf8"))));
    }
  });
}

function ok(requestId: string, type: CompanionResponseType, payload: unknown): CompanionResponse {
  return { protocolMajor: PROTOCOL_MAJOR, requestId, type, status: "ok", payload } as CompanionResponse;
}

const target = {
  targetId: "wpf-reference",
  platform: "windows",
  launch: { executable: "C:\\Apps\\Reference\\Reference.exe", args: [], workingDirectory: "C:\\Apps\\Reference" },
  process: { expectedImageName: "Reference.exe", allowedChildImageNames: [] },
  window: {},
  reset: { command: "C:\\Apps\\Reference\\Reset.exe", args: [], timeoutMs: 5000 },
  shutdown: { gracefulTimeoutMs: 3000, forceAfterTimeout: true },
} as const;

const appSession = {
  sessionId: "sess-1",
  processId: 1234,
  processCreationTime: "2026-08-01T00:00:00.000Z",
  processGroupId: "group-1",
  rootWindowHandle: "0x100",
  startedAt: "2026-08-01T00:00:00.000Z",
};

const action = {
  targetKind: "desktop",
  kind: "click",
  actionId: "act-1",
  graphId: "graph-1",
  nodeId: "node-1",
  resolution: "semantic",
} as const;

const permit = {
  permitToken: "token",
  nonceBase64: "nonce",
  sessionId: "sess-1",
  runId: "run-1",
  actionId: "act-1",
  actionDigestSha256: "a".repeat(64),
  graphId: "graph-1",
  risk: "Normal",
  issuedAt: "2026-08-01T00:00:00.000Z",
  expiresAt: "2026-08-01T00:00:30.000Z",
} as const;

function signer(recordedProofs: string[]): RunnerCertificateProofSigner {
  return {
    runnerId: "runner-1",
    certificatePem: "-----BEGIN CERTIFICATE-----\nredacted\n-----END CERTIFICATE-----",
    certificateSha256Fingerprint: "b".repeat(64),
    async signCompanionProof(bytes: Uint8Array): Promise<CompanionProofSignature> {
      recordedProofs.push(new TextDecoder().decode(bytes));
      return { signatureBase64: "c2ln", signatureAlgorithm: "ecdsa-p256-sha256" };
    },
  };
}

function clientWithServer(options: {
  readonly onFrame?: (frame: CompanionRequestEnvelope, server: MemorySocket) => void;
  readonly requestIds?: readonly string[];
  readonly maxInFlightRequests?: number;
  readonly defaultRequestDeadlineMs?: number;
} = {}): { readonly client: NamedPipeCompanionClient; readonly server: MemorySocket; readonly seen: CompanionRequestEnvelope[]; readonly proofs: string[] } {
  const [clientSocket, server] = socketPair();
  const seen: CompanionRequestEnvelope[] = [];
  const proofs: string[] = [];
  attachFrameReader(server, (frame) => {
    seen.push(frame);
    options.onFrame?.(frame, server);
  });
  const ids = [...(options.requestIds ?? ["req-1", "req-2", "req-3", "req-4", "req-5"] )];
  return {
    client: new NamedPipeCompanionClient({
      pipePath: "\\\\.\\pipe\\qualigence-companion-test",
      signer: signer(proofs),
      socketFactory: () => clientSocket,
      requestIdFactory: () => ids.shift() ?? `req-${seen.length + 1}`,
      handshakeDeadlineMs: 50,
      defaultRequestDeadlineMs: options.defaultRequestDeadlineMs ?? 50,
      ...(options.maxInFlightRequests === undefined ? {} : { maxInFlightRequests: options.maxInFlightRequests }),
    }),
    server,
    seen,
    proofs,
  };
}

function handshakeResponder(frame: CompanionRequestEnvelope, server: MemorySocket): boolean {
  if (frame.type === "handshake.begin") {
    server.write(encodeFrame(ok(frame.requestId, "handshake.challenge", {
      challengeId: "challenge-1",
      companionInstanceId: "companion-1",
      nonceBase64: "bm9uY2U=",
    })));
    return true;
  }
  if (frame.type === "handshake.prove") {
    server.write(encodeFrame(ok(frame.requestId, "handshake.accepted", {
      companionInstanceId: "companion-1",
      runnerId: "runner-1",
      certificateSha256Fingerprint: "b".repeat(64),
      acceptedAt: "2026-08-01T00:00:00.000Z",
    })));
    return true;
  }
  return false;
}

describe("NamedPipeCompanionClient endpoint validation", () => {
  it("accepts only configured local Named Pipe paths", () => {
    expect(() => assertLocalNamedPipePath("\\\\.\\pipe\\qualigence")).not.toThrow();
    expect(() => assertLocalNamedPipePath("\\\\remote\\pipe\\qualigence")).toThrow(NamedPipeCompanionClientError);
    expect(() => assertLocalNamedPipePath("tcp://127.0.0.1:1")).toThrow(NamedPipeCompanionClientError);
  });
});

describe("NamedPipeCompanionClient framing, handshake, correlation, and deadlines", () => {
  it("authenticates before launch and signs the exact Companion proof bytes", async () => {
    const { client, server, seen, proofs } = clientWithServer({
      onFrame(frame, socket) {
        if (handshakeResponder(frame, socket)) {
          return;
        }
        expect(frame.type).toBe("app.launch");
        socket.write(encodeFrame(ok(frame.requestId, "app.launch", appSession)));
      },
    });

    await expect(client.launch(target)).resolves.toEqual(appSession);
    expect(seen.map((entry) => entry.type)).toEqual(["handshake.begin", "handshake.prove", "app.launch"]);
    expect(proofs).toEqual(["qualigence-companion-proof/v1\n1\ncompanion-1\nbm9uY2U=\nrunner-1\n"]);
    server.destroy();
  });

  it("does not send an application request when the handshake is rejected", async () => {
    const { client, server, seen } = clientWithServer({
      onFrame(frame, socket) {
        if (frame.type === "handshake.begin") {
          socket.write(encodeFrame({
            protocolMajor: 1,
            requestId: frame.requestId,
            type: "handshake.challenge",
            status: "error",
            error: { code: "CompanionIdentityRejected", safeMessage: "certificate rejected" },
          }));
        }
      },
    });

    await expect(client.launch(target)).rejects.toMatchObject({ responseError: { code: "CompanionIdentityRejected" } });
    expect(seen.map((entry) => entry.type)).toEqual(["handshake.begin"]);
    server.destroy();
  });

  it("resolves concurrent requests by requestId even when responses arrive out of order", async () => {
    const held: CompanionRequestEnvelope[] = [];
    const { client, server } = clientWithServer({
      requestIds: ["h1", "h2", "c1", "c2"],
      onFrame(frame, socket) {
        if (handshakeResponder(frame, socket)) {
          return;
        }
        held.push(frame);
        if (held.length === 2) {
          socket.write(encodeFrame(ok(held[1]?.requestId ?? "", "uia.capture", {
            sessionId: "sess-2",
            capturedAt: "2026-08-01T00:00:00.000Z",
            rootNodeIds: [],
            nodes: [],
          })));
          socket.write(encodeFrame(ok(held[0]?.requestId ?? "", "uia.capture", {
            sessionId: "sess-1",
            capturedAt: "2026-08-01T00:00:00.000Z",
            rootNodeIds: [],
            nodes: [],
          })));
        }
      },
    });

    await client.authenticate();
    await expect(Promise.all([
      client.capture({ sessionId: "sess-1", deadlineMs: 50 }),
      client.capture({ sessionId: "sess-2", deadlineMs: 50 }),
    ])).resolves.toEqual([
      { sessionId: "sess-1", capturedAt: "2026-08-01T00:00:00.000Z", rootNodeIds: [], nodes: [] },
      { sessionId: "sess-2", capturedAt: "2026-08-01T00:00:00.000Z", rootNodeIds: [], nodes: [] },
    ]);
    server.destroy();
  });

  it("fails closed on a wrong correlation id", async () => {
    const { client, server } = clientWithServer({
      onFrame(frame, socket) {
        if (handshakeResponder(frame, socket)) {
          return;
        }
        socket.write(encodeFrame(ok("unknown-request", "uia.capture", {
          sessionId: "sess-1",
          capturedAt: "2026-08-01T00:00:00.000Z",
          rootNodeIds: [],
          nodes: [],
        })));
      },
    });

    await expect(client.capture({ sessionId: "sess-1", deadlineMs: 50 })).rejects.toMatchObject({ code: "CompanionCorrelationError" });
    server.destroy();
  });

  it("rejects oversized or partial frames and clears pending requests", async () => {
    const { client, server } = clientWithServer({
      onFrame(frame, socket) {
        if (handshakeResponder(frame, socket)) {
          return;
        }
        socket.write(oversizedFrame(COMPANION_IPC_LIMITS.maxFrameBytes + 1));
      },
    });

    await expect(client.capture({ sessionId: "sess-1", deadlineMs: 50 })).rejects.toMatchObject({ code: "CompanionMessageTooLarge" });
    server.destroy();
  });

  it("maps an action timeout after dispatch to non-replayable ActionOutcomeUnknown", async () => {
    const { client, server, seen } = clientWithServer({ defaultRequestDeadlineMs: 20, onFrame: handshakeResponder });

    await expect(client.execute({ sessionId: "sess-1", action, permit, deadlineMs: 20 })).rejects.toMatchObject({
      name: "DesktopExecutionError",
      code: "ActionOutcomeUnknown",
    });
    expect(seen.map((entry) => entry.type)).toContain("action.execute");
    server.destroy();
  });

  it("enforces a bounded in-flight request registry", async () => {
    const { client, server } = clientWithServer({ maxInFlightRequests: 1, onFrame: handshakeResponder });
    await client.authenticate();

    const first = client.requestPermit({
      approvalId: "ap-1",
      sessionId: "sess-1",
      runId: "run-1",
      action,
      authorization: {
        decisionId: "dec-1",
        policyId: "pol-1",
        actionDigestSha256: "a".repeat(64),
        risk: "Normal",
        expiresAt: "2026-08-01T00:00:30.000Z",
      },
      safeSummary: "Click",
      expiresAt: "2026-08-01T00:00:30.000Z",
    });
    await expect(client.requestPermit({
      approvalId: "ap-2",
      sessionId: "sess-1",
      runId: "run-1",
      action,
      authorization: {
        decisionId: "dec-2",
        policyId: "pol-1",
        actionDigestSha256: "a".repeat(64),
        risk: "Normal",
        expiresAt: "2026-08-01T00:00:30.000Z",
      },
      safeSummary: "Click",
      expiresAt: "2026-08-01T00:00:30.000Z",
    })).rejects.toMatchObject({ code: "CompanionBackpressure" });
    await expect(first).rejects.toMatchObject({ code: "CompanionRequestTimeout" });
    server.destroy();
  });
});

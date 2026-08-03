import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { GrpcRunnerProtocolClient, GrpcRunnerProtocolServer } from "@qualigence/grpc-runner-protocol";
import { createGrpcTestPki } from "../../helpers/grpc-test-pki.js";
import type { GrpcTestPki } from "../../helpers/grpc-test-pki.js";
import { makeHello, makeTestClient, startTestServer } from "../../helpers/grpc-harness.js";

let pki: GrpcTestPki;

beforeAll(() => {
  pki = createGrpcTestPki();
});

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) await cleanup();
  }
});

function track(server: GrpcRunnerProtocolServer, client: GrpcRunnerProtocolClient): void {
  cleanups.push(async () => {
    await client.close();
    await server.shutdown();
  });
}

describe("grpc runner protocol mutual TLS", () => {
  it("accepts a client whose certificate identity matches the claimed runnerId", async () => {
    const { server, port } = await startTestServer(pki);
    const client = makeTestClient(pki, port, pki.clientFor("runner-1"));
    track(server, client);

    const session = await client.connect(makeHello("runner-1"));
    expect(session.welcome.selectedProtocolMajor).toBe(1);
  });

  it("rejects a valid certificate whose identity differs from the claimed runnerId", async () => {
    const { server, port } = await startTestServer(pki);
    const client = makeTestClient(pki, port, pki.clientFor("runner-2"));
    track(server, client);

    await expect(client.connect(makeHello("runner-1"))).rejects.toMatchObject({
      code: "RunnerIdentityMismatch",
    });
  });

  it("rejects a client that presents no certificate", async () => {
    const { server, port } = await startTestServer(pki);
    const client = makeTestClient(pki, port);
    track(server, client);

    await expect(client.connect(makeHello("runner-1"))).rejects.toMatchObject({
      code: "TlsPeerRejected",
    });
  });

  it("rejects a client certificate signed by an untrusted CA", async () => {
    const { server, port } = await startTestServer(pki);
    const client = makeTestClient(pki, port, pki.untrustedClientFor("runner-1"));
    track(server, client);

    await expect(client.connect(makeHello("runner-1"))).rejects.toMatchObject({
      code: "TlsPeerRejected",
    });
  });

  it("rejects an expired client certificate", async () => {
    const { server, port } = await startTestServer(pki);
    const client = makeTestClient(pki, port, pki.expiredClientFor("runner-1"));
    track(server, client);

    await expect(client.connect(makeHello("runner-1"))).rejects.toMatchObject({
      code: "TlsPeerRejected",
    });
  });
});

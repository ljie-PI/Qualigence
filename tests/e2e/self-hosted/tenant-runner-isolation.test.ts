import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { RunnerHello } from "@qualigence/runner-protocol";
import type { AuthenticatedRunnerContext } from "@qualigence/grpc-runner-protocol";
import {
  makeHello,
  makeTestClient,
  RecordingRunnerProtocolApplication,
  startTestServer,
  welcomeParameters,
} from "../../helpers/grpc-harness.js";
import { createGrpcTestPki, type GrpcTestPki } from "../../helpers/grpc-test-pki.js";
import {
  UNSUPPORTED_TOKEN,
  WEB_GRAPH_V1_REQUIREMENTS,
  webJob,
} from "../../helpers/core-runner-harness.js";

let pki: GrpcTestPki;
const cleanups: Array<() => Promise<void>> = [];

beforeAll(() => {
  pki = createGrpcTestPki();
});

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe("Self-hosted tenant Runner isolation", () => {
  it("admits identical Runner IDs separately per tenant and rejects out-of-scope payloads before serialization", async () => {
    const applications = new Map<string, RecordingRunnerProtocolApplication>();
    const { server, port } = await startTestServer(pki, {
      authenticator: tenantAuthenticator((hello) => hello.runnerVersion),
      applicationResolver: {
        resolve: (identity) => {
          if (identity.scope.kind !== "tenant") throw new Error("expected tenant-scoped identity");
          let application = applications.get(identity.scope.tenantId);
          if (application === undefined) {
            application = new RecordingRunnerProtocolApplication(welcomeParameters());
            applications.set(identity.scope.tenantId, application);
          }
          return application;
        },
      },
    });
    const sharedCertificate = pki.clientFor("runner-shared");
    const clientA = makeTestClient(pki, port, sharedCertificate);
    const clientB = makeTestClient(pki, port, sharedCertificate);
    cleanups.push(async () => {
      await clientB.close();
      await clientA.close();
      await server.shutdown();
    });

    const sessionA = await clientA.connect({ ...makeHello("runner-shared"), runnerVersion: "tenant-a" });
    const sessionB = await clientB.connect({ ...makeHello("runner-shared"), runnerVersion: "tenant-b" });

    const tenantA = await server.waitForConnection({ tenantId: "tenant-a", runnerId: "runner-shared" });
    const tenantB = await server.waitForConnection({ tenantId: "tenant-b", runnerId: "runner-shared" });
    expect(tenantA).not.toBe(tenantB);
    expect(tenantA.authenticatedRunner.scope).toEqual({ kind: "tenant", tenantId: "tenant-a", projectIds: ["project-a"] });
    expect(tenantB.authenticatedRunner.scope).toEqual({ kind: "tenant", tenantId: "tenant-b", projectIds: ["project-b"] });
    expect(server.connectionFor({ tenantId: "tenant-a", runnerId: "runner-shared" })).toBe(tenantA);
    expect(server.connectionFor({ tenantId: "tenant-b", runnerId: "runner-shared" })).toBe(tenantB);
    expect(server.connection("runner-shared")).toBeUndefined();

    const tenantAOffer = tenantA.offer(webJob({ jobId: "job-a", runId: "run-a", projectId: "project-a" }), WEB_GRAPH_V1_REQUIREMENTS);
    const offerA = await sessionA.nextOffer(new AbortController().signal);
    expect(offerA.job).toMatchObject({ jobId: "job-a", runId: "run-a", projectId: "project-a" });
    const acceptedA = await sessionA.accept(offerA.offerId);
    await expect(tenantAOffer).resolves.toMatchObject({ leaseToken: acceptedA.leaseToken, runId: "run-a" });

    const tenantBOffer = tenantB.offer(webJob({ jobId: "job-b", runId: "run-b", projectId: "project-b" }), WEB_GRAPH_V1_REQUIREMENTS);
    const offerB = await sessionB.nextOffer(new AbortController().signal);
    expect(offerB.job).toMatchObject({ jobId: "job-b", runId: "run-b", projectId: "project-b" });
    const acceptedB = await sessionB.accept(offerB.offerId);
    await expect(tenantBOffer).resolves.toMatchObject({ leaseToken: acceptedB.leaseToken, runId: "run-b" });

    const tenantAApplication = applications.get("tenant-a");
    expect(tenantAApplication).toBeDefined();
    const callsBeforeRejections = tenantAApplication!.calls.length;
    await expect(
      tenantA.offer(webJob({ jobId: "job-wrong-project", runId: "run-wrong-project", projectId: "project-b" }), WEB_GRAPH_V1_REQUIREMENTS),
    ).rejects.toMatchObject({ code: "RunnerScopeViolation" });
    await expect(
      tenantA.offer(webJob({ jobId: "job-missing-capability", runId: "run-missing-capability", projectId: "project-a" }), [
        ...WEB_GRAPH_V1_REQUIREMENTS,
        UNSUPPORTED_TOKEN,
      ]),
    ).rejects.toMatchObject({ code: "CapabilityMismatch" });
    expect(tenantAApplication!.calls).toHaveLength(callsBeforeRejections);
  }, 60_000);
});

function tenantAuthenticator(tenantForHello: (hello: RunnerHello) => string) {
  return {
    authenticate: async (_peer: unknown, hello: RunnerHello): Promise<AuthenticatedRunnerContext> => {
      const tenantId = tenantForHello(hello);
      return {
        runnerId: hello.runnerId,
        certificateFingerprint: `fp-${tenantId}-${hello.runnerId}`,
        scope: {
          kind: "tenant",
          tenantId,
          projectIds: tenantId === "tenant-a" ? ["project-a"] : ["project-b"],
        },
      };
    },
  };
}

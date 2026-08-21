import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PublicApiClient } from "../../../apps/web-console/src/api/client.js";
import { MemoryTokenStore } from "../../../apps/web-console/src/auth/memory-token-store.js";
import { dockerAvailable } from "../../helpers/docker-container.js";
import { setupServerFixture, type ServerFixture } from "../../helpers/server-fixture.js";

if (!dockerAvailable()) {
  throw new Error("DockerUnavailable: Web Console Target/Test Plan E2E requires Docker.");
}

describe("Web Console Target to Test Plan to Mission acceptance", () => {
  let fx: ServerFixture;
  let client: PublicApiClient;

  beforeAll(async () => {
    fx = await setupServerFixture();
    const tokens = new MemoryTokenStore();
    tokens.set({
      subject: "acceptance-tester",
      tenantId: "tenant-a",
      roles: ["tester"],
      accessToken: fx.token("tenant-a", ["tester"]),
      expiresAtMs: Date.now() + 3_600_000,
    });
    client = new PublicApiClient({ baseUrl: fx.baseUrl, accessToken: () => tokens.accessToken() });
  }, 180_000);

  afterAll(async () => {
    await fx?.stop();
  });

  it("creates immutable approved inputs and a provenance-bound Mission", async () => {
    await client.createProject({ name: "Checkout acceptance" }, { idempotencyKey: "acceptance-project" });
    const target = await client.createTarget("acceptance-project", {
      targetId: "acceptance-target",
      displayName: "Checkout Web",
      runnerId: "acceptance-runner",
      expectedVersion: 0,
      configuration: {
        kind: "web",
        startUrl: "https://shop.example.test/checkout",
        allowedOrigins: ["https://shop.example.test"],
        browser: "chromium",
      },
    }, { idempotencyKey: "acceptance-target-create" });

    const content = "The checkout page shows the total.";
    const prd = await client.ingestPrd(
      "acceptance-project",
      { title: "Checkout", content },
      { idempotencyKey: "acceptance-prd" },
    );
    const sourceRef = {
      prdId: prd.resource.prdId,
      revision: prd.resource.revision,
      startOffset: 0,
      endOffset: content.length,
      quotedTextSha256: createHash("sha256").update(content).digest("hex"),
    };
    const draft = await client.createTestPlan({
      projectId: "acceptance-project",
      prdId: prd.resource.prdId,
      prdRevision: prd.resource.revision,
      sourceContentSha256: prd.resource.contentSha256,
      expectedClaims: [{ semanticKey: "checkout.total", statement: content, sourceRefs: [sourceRef], confidence: 1 }],
      testCases: [{ title: "Checkout total", objective: "Verify checkout total", preconditions: [], steps: [{ kind: "verify", claimSemanticKeys: ["checkout.total"] }], expectedClaimSemanticKeys: ["checkout.total"], sourceRefs: [sourceRef], priority: "high" }],
    }, { idempotencyKey: "acceptance-plan" });
    const approved = await client.approveTestPlan(
      draft.resource.planId,
      { expectedVersion: draft.resource.version },
      { idempotencyKey: "acceptance-plan-approve" },
    );
    const mission = await client.createMission({
      projectId: "acceptance-project",
      targetId: target.resource.targetId,
      targetVersion: target.resource.version,
      targetSnapshotHash: target.resource.snapshotHash,
      planId: approved.resource.planId,
      planVersion: approved.resource.version,
    }, { idempotencyKey: "acceptance-mission" });

    expect(mission.resource).toMatchObject({
      projectId: "acceptance-project",
      targetId: "acceptance-target",
      targetVersion: 1,
      targetSnapshotHash: target.resource.snapshotHash,
      runnerId: "acceptance-runner",
      planId: approved.resource.planId,
      planVersion: 2,
      status: "approved",
    });
    expect(await client.getMission(mission.resource.missionId)).toEqual(mission.resource);
  });
});

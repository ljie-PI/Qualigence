import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join, normalize } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalArtifactStore } from "@qualigence/artifact-fs";
import { ARTIFACT_CHUNK_SIZE_BYTES } from "@qualigence/runner-protocol";
import { PostgresSkillStore } from "@qualigence/postgres-runtime";
import { bundlePayloadContentSha256, REQUIRED_REPLAY_ORACLES, type ProcedureSkillVersion, type SignedSkillBundle, type SkillEvaluation } from "@qualigence/skill";
import type { RecordingSession } from "@qualigence/recording";
import { PlaywrightBrowserSession, type BrowserLauncher } from "@qualigence/web-playwright/internal";
import playwright from "../../../packages/target-adapters/web-playwright/node_modules/playwright/index.js";
import { requireInfrastructure } from "../../helpers/infrastructure-preflight.js";
import { createTestJwtIssuer, startTestOidcProvider, type TestOidcProvider } from "../../helpers/oidc-jwt.js";
import { setupServerFixture, type ServerFixture } from "../../helpers/server-fixture.js";

const execFileAsync = promisify(execFile);

/**
 * The rendered acceptance uses the production Vite dist, a real Fastify server,
 * and Authorization Code + PKCE rather than a Console API client or browser
 * fetch substitute. It intentionally fails (rather than skips) without Docker,
 * OpenSSL, or Chromium.
 */
describe("rendered Web Console browser workflow", () => {
  let fixture: ServerFixture | undefined;
  let oidc: TestOidcProvider | undefined;
  let proxy: Server | undefined;
  let consoleUrl = "";
  let browser: PlaywrightBrowserSession | undefined;
  let secondBrowser: PlaywrightBrowserSession | undefined;
  const browserErrors: string[] = [];
  const proxyAudit: Array<{ readonly method: string; readonly path: string; readonly outcome: "forwarded" | "before-timeout" | "after-timeout" }> = [];
  const dispatchControl: ConsoleProxyDispatchControl = { mode: "normal", audit: proxyAudit };

  beforeAll(async () => {
    requireInfrastructure(["chromium", "openssl", "docker"]);
    await buildConsoleDist();
    proxy = await startConsoleProxy(() => ({
      apiBaseUrl: `${consoleUrl}/api`,
      authMode: "oidc",
      oidc: oidc === undefined ? {} : {
        issuer: oidc.issuer,
        authorizationEndpoint: oidc.authorizationEndpoint,
        tokenEndpoint: oidc.tokenEndpoint,
        jwksUri: oidc.jwksUri,
        clientId: "qualigence-console",
        redirectUri: `${consoleUrl}/auth/callback`,
        allowedAlgorithms: ["RS256"],
        allowedTenants: ["tenant-a"],
      },
    }), () => fixture?.baseUrl, dispatchControl);
    consoleUrl = serverUrl(proxy);
    const jwt = createTestJwtIssuer();
    oidc = await startTestOidcProvider({
      redirectUri: `${consoleUrl}/auth/callback`,
      clientId: "qualigence-console",
      tenantId: "tenant-a",
      roles: ["qa-admin"],
      jwt,
      issueAccessToken: (subject) => fixture!.token("tenant-a", ["admin"], { sub: subject }),
    });
    fixture = await setupServerFixture({ oidc: { issuer: oidc.issuer, jwt } });
    await seedReviewTask(fixture, { tenantId: "tenant-a", taskId: "browser-review", caseId: "browser-case" });
    await seedVerifiedSkill(fixture, { tenantId: "tenant-a", skillId: "browser-skill" });
    await seedEvidenceArtifact(fixture, {
      tenantId: "tenant-a", projectId: "browser-evidence-project", runId: "browser-evidence-run", artifactId: "browser-evidence-artifact", bytes: new TextEncoder().encode("browser-authorized-artifact"),
    });
    await seedEvidenceArtifact(fixture, {
      tenantId: "tenant-b", projectId: "tenant-b-evidence-project", runId: "tenant-b-evidence-run", artifactId: "tenant-b-evidence-artifact", bytes: new TextEncoder().encode("tenant-b-secret-artifact"),
    });
    const launcher: BrowserLauncher = {
      launch: (options) => playwright.chromium.launch({ ...options, args: ["--ignore-certificate-errors"] }),
    };
    browser = new PlaywrightBrowserSession({
      url: consoleUrl,
      expectedOrigin: consoleUrl,
      allowedOrigins: [consoleUrl],
      actionTimeoutMs: 20_000,
      navigationTimeoutMs: 20_000,
      headed: false,
    }, launcher);
    await browser.start();
    await browser.withPage(async (page) => {
      page.on("pageerror", (error) => browserErrors.push(error.message));
      await page.reload({ waitUntil: "domcontentloaded" });
    });
  }, 240_000);

  afterAll(async () => {
    await secondBrowser?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await closeServer(proxy);
    await oidc?.stop().catch(() => undefined);
    await fixture?.stop().catch(() => undefined);
  });

  it("clicks SSO then creates Project, PRD, Test Plan, Mission, and Run through visible controls", async () => {
    await browser!.withPage(async (page) => {
      try {
        await page.getByRole("button", { name: "Sign in with SSO" }).waitFor();
      } catch {
        throw new Error(`Console did not render: ${browserErrors.join(" | ")}`);
      }
      await page.getByRole("button", { name: "Sign in with SSO" }).click();
      try {
        await page.getByRole("heading", { name: "Projects" }).waitFor();
      } catch {
        throw new Error(`Console did not render after OIDC callback: ${browserErrors.join(" | ")}`);
      }
      expect(page.url()).toBe(`${consoleUrl}/projects`);
      expect(await page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) }))).toMatchObject({ local: [] });

      await page.getByLabel("New project name").fill("Browser journey");
      await page.getByRole("button", { name: "Create" }).click();
      await page.getByRole("link", { name: "Browser journey" }).click();
      await page.getByLabel("Target ID").fill("browser-target");
      await page.getByLabel("Target name").fill("Browser target");
      await page.getByLabel("Runner ID").fill("browser-runner");
      await page.getByRole("button", { name: "Create Target revision" }).click();
      await page.getByLabel("PRD title").fill("Browser requirements");
      const requirement = "Customers can complete checkout.";
      await page.getByLabel("PRD content").fill(requirement);
      await page.getByRole("button", { name: "Ingest PRD" }).click();
      await page.getByRole("link", { name: "r1: Browser requirements" }).click();

      const prdId = await page.locator("dt", { hasText: "PRD ID" }).locator("..").locator("dd").textContent();
      expect(prdId).toMatch(/^[0-9a-f-]{36}$/i);
      if (prdId === null) throw new Error("Rendered PRD ID is missing");
      const sourceRef = { prdId, revision: 1, startOffset: 0, endOffset: requirement.length, quotedTextSha256: createHash("sha256").update(requirement).digest("hex") };
      await page.getByLabel("Grounded Test Plan proposal JSON").fill(JSON.stringify({
        expectedClaims: [{ semanticKey: "checkout", statement: requirement, sourceRefs: [sourceRef], confidence: 1 }],
        testCases: [{ title: "Checkout", objective: "Verify checkout", preconditions: [], steps: [{ kind: "verify", claimSemanticKeys: ["checkout"] }], expectedClaimSemanticKeys: ["checkout"], sourceRefs: [sourceRef], priority: "high" }],
      }));
      await page.getByRole("button", { name: "Create draft Test Plan" }).click();
      await page.getByRole("link", { name: "Review created Test Plan" }).click();
      await page.getByRole("button", { name: "Approve (v1)" }).click();
      await page.getByLabel("Approved Target revision").selectOption("browser-target");
      await page.getByRole("button", { name: "Create Mission from snapshots" }).click();
      await page.getByRole("link", { name: "Open created Mission" }).click();
      const missionId = (await page.getByRole("heading", { name: /^Mission / }).textContent())?.replace("Mission ", "");
      if (missionId === undefined || missionId.length === 0) throw new Error("Created Mission ID is missing from rendered UI");

      dispatchControl.mode = "before-timeout";
      const beforeTimeout = page.waitForResponse((response) => response.url().endsWith(`/api/v1/missions/${missionId}/start`) && response.status() === 504);
      await page.getByRole("button", { name: "Start Mission (v1)" }).click();
      await beforeTimeout;
      await page.getByRole("alert").waitFor();
      expect(proxyAudit.filter((entry) => entry.path.endsWith(`/missions/${missionId}/start`) && entry.outcome === "before-timeout")).toHaveLength(1);
      expect(proxyAudit.filter((entry) => entry.path.endsWith(`/missions/${missionId}/start`) && entry.outcome === "forwarded")).toHaveLength(0);

      dispatchControl.mode = "after-timeout";
      const afterTimeout = page.waitForResponse((response) => response.url().endsWith(`/api/v1/missions/${missionId}/start`) && response.status() === 504);
      await page.getByRole("button", { name: "Start Mission (v1)" }).click();
      await afterTimeout;
      await page.getByRole("alert").waitFor();
      expect(proxyAudit.filter((entry) => entry.path.endsWith(`/missions/${missionId}/start`) && entry.outcome === "after-timeout")).toHaveLength(1);
      dispatchControl.mode = "normal";
      // A fresh rendered session has no stale React-query cache. It visibly
      // reauthenticates and navigates to the authoritative Mission/Run read;
      // it never replays the unknown command.
      secondBrowser = createBrowserSession(consoleUrl);
      await secondBrowser.start();
      await secondBrowser.withPage(async (reconciliationPage) => {
        await reconciliationPage.getByRole("button", { name: "Sign in with SSO" }).click();
        await reconciliationPage.getByRole("heading", { name: "Projects" }).waitFor();
        await reconciliationPage.getByRole("link", { name: "Missions", exact: true }).click();
        await reconciliationPage.getByRole("link", { name: missionId }).click();
        const runLink = reconciliationPage.locator('a[href^="/runs/"]').first();
        await runLink.waitFor();
        expect(await reconciliationPage.locator('a[href^="/runs/"]').count()).toBe(1);
        await runLink.click();
        await reconciliationPage.getByRole("heading", { name: /^Run / }).waitFor();
        await reconciliationPage.getByText("running", { exact: true }).waitFor();
      });
      expect(proxyAudit.filter((entry) => entry.path.endsWith(`/missions/${missionId}/start`) && entry.outcome === "after-timeout")).toHaveLength(1);

      await page.getByRole("link", { name: "Reviews" }).click();
      await page.getByRole("link", { name: "browser-review" }).click();
      await page.getByRole("button", { name: "Claim" }).waitFor();

      await secondBrowser.withPage(async (secondPage) => {
        await secondPage.getByRole("link", { name: "Reviews" }).click();
        await secondPage.getByRole("link", { name: "browser-review" }).click();
        await secondPage.getByRole("button", { name: "Claim" }).click();
        await secondPage.getByText("claimed", { exact: true }).waitFor();
        await secondPage.getByText("browser-tester-2", { exact: true }).waitFor();
      });
      await page.getByRole("button", { name: "Claim" }).click();
      await page.getByRole("alert").filter({ hasText: "Already changed by another reviewer (now version 2)." }).waitFor();
      await page.getByText("browser-tester-2", { exact: true }).waitFor();

      await page.getByRole("link", { name: "Skills" }).click();
      await page.getByRole("link", { name: "browser-skill" }).click();
      await page.getByText("verified", { exact: true }).first().waitFor();
      await page.getByText("valid", { exact: true }).first().waitFor();
      await page.getByText("passed", { exact: true }).first().waitFor();
      await page.getByRole("button", { name: "Promote (v3)" }).click();
      const lifecycleState = page.locator(".definition-list__row")
        .filter({ has: page.getByText("Lifecycle state", { exact: true }) })
        .getByText("promoted", { exact: true });
      await lifecycleState.waitFor({ state: "visible" });
      await page.getByRole("button", { name: "Deprecate (v4)" }).click();
      await page.getByText("deprecated", { exact: true }).waitFor();
      await page.getByText("revoked", { exact: true }).waitFor();

      await page.getByRole("link", { name: "Missions" }).click();
      await page.getByRole("link", { name: "evidence-mission-browser-evidence-project" }).click();
      await page.getByRole("link", { name: "Artifact browser-evidence-artifact" }).click();
      await page.getByText("Authorized", { exact: true }).waitFor();
      const authorizedBytes = page.waitForResponse((response) => response.url().includes("/browser-evidence-artifact/bytes?") && response.status() === 200);
      await page.getByRole("button", { name: "Download authorized Artifact" }).click();
      expect((await authorizedBytes).headers()["content-length"]).toBe(String(Buffer.byteLength("browser-authorized-artifact")));
      await page.getByRole("link", { name: "Save authorized Artifact" }).waitFor();
      expect(await page.locator("body").textContent()).not.toContain("browser-authorized-artifact");

      const deniedResponse = page.waitForResponse((response) => response.url().includes("/tenant-b-evidence-project/runs/tenant-b-evidence-run/artifacts/tenant-b-evidence-artifact?") && response.status() === 404);
      // The existing SPA link/navigation seam keeps the authenticated in-memory
      // session, allowing the real cross-tenant Public API denial to render.
      await navigateConsoleRoute(page, "/projects/tenant-b-evidence-project/runs/tenant-b-evidence-run/artifacts/tenant-b-evidence-artifact");
      await page.getByRole("alert").filter({ hasText: "Artifact is unavailable." }).waitFor();
      expect(await (await deniedResponse).text()).not.toContain("tenant-b-secret-artifact");
      expect(await page.locator("body").textContent()).not.toContain("tenant-b-secret-artifact");

      // A hard browser navigation deliberately cannot retain an authorization
      // token: it safely returns to Login and exposes no Artifact plaintext.
      await secondBrowser!.withPage(async (hardReloadPage) => {
        await hardReloadPage.goto(`${consoleUrl}/projects/tenant-b-evidence-project/runs/tenant-b-evidence-run/artifacts/tenant-b-evidence-artifact`);
        await hardReloadPage.getByRole("button", { name: "Sign in with SSO" }).waitFor();
        expect(await hardReloadPage.locator("body").textContent()).not.toContain("tenant-b-secret-artifact");
        expect(await hardReloadPage.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) }))).toEqual({ local: [], session: [] });
      });
    });
  }, 120_000);

  it.each(["invalid-signature", "invalid-nonce", "invalid-tenant", "invalid-role"] as const)("fails %s OIDC visibly without browser storage or protected mutation", async (mode) => {
    const invalidBrowser = createBrowserSession(consoleUrl);
    oidc!.setTokenMode(mode);
    const protectedMutationsBefore = proxyAudit.filter((entry) => entry.path.startsWith("/api/") && entry.method !== "GET" && entry.method !== "HEAD").length;
    const auditBefore = oidc!.audit.length;
    try {
      await invalidBrowser.start();
      await invalidBrowser.withPage(async (page) => {
        await page.getByRole("button", { name: "Sign in with SSO" }).click();
        await waitForIssuerAudit(() => oidc!.audit.length > auditBefore);
        await page.getByRole("button", { name: "Sign in with SSO" }).waitFor();
        expect(page.url()).toBe(`${consoleUrl}/auth/callback`);
        expect(await page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) }))).toEqual({ local: [], session: [] });
      });
      expect(oidc!.audit.slice(auditBefore)).toEqual(expect.arrayContaining([
        { event: "authorize", mode, outcome: "issued" },
        { event: "token", mode, outcome: "issued" },
      ]));
      expect(proxyAudit.filter((entry) => entry.path.startsWith("/api/") && entry.method !== "GET" && entry.method !== "HEAD").length).toBe(protectedMutationsBefore);
    } finally {
      oidc!.setTokenMode("valid");
      await invalidBrowser.close().catch(() => undefined);
    }
  }, 60_000);
});

function createBrowserSession(consoleUrl: string): PlaywrightBrowserSession {
  const launcher: BrowserLauncher = {
    launch: (options) => playwright.chromium.launch({ ...options, args: ["--ignore-certificate-errors"] }),
  };
  return new PlaywrightBrowserSession({
    url: consoleUrl,
    expectedOrigin: consoleUrl,
    allowedOrigins: [consoleUrl],
    actionTimeoutMs: 20_000,
    navigationTimeoutMs: 20_000,
    headed: false,
  }, launcher);
}

async function seedReviewTask(fixture: ServerFixture, input: { readonly tenantId: string; readonly taskId: string; readonly caseId: string }): Promise<void> {
  await fixture.provider.withTenant(input.tenantId, async ({ db }) => {
    await db.insertInto("review_tasks").values({
      tenant_id: input.tenantId, task_id: input.taskId, case_id: input.caseId,
      status: "open", reason: "browser review", priority: "high", evidence_completeness: "limited",
      assignee_id: null, version: 1, created_at: "2026-08-28T00:00:00.000Z", updated_at: "2026-08-28T00:00:00.000Z",
    } as never).execute();
  });
}

const skillRecording: RecordingSession = {
  recordingId: "browser-skill-rec", projectId: "browser-skill-project", targetId: "browser-skill-target", targetVersion: "1",
  observationSchemaEpoch: "pre-v1", startedAt: "2026-08-28T00:00:00.000Z", completedAt: "2026-08-28T00:01:00.000Z",
  steps: [{ ordinal: 1, beforeGraphRef: "browser-graph-before", intent: { kind: "click", target: { purpose: "save" } }, resolvedNode: { role: "button", name: "Save", purpose: "save", sourceNodeId: "browser-node-save" }, outcome: { status: "ok" }, afterGraphRef: "browser-graph-after", checkpoint: { requiredClaims: ["saved"], stateFingerprint: "browser-fingerprint" } }],
  sourceTraceRefs: ["browser-skill-run"],
};

function skillVersion(skillId: string, version: number, state: ProcedureSkillVersion["state"]): ProcedureSkillVersion {
  const base: ProcedureSkillVersion = {
    skillId, version, state, projectId: skillRecording.projectId,
    targetScope: { targetId: skillRecording.targetId, allowedOrigins: ["https://example.test"] },
    parameters: [],
    steps: [{ stepId: "browser-step", intent: { kind: "click", target: { purpose: "save" } }, preconditions: [], checkpoint: [{ kind: "claim_satisfied", claimId: "saved" }], recovery: "stop", sourceNodeId: "browser-node-save" }],
    sourceRecordingIds: [skillRecording.recordingId], observationSchemaEpoch: "pre-v1", locatorSchemaVersion: "semantic-locator/v1", compilerVersion: "skill-compiler/v1", contentSha256: "uncomputed",
  };
  return { ...base, contentSha256: bundlePayloadContentSha256(base) };
}

async function seedVerifiedSkill(fixture: ServerFixture, input: { readonly tenantId: string; readonly skillId: string }): Promise<void> {
  await fixture.provider.withTenant(input.tenantId, async ({ db }) => {
    const store = new PostgresSkillStore(db, input.tenantId);
    await store.saveRecording(skillRecording);
    await store.saveSkillVersion({ version: skillVersion(input.skillId, 1, "draft"), expectedVersion: 0, sourceRecording: skillRecording });
    await store.saveSkillVersion({ version: skillVersion(input.skillId, 2, "candidate"), expectedVersion: 1, sourceRecording: skillRecording });
    const verified = skillVersion(input.skillId, 3, "verified");
    await store.saveSkillVersion({ version: verified, expectedVersion: 2, sourceRecording: skillRecording });
    const oracles = REQUIRED_REPLAY_ORACLES.map((oracle) => ({ oracle, status: "passed" as const }));
    const [firstOracle, ...remainingOracles] = oracles;
    if (firstOracle === undefined) throw new Error("Skill promotion requires at least one replay oracle");
    const evaluation: SkillEvaluation = { evaluationId: `${input.skillId}-evaluation`, skillId: input.skillId, skillVersion: 3, oracles: [firstOracle, ...remainingOracles], outcome: "passed", signatureValid: true, createdAt: "2026-08-28T00:02:00.000Z" };
    const bundle: SignedSkillBundle = await fixture.skillSigner.sign({ bundleId: `${input.skillId}-bundle`, skillId: input.skillId, skillVersion: 3, schemaVersion: "skill-bundle/v1", compilerVersion: verified.compilerVersion, contentSha256: verified.contentSha256, signerKeyId: fixture.skillSigner.keyId, signatureAlgorithm: "Ed25519", issuedAt: "2026-08-28T00:03:00.000Z", payload: verified });
    await store.saveEvaluation(evaluation);
    await store.saveBundle(bundle);
  });
}

async function seedEvidenceArtifact(fixture: ServerFixture, input: { readonly tenantId: string; readonly projectId: string; readonly runId: string; readonly artifactId: string; readonly bytes: Uint8Array }): Promise<void> {
  const store = new LocalArtifactStore(join(fixture.artifactDataDir, input.tenantId, input.projectId), { now: () => "2026-08-28T00:00:03.000Z" });
  const manifest = await store.write({ artifactId: input.artifactId, runId: input.runId, name: `${input.artifactId}.txt`, kind: "log", mediaType: "text/plain", bytes: input.bytes });
  const caseId = `browser-evidence-case-${input.projectId}`;
  const profile = await fixture.evidenceKms.encryptionProfile({ tenantId: input.tenantId, caseId, region: "self-hosted", purpose: "investigation" });
  const protectedHeader = { schemaVersion: profile.aadSchemaVersion, capsuleId: input.artifactId, profileId: profile.profileId, payloadSchemaVersion: "evidence-capsule/v1", tenantId: input.tenantId, caseId, recipient: profile.recipient, region: profile.region, purpose: profile.purpose, policyId: profile.policyId, contentEncryptionAlgorithm: profile.contentEncryptionAlgorithm, keyWrappingAlgorithm: profile.keyWrappingAlgorithm, wrappingKeyId: profile.wrappingKeyId, plaintextSha256: manifest.sha256, plaintextBytes: manifest.size, createdAt: manifest.createdAt, expiresAt: profile.expiresAt };
  const missionId = `evidence-mission-${input.projectId}`;
  const binding = { targetId: `evidence-target-${input.projectId}`, targetVersion: 1, targetSnapshotHash: `evidence-target-snapshot-${input.projectId}`, runnerId: `runner-${input.projectId}`, planVersion: 1, planSnapshotHash: `evidence-plan-snapshot-${input.projectId}`, configuration: { kind: "web", startUrl: "https://example.test/", allowedOrigins: ["https://example.test"], browser: "chromium" } };
  const dispatch = { targetUrl: "https://example.test/", modelProfileId: "default", headed: false, navigationTimeoutMs: 30_000, actionTimeoutMs: 10_000, binding };
  const compiled = { missionId, missionRevision: 1, projectId: input.projectId, planId: `evidence-plan-${input.projectId}`, planVersion: 1, planSnapshotHash: binding.planSnapshotHash, targetId: binding.targetId, targetVersion: binding.targetVersion, targetSnapshotHash: binding.targetSnapshotHash, executionPolicy: { policyId: "browser-evidence-policy", environment: "isolated_test", allowedOrigins: ["https://example.test"], allowedActionKinds: ["click"], maximumRisk: "Normal", explorationAllowed: false, issuedAt: "2026-08-28T00:00:00.000Z", expiresAt: "2026-08-28T00:00:30.000Z" }, jobs: [], compiledHash: `evidence-compiled-${input.projectId}` };
  await fixture.provider.withTenant(input.tenantId, async ({ db }) => {
    await db.insertInto("missions").values({ tenant_id: input.tenantId, mission_id: missionId, revision: 1, project_id: input.projectId, plan_id: `evidence-plan-${input.projectId}`, prd_id: `evidence-prd-${input.projectId}`, prd_revision: 1, target_id: binding.targetId, compiled_hash: compiled.compiledHash, status: "running", dispatch_json: JSON.stringify(dispatch), stop_on_blocked: 1 } as never).execute();
    await db.insertInto("mission_revisions").values({ tenant_id: input.tenantId, mission_id: missionId, revision: 1, compiled_json: JSON.stringify(compiled), created_at: manifest.createdAt } as never).execute();
    await db.insertInto("mission_scheduling_heads").values({ tenant_id: input.tenantId, mission_id: missionId, mission_revision: 1, version: 1, compiled_hash: compiled.compiledHash } as never).execute();
    await db.insertInto("execution_jobs").values({ tenant_id: input.tenantId, job_id: `evidence-logical-${input.projectId}`, mission_id: `evidence-mission-${input.projectId}`, mission_revision: 1, test_case_id: caseId, objective: "Browser Evidence API read", required_capabilities_json: "[]", source_refs_json: "[]", snapshot_hash: `evidence-snapshot-${input.projectId}`, snapshot_json: "{}", idempotency_key: `evidence-logical-${input.projectId}`, status: "queued" } as never).execute();
    await db.insertInto("execution_runs").values({ tenant_id: input.tenantId, run_id: input.runId, job_id: `evidence-runner-job-${input.projectId}`, target_kind: "web", objective: "Browser Evidence API read", status: "running", next_sequence_number: 1, created_at: "2026-08-28T00:00:00.000Z", completed_at: null, error_code: null } as never).execute();
    await db.insertInto("mission_job_attempts").values({ tenant_id: input.tenantId, attempt_id: `evidence-attempt-${input.projectId}`, mission_id: `evidence-mission-${input.projectId}`, mission_revision: 1, logical_job_id: `evidence-logical-${input.projectId}`, runner_job_id: `evidence-runner-job-${input.projectId}`, run_id: input.runId, status: "accepted", created_at: "2026-08-28T00:00:00.000Z" } as never).execute();
    await db.insertInto("artifact_manifests").values({ tenant_id: input.tenantId, artifact_id: manifest.artifactId, run_id: manifest.runId, kind: manifest.kind, media_type: manifest.mediaType, relative_path: manifest.relativePath, sha256: manifest.sha256, size_bytes: manifest.size, created_at: manifest.createdAt } as never).execute();
    await db.insertInto("artifact_upload_manifests").values({ tenant_id: input.tenantId, artifact_id: manifest.artifactId, project_id: input.projectId, run_id: manifest.runId, job_id: `evidence-runner-job-${input.projectId}`, size_bytes: manifest.size, sha256: manifest.sha256, media_type: manifest.mediaType, sensitivity: "sensitive", chunk_size_bytes: ARTIFACT_CHUNK_SIZE_BYTES, total_chunks: Math.ceil(manifest.size / ARTIFACT_CHUNK_SIZE_BYTES), registered_by_runner_id: `runner-${input.projectId}`, registered_lease_epoch: 1, status: "verified", relative_path: manifest.relativePath, created_at: manifest.createdAt, verified_at: manifest.createdAt } as never).execute();
    await db.insertInto("evidence_encryption_profiles").values({ tenant_id: input.tenantId, profile_id: profile.profileId, case_id: profile.caseId, recipient: profile.recipient, region: profile.region, purpose: profile.purpose, policy_id: profile.policyId, wrapping_key_id: profile.wrappingKeyId, wrapping_public_key_pem: profile.wrappingPublicKeyPem, content_encryption_algorithm: profile.contentEncryptionAlgorithm, key_wrapping_algorithm: profile.keyWrappingAlgorithm, aad_schema_version: profile.aadSchemaVersion, allowed_entry_kinds_json: JSON.stringify(profile.allowedEntryKinds), maximum_entry_bytes: profile.maximumEntryBytes, maximum_plaintext_bytes: profile.maximumPlaintextBytes, maximum_ciphertext_bytes: profile.maximumCiphertextBytes, expires_at: profile.expiresAt, created_at: manifest.createdAt } as never).execute();
    await db.insertInto("evidence_capsule_manifests").values({ tenant_id: input.tenantId, capsule_id: input.artifactId, revision: 1, parent_revision: null, profile_id: profile.profileId, payload_schema_version: "evidence-capsule/v1", aad_schema_version: profile.aadSchemaVersion, case_id: caseId, recipient: profile.recipient, region: profile.region, purpose: profile.purpose, policy_id: profile.policyId, content_encryption_algorithm: profile.contentEncryptionAlgorithm, key_wrapping_algorithm: profile.keyWrappingAlgorithm, wrapping_key_id: profile.wrappingKeyId, plaintext_sha256: manifest.sha256, plaintext_bytes: manifest.size, ciphertext_sha256: manifest.sha256, ciphertext_bytes: manifest.size, ciphertext: Buffer.from(input.bytes), wrapped_dek_base64: "test-wrapped-dek", nonce_base64: "test-nonce", auth_tag_base64: "test-tag", protected_header_json: JSON.stringify(protectedHeader), revocation_state: "active", revoked_at: null, revoked_reason: null, lifecycle_state: "active", lifecycle_updated_at: manifest.createdAt, deleted_at: null, last_lifecycle_error: null, created_at: manifest.createdAt, expires_at: profile.expiresAt } as never).execute();
  });
}

async function navigateConsoleRoute(page: { evaluate<T, Arg>(pageFunction: (arg: Arg) => T | Promise<T>, arg: Arg): Promise<T> }, path: string): Promise<void> {
  await page.evaluate((route) => {
    const browser = globalThis as unknown as {
      readonly history: { pushState(data: unknown, unused: string, url?: string): void };
      readonly PopStateEvent: new (type: string) => object;
      dispatchEvent(event: object): boolean;
    };
    browser.history.pushState(null, "", route);
    browser.dispatchEvent(new browser.PopStateEvent("popstate"));
  }, path);
}

interface ConsoleProxyDispatchControl {
  mode: "normal" | "before-timeout" | "after-timeout";
  readonly audit: Array<{ readonly method: string; readonly path: string; readonly outcome: "forwarded" | "before-timeout" | "after-timeout" }>;
}

async function waitForIssuerAudit(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("TestOidcIssuerAuditTimeout");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function buildConsoleDist(): Promise<void> {
  if (process.platform === "win32") {
    await execFileAsync("cmd.exe", ["/d", "/s", "/c", "corepack pnpm --filter @qualigence/web-console run build"], { timeout: 120_000 });
    return;
  }
  await execFileAsync("corepack", ["pnpm", "--filter", "@qualigence/web-console", "run", "build"], { timeout: 120_000 });
}

async function startConsoleProxy(
  config: () => Record<string, unknown>,
  apiBaseUrl: () => string | undefined,
  dispatch: ConsoleProxyDispatchControl,
): Promise<Server> {
  const dist = join(process.cwd(), "apps/web-console/dist");
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path === "/runtime-config.js") {
      response.writeHead(200, { "content-type": "application/javascript", "cache-control": "no-store" }).end(`window.__QUALIGENCE_CONFIG__=${JSON.stringify(config()).replace(/</g, "\\u003c")};`);
      return;
    }
    if (path === "/api" || path.startsWith("/api/")) {
      const upstream = apiBaseUrl();
      if (upstream === undefined) return response.writeHead(503).end();
      const method = request.method ?? "GET";
      const isMissionStart = method === "POST" && /^\/api\/v1\/missions\/[^/]+\/start$/.test(path);
      if (isMissionStart && dispatch.mode === "before-timeout") {
        dispatch.audit.push({ method, path, outcome: "before-timeout" });
        response.writeHead(504, { "content-type": "application/json" }).end(JSON.stringify({ code: "GatewayTimeout", safeMessage: "Mission start timed out safely.", correlationId: "test-proxy-timeout" }));
        return;
      }
      const target = `${upstream}${path.slice(4)}${new URL(request.url ?? "/", "http://localhost").search}`;
      const headers = Object.fromEntries(Object.entries(request.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
      const init = method === "GET" || method === "HEAD"
        ? { method, headers }
        // Node's fetch requires duplex mode when proxying a streamed request.
        : { method, headers, body: request, duplex: "half" as const };
      const upstreamResponse = await fetch(target, init);
      const body = Buffer.from(await upstreamResponse.arrayBuffer());
      if (isMissionStart && dispatch.mode === "after-timeout") {
        dispatch.audit.push({ method, path, outcome: "after-timeout" });
        response.writeHead(504, { "content-type": "application/json" }).end(JSON.stringify({ code: "GatewayTimeout", safeMessage: "Mission start timed out safely.", correlationId: "test-proxy-timeout" }));
        return;
      }
      dispatch.audit.push({ method, path, outcome: "forwarded" });
      response.writeHead(upstreamResponse.status, Object.fromEntries(upstreamResponse.headers));
      response.end(body);
      return;
    }
    const requested = path === "/" || !path.split("/").at(-1)?.includes(".") ? "index.html" : normalize(path).replace(/^[/\\]+/, "");
    try {
      const body = await readFile(join(dist, requested));
      if (requested === "index.html") {
        const runtimeConfig = config();
        const oidc = runtimeConfig.oidc;
        const oidcIssuer = typeof oidc === "object" && oidc !== null && typeof (oidc as { issuer?: unknown }).issuer === "string"
          ? new URL((oidc as { issuer: string }).issuer).origin
          : "'self'";
        const csp = `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ${oidcIssuer}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`;
        const html = body.toString("utf8")
          .replace(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/, "")
          .replace("</head>", `<meta http-equiv="Content-Security-Policy" content="${csp}"><script src="/runtime-config.js"></script></head>`);
        response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" }).end(html);
      } else {
        const contentType = requested.endsWith(".js") ? "application/javascript" : requested.endsWith(".css") ? "text/css" : "application/octet-stream";
        response.writeHead(200, { "content-type": contentType }).end(body);
      }
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return server;
}

function serverUrl(server: Server): string {
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("Console proxy did not bind a TCP address");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (server === undefined) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))).catch(() => undefined);
}

// @vitest-environment jsdom
// @ts-expect-error the root test project does not own the Console's React types
import { createElement } from "../../../apps/web-console/node_modules/react/index.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "../../../apps/web-console/node_modules/@tanstack/react-query/build/modern/index.js";
import { RouterProvider } from "../../../apps/web-console/node_modules/@tanstack/react-router/dist/esm/index.js";
// @ts-expect-error the root test project does not own the Console's Testing Library types
import { cleanup, render, screen, waitFor, within } from "../../../apps/web-console/node_modules/@testing-library/react/dist/@testing-library/react.esm.js";
// @ts-expect-error the root test project does not own the Console's user-event types
import userEvent from "../../../apps/web-console/node_modules/@testing-library/user-event/dist/esm/index.js";
import { PublicApiClient } from "../../../apps/web-console/src/api/client.js";
// @ts-expect-error the root test project does not compile Console JSX
import { ConsoleServicesProvider } from "../../../apps/web-console/src/auth/session-context.js";
import { MemoryTokenStore } from "../../../apps/web-console/src/auth/memory-token-store.js";
// @ts-expect-error the root test project does not compile Console JSX
import { router } from "../../../apps/web-console/src/routes/router.js";
import { PostgresSkillStore } from "@qualigence/postgres-runtime";
import { bundlePayloadContentSha256, REQUIRED_REPLAY_ORACLES, type ProcedureSkillVersion, type SkillEvaluation, type SignedSkillBundle } from "@qualigence/skill";
import type { RecordingSession } from "@qualigence/recording";
import { dockerAvailable } from "../../helpers/docker-container.js";
import { setupServerFixture, type ServerFixture } from "../../helpers/server-fixture.js";

if (!dockerAvailable()) {
  throw new Error("DockerUnavailable: Web Console Skill lifecycle E2E requires Docker.");
}

(globalThis as unknown as { window: { scrollTo: () => void } }).window.scrollTo = vi.fn();

describe("rendered Web Console Skill lifecycle acceptance", () => {
  let fx: ServerFixture;
  let client: PublicApiClient;
  let queryClient: QueryClient;

  beforeAll(async () => {
    fx = await setupServerFixture();
    await seedVerifiedSkill(fx, "skill-e2e");
    await seedVerifiedSkill(fx, "skill-e2e-deprecate");
    const tokens = new MemoryTokenStore();
    tokens.set({ subject: "skill-tester", tenantId: "tenant-a", roles: ["tester"], accessToken: fx.token("tenant-a", ["tester"]), expiresAtMs: Date.now() + 3_600_000 });
    client = new PublicApiClient({ baseUrl: fx.baseUrl, accessToken: () => tokens.accessToken() });
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 5_000 } } });
    await router.navigate({ to: "/skills/$skillId", params: { skillId: "skill-e2e" } });
    render(createElement(QueryClientProvider, { client: queryClient }, createElement(ConsoleServicesProvider, { services: { tokens, api: client, queryClient, oidc: {}, config: {} } as never }, createElement(RouterProvider, { router }))));
  }, 180_000);

  afterAll(async () => {
    cleanup();
    queryClient?.clear();
    await fx?.stop();
  });

  it("renders versions, observes promotion conflict, and deprecates the Skill", async () => {
    const user = userEvent.setup();
    expect(await screen.findByRole("heading", { name: "Skill skill-e2e" })).toBeTruthy();
    expect(await screen.findByText("verified")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Promote (v3)" })).toBeTruthy();
    expect(screen.getByText("valid")).toBeTruthy();

    await client.promoteSkill("skill-e2e", { expectedVersion: 3 }, { idempotencyKey: "skill-e2e-competing-promote" });
    await user.click(screen.getByRole("button", { name: "Promote (v3)" }));
    expect((await screen.findByRole("alert")).textContent).toContain("VersionConflict");

    await router.navigate({ to: "/skills/$skillId", params: { skillId: "skill-e2e-deprecate" } });
    expect(await screen.findByRole("heading", { name: "Skill skill-e2e-deprecate" })).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("button", { name: "Deprecate (v3)" })).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "Deprecate (v3)" }));
    await waitFor(() => expect(screen.getAllByText("deprecated").length).toBeGreaterThan(0));
    expect(screen.getByText("revoked")).toBeTruthy();
  }, 60_000);
});

const recording: RecordingSession = { recordingId: "skill-e2e-rec", projectId: "skill-project", targetId: "skill-target", targetVersion: "1", observationSchemaEpoch: "pre-v1", startedAt: "2026-08-01T00:00:00.000Z", completedAt: "2026-08-01T00:01:00.000Z", steps: [{ ordinal: 1, beforeGraphRef: "graph-a", intent: { kind: "click", target: { purpose: "save" } }, resolvedNode: { role: "button", name: "Save", purpose: "save", sourceNodeId: "node-save" }, outcome: { status: "ok" }, afterGraphRef: "graph-b", checkpoint: { requiredClaims: ["saved"], stateFingerprint: "fp" } }], sourceTraceRefs: ["run-skill"] };

function skillVersion(skillId: string, version: number, state: ProcedureSkillVersion["state"]): ProcedureSkillVersion {
  const base: ProcedureSkillVersion = { skillId, version, state, projectId: "skill-project", targetScope: { targetId: "skill-target", allowedOrigins: ["https://example.test"] }, parameters: [], steps: [{ stepId: "step-1", intent: { kind: "click", target: { purpose: "save" } }, preconditions: [], checkpoint: [{ kind: "claim_satisfied", claimId: "saved" }], recovery: "stop", sourceNodeId: "node-save" }], sourceRecordingIds: [recording.recordingId], observationSchemaEpoch: "pre-v1", locatorSchemaVersion: "semantic-locator/v1", compilerVersion: "skill-compiler/v1", contentSha256: "will-be-overwritten" };
  return { ...base, contentSha256: bundlePayloadContentSha256(base) };
}

async function seedVerifiedSkill(fx: ServerFixture, skillId: string): Promise<void> {
  await fx.provider.withTenant("tenant-a", async ({ db }) => {
    const store = new PostgresSkillStore(db, "tenant-a");
    await store.saveRecording(recording);
    await store.saveSkillVersion({ version: skillVersion(skillId, 1, "draft"), expectedVersion: 0, sourceRecording: recording });
    await store.saveSkillVersion({ version: skillVersion(skillId, 2, "candidate"), expectedVersion: 1, sourceRecording: recording });
    const verified = skillVersion(skillId, 3, "verified");
    await store.saveSkillVersion({ version: verified, expectedVersion: 2, sourceRecording: recording });
    const evaluation: SkillEvaluation = { evaluationId: `${skillId}-eval`, skillId, skillVersion: 3, oracles: [{ oracle: REQUIRED_REPLAY_ORACLES[0] as string, status: "passed" }, ...REQUIRED_REPLAY_ORACLES.slice(1).map((oracle) => ({ oracle, status: "passed" as const }))], outcome: "passed", signatureValid: true, createdAt: "2026-08-01T00:02:00.000Z" };
    const bundle: SignedSkillBundle = await fx.skillSigner.sign({ bundleId: `${skillId}-bundle`, skillId, skillVersion: 3, schemaVersion: "skill-bundle/v1", compilerVersion: verified.compilerVersion, contentSha256: verified.contentSha256, signerKeyId: fx.skillSigner.keyId, signatureAlgorithm: "Ed25519", issuedAt: "2026-08-01T00:03:00.000Z", payload: verified });
    await store.saveEvaluation(evaluation);
    await store.saveBundle(bundle);
  });
}

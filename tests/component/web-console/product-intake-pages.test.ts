// @vitest-environment jsdom
// React is intentionally loaded from the Console's isolated dependency tree.
// @ts-expect-error the root test project does not own the Console's React types
import { createElement } from "../../../apps/web-console/node_modules/react/index.js";
// @ts-expect-error the root test project does not own the Console's React DOM types
import { renderToStaticMarkup } from "../../../apps/web-console/node_modules/react-dom/server.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "../../../apps/web-console/node_modules/@tanstack/react-query/build/modern/index.js";
import { RouterProvider } from "../../../apps/web-console/node_modules/@tanstack/react-router/dist/esm/index.js";
// @ts-expect-error the root test project does not own the Console's Testing Library types
import { cleanup, render, screen, waitFor } from "../../../apps/web-console/node_modules/@testing-library/react/dist/@testing-library/react.esm.js";
// @ts-expect-error the root test project does not own the Console's user-event types
import userEvent from "../../../apps/web-console/node_modules/@testing-library/user-event/dist/esm/index.js";
import { ApiClientError } from "../../../apps/web-console/src/api/errors.js";
// @ts-expect-error the root test project does not compile Console JSX
import { ConsoleServicesProvider } from "../../../apps/web-console/src/auth/session-context.js";
import { MemoryTokenStore } from "../../../apps/web-console/src/auth/memory-token-store.js";
// @ts-expect-error the root test project does not compile Console JSX
import { router } from "../../../apps/web-console/src/routes/router.js";
// @ts-expect-error the Console owns JSX compilation for its source modules
import { TargetRevisionSummary } from "../../../apps/web-console/src/features/projects/project-page.js";
// @ts-expect-error the Console owns JSX compilation for its source modules
import { TestPlanRevisionSummary } from "../../../apps/web-console/src/features/projects/prd-plan-page.js";
// @ts-expect-error the Console owns JSX compilation for its source modules
import { MissionRevisionSummary } from "../../../apps/web-console/src/features/missions/mission-page.js";
// @ts-expect-error the Console owns JSX compilation for its source modules
import { ArtifactPage } from "../../../apps/web-console/src/features/evidence/artifact-page.js";

afterEach(cleanup);
(globalThis as unknown as { window: { scrollTo: () => void } }).window.scrollTo = vi.fn();

const target = { targetId: "target-1", projectId: "project-1", kind: "web" as const, displayName: "Web", runnerId: "runner-1", version: 4, snapshotHash: "a".repeat(64), configuration: { kind: "web" as const, startUrl: "https://example.test/", allowedOrigins: ["https://example.test"], browser: "chromium" as const } };
const draftPlan = { planId: "plan-1", projectId: "project-1", prdId: "prd-1", prdRevision: 1, status: "draft" as const, version: 3, payload: { schemaVersion: "test-plan/v1" as const, testCases: [] } };
const approvedPlan = { ...draftPlan, status: "approved" as const };

function conflict(actualVersion: number): ApiClientError {
  return new ApiClientError(409, { code: "VersionConflict", safeMessage: "version conflict", correlationId: "correlation", details: { actualVersion } });
}

async function renderConsole(path: string, api: Record<string, unknown>) {
  const tokens = new MemoryTokenStore();
  tokens.set({ subject: "tester-1", tenantId: "tenant-1", roles: ["tester"], accessToken: "token", expiresAtMs: Date.now() + 60_000 });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const services = { tokens, api, queryClient, oidc: {}, config: {} } as never;
  await router.navigate({ to: path });
  return render(createElement(QueryClientProvider, { client: queryClient }, createElement(ConsoleServicesProvider, { services }, createElement(RouterProvider, { router }))));
}

describe("rendered product intake revisions", () => {
  it("renders Web and lossless Desktop Target snapshots", () => {
    const web = renderToStaticMarkup(createElement(TargetRevisionSummary, { target: { targetId: "web", projectId: "p", kind: "web", displayName: "Web", runnerId: "runner-web", version: 2, snapshotHash: "a".repeat(64), configuration: { kind: "web", startUrl: "https://example.test/", allowedOrigins: ["https://example.test"], browser: "chromium" } } }));
    const desktop = renderToStaticMarkup(createElement(TargetRevisionSummary, { target: { targetId: "desktop", projectId: "p", kind: "desktop", displayName: "Desktop", runnerId: "runner-windows", version: 3, snapshotHash: "b".repeat(64), configuration: { kind: "desktop", app: { targetId: "desktop", platform: "windows", launch: { executable: "C:\\Apps\\app.exe", args: ["--profile", "approved"] }, process: { expectedImageName: "app.exe", allowedChildImageNames: ["helper.exe"] }, window: { automationId: "Main" }, reset: { command: "C:\\Apps\\reset.exe", args: ["--clean"], timeoutMs: 5000 }, shutdown: { gracefulTimeoutMs: 3000, forceAfterTimeout: true } } } } }));
    expect(web).toContain("runner-web");
    expect(web).toContain("https://example.test/");
    expect(desktop).toContain("runner-windows");
    expect(desktop).toContain("C:\\\\Apps\\\\app.exe");
    expect(desktop).toContain("helper.exe");
    expect(desktop).toContain("--clean");
  });

  it("preserves every Desktop AppTarget field when creating a revision", async () => {
    const desktop = { targetId: "desktop", projectId: "project-1", kind: "desktop" as const, displayName: "Desktop", runnerId: "runner-windows", version: 3, snapshotHash: "b".repeat(64), configuration: { kind: "desktop" as const, app: { targetId: "desktop", platform: "windows" as const, launch: { executable: "C:\\Apps\\app.exe", args: ["--profile", "approved"], workingDirectory: "C:\\Apps" }, process: { expectedImageName: "app.exe", allowedChildImageNames: ["helper.exe"] }, window: { titlePattern: "Main.*", automationId: "Main" }, reset: { command: "C:\\Apps\\reset.exe", args: ["--clean"], timeoutMs: 5000 }, shutdown: { gracefulTimeoutMs: 3000, forceAfterTimeout: true } } } };
    const createTarget = vi.fn().mockResolvedValue({ resource: { ...desktop, version: 4 } });
    const api = { listTargets: vi.fn().mockResolvedValue({ items: [desktop] }), listPrdRevisions: vi.fn().mockResolvedValue({ items: [] }), createTarget };
    await renderConsole("/projects/project-1", api);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Revise v3" }));
    await user.clear(screen.getByLabelText("Desktop executable"));
    await user.type(screen.getByLabelText("Desktop executable"), "C:\\Apps\\app-v2.exe");
    await user.click(screen.getByRole("button", { name: "Update Target revision" }));
    await waitFor(() => expect(createTarget).toHaveBeenCalledOnce());
    expect(createTarget.mock.calls[0]?.[1].configuration.app).toEqual({
      ...desktop.configuration.app,
      launch: { ...desktop.configuration.app.launch, executable: "C:\\Apps\\app-v2.exe" },
    });
  });

  it("renders exact Test Plan and Mission revision bindings", () => {
    const plan = renderToStaticMarkup(createElement(TestPlanRevisionSummary, { plan: { planId: "plan-1", projectId: "p", prdId: "prd-1", prdRevision: 4, status: "approved", version: 2, payload: { schemaVersion: "test-plan/v1", testCases: [] } } }));
    const mission = renderToStaticMarkup(createElement(MissionRevisionSummary, { mission: { missionId: "mission-1", projectId: "p", revision: 1, targetId: "desktop", targetVersion: 3, targetSnapshotHash: "b".repeat(64), runnerId: "runner-windows", planId: "plan-1", planVersion: 2, status: "approved", version: 1 } }));
    expect(plan).toContain("prd-1@4");
    expect(plan).toContain("approved");
    expect(mission).toContain("plan-1@2");
    expect(mission).toContain("runner-windows");
    expect(mission).toContain("v3");
  });

  it("uses loaded Target versions and renders/reloads create and update conflicts", async () => {
    const listTargets = vi.fn().mockResolvedValue({ items: [target] });
    const createTarget = vi.fn().mockRejectedValue(conflict(5));
    const api = { listTargets, listPrdRevisions: vi.fn().mockResolvedValue({ items: [] }), createTarget };
    await renderConsole("/projects/project-1", api);
    const user = userEvent.setup();
    await screen.findByText("Web");

    await user.type(screen.getByLabelText("Target ID"), "target-new");
    await user.type(screen.getByLabelText("Target name"), "New target");
    await user.type(screen.getByLabelText("Runner ID"), "runner-new");
    await user.click(screen.getByRole("button", { name: "Create Target revision" }));
    expect((await screen.findByRole("alert")).textContent).toContain("current version 5");
    await waitFor(() => expect(listTargets).toHaveBeenCalledTimes(2));
    expect(createTarget.mock.calls[0]?.[1]).toMatchObject({ expectedVersion: 0 });

    await user.click(screen.getByRole("button", { name: "Revise v4" }));
    await user.click(screen.getByRole("button", { name: "Update Target revision" }));
    await waitFor(() => expect(createTarget).toHaveBeenCalledTimes(2));
    expect(createTarget.mock.calls[1]?.[1]).toMatchObject({ targetId: "target-1", expectedVersion: 4 });
  });

  it("ingests a PRD through the visible Project control and shows a safe mutation error", async () => {
    const listPrdRevisions = vi.fn().mockResolvedValue({ items: [] });
    const ingestPrd = vi.fn().mockResolvedValue({ resource: { prdId: "prd-1", revision: 1 } });
    const api = { listTargets: vi.fn().mockResolvedValue({ items: [] }), listPrdRevisions, ingestPrd };
    await renderConsole("/projects/project-1", api);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("PRD title"), "Checkout requirements");
    await user.type(screen.getByLabelText("PRD content"), "Customers can pay.");
    await user.click(screen.getByRole("button", { name: "Ingest PRD" }));
    await waitFor(() => expect(ingestPrd).toHaveBeenCalledWith("project-1", { title: "Checkout requirements", content: "Customers can pay." }, expect.objectContaining({ idempotencyKey: expect.any(String) })));
    await waitFor(() => expect(listPrdRevisions).toHaveBeenCalledTimes(2));

    ingestPrd.mockRejectedValueOnce(new Error("PRD intake unavailable"));
    await user.type(screen.getByLabelText("PRD title"), "Retry");
    await user.type(screen.getByLabelText("PRD content"), "Still a requirement.");
    await user.click(screen.getByRole("button", { name: "Ingest PRD" }));
    expect((await screen.findByRole("alert")).textContent).toContain("PRD intake unavailable");
  });

  it("starts a Mission with its loaded version and reloads after a conflict", async () => {
    const getMission = vi.fn().mockResolvedValue({ missionId: "mission-1", projectId: "project-1", revision: 1, targetId: "target-1", targetVersion: 1, targetSnapshotHash: "a".repeat(64), runnerId: "runner-1", planId: "plan-1", planVersion: 1, status: "approved", version: 4 });
    const startMission = vi.fn().mockRejectedValue(conflict(5));
    const api = { getMission, listRuns: vi.fn().mockResolvedValue({ items: [] }), startMission };
    await renderConsole("/missions/mission-1", api);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Start Mission (v4)" }));
    await waitFor(() => expect(startMission).toHaveBeenCalledWith("mission-1", { expectedVersion: 4 }, expect.objectContaining({ idempotencyKey: expect.any(String) })));
    expect((await screen.findByRole("alert")).textContent).toContain("current version 5");
    await waitFor(() => expect(getMission).toHaveBeenCalledTimes(2));
  });

  it("renders authorized Artifact download and hides a NotFound Artifact behind a safe denial", async () => {
    const metadata = { artifactId: "artifact-1", runId: "run-1", kind: "screenshot", mediaType: "image/png", size: 3, sha256: "a".repeat(64), downloadAllowed: true };
    const downloadArtifact = vi.fn().mockResolvedValue(new Blob(["ok"], { type: "image/png" }));
    const api = { getArtifactMetadata: vi.fn().mockResolvedValue(metadata), downloadArtifact };
    await renderConsole("/projects/project-1/runs/run-1/artifacts/artifact-1", api);
    const user = userEvent.setup();
    expect(await screen.findByText("Authorized")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Download authorized Artifact" }));
    await waitFor(() => expect(downloadArtifact).toHaveBeenCalledWith("project-1", "run-1", "artifact-1"));
    expect(await screen.findByRole("link", { name: "Save authorized Artifact" })).toBeTruthy();

    api.getArtifactMetadata.mockRejectedValueOnce(new ApiClientError(404, { code: "NotFound", safeMessage: "Evidence artifact not found", correlationId: "x" }));
    await router.navigate({ to: "/projects/$projectId/runs/$runId/artifacts/$artifactId", params: { projectId: "project-1", runId: "run-1", artifactId: "hidden" } });
    expect((await screen.findByRole("alert")).textContent).toBe("Artifact is unavailable.");
    expect(screen.queryByText("Evidence artifact not found")).toBeNull();
  });

  it("revokes authorized Blob URLs when Artifact identity changes and on unmount", async () => {
    const originalCreate = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const originalRevoke = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    const createObjectURL = vi.fn().mockReturnValueOnce("blob:first").mockReturnValueOnce("blob:second");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
    const metadata = { artifactId: "artifact-1", runId: "run-1", kind: "screenshot", mediaType: "image/png", size: 3, sha256: "a".repeat(64), downloadAllowed: true };
    const api = { getArtifactMetadata: vi.fn().mockResolvedValue(metadata), downloadArtifact: vi.fn().mockResolvedValue(new Blob(["ok"], { type: "image/png" })) };
    try {
      await renderConsole("/projects/project-1/runs/run-1/artifacts/artifact-1", api);
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: "Download authorized Artifact" }));
      await screen.findByRole("link", { name: "Save authorized Artifact" });
      await router.navigate({ to: "/projects/$projectId/runs/$runId/artifacts/$artifactId", params: { projectId: "project-1", runId: "run-2", artifactId: "artifact-2" } });
      await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith("blob:first"));
      await user.click(await screen.findByRole("button", { name: "Download authorized Artifact" }));
      await screen.findByRole("link", { name: "Save authorized Artifact" });
      cleanup();
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:second");
    } finally {
      if (originalCreate === undefined) delete (URL as { createObjectURL?: unknown }).createObjectURL;
      else Object.defineProperty(URL, "createObjectURL", originalCreate);
      if (originalRevoke === undefined) delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL;
      else Object.defineProperty(URL, "revokeObjectURL", originalRevoke);
    }
  });

  it("renders Test Plan approval conflict details and reloads the current version", async () => {
    const getTestPlan = vi.fn().mockResolvedValue(draftPlan);
    const api = { getTestPlan, approveTestPlan: vi.fn().mockRejectedValue(conflict(4)) };
    await renderConsole("/test-plans/plan-1", api);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Approve (v3)" }));
    expect((await screen.findByRole("alert")).textContent).toContain("current version 4");
    await waitFor(() => expect(getTestPlan).toHaveBeenCalledTimes(2));
    expect(api.approveTestPlan.mock.calls[0]?.[1]).toEqual({ expectedVersion: 3 });
  });

});

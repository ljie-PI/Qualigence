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

  it("renders Mission creation conflict details and reloads Plan and Target state", async () => {
    const getTestPlan = vi.fn().mockResolvedValue(approvedPlan);
    const listTargets = vi.fn().mockResolvedValue({ items: [target] });
    const api = { getTestPlan, listTargets, createMission: vi.fn().mockRejectedValue(conflict(2)) };
    await renderConsole("/test-plans/plan-1", api);
    const user = userEvent.setup();
    await screen.findByRole("option", { name: "Web v4 · runner-1" });
    await user.selectOptions(screen.getByLabelText("Approved Target revision"), "target-1");
    await user.click(screen.getByRole("button", { name: "Create Mission from snapshots" }));
    expect((await screen.findByRole("alert")).textContent).toContain("current version 2");
    await waitFor(() => expect(getTestPlan).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(listTargets).toHaveBeenCalledTimes(2));
    expect(api.createMission.mock.calls[0]?.[0]).toMatchObject({ targetVersion: 4, planVersion: 3 });
  });
});

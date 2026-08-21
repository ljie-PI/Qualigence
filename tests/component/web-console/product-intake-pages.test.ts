// React is intentionally loaded from the Console's isolated dependency tree.
// @ts-expect-error the root test project does not own the Console's React types
import { createElement } from "../../../apps/web-console/node_modules/react/index.js";
// @ts-expect-error the root test project does not own the Console's React DOM types
import { renderToStaticMarkup } from "../../../apps/web-console/node_modules/react-dom/server.js";
import { describe, expect, it } from "vitest";
// @ts-expect-error the Console owns JSX compilation for its source modules
import { TargetRevisionSummary } from "../../../apps/web-console/src/features/projects/project-page.js";
// @ts-expect-error the Console owns JSX compilation for its source modules
import { TestPlanRevisionSummary } from "../../../apps/web-console/src/features/projects/prd-plan-page.js";
// @ts-expect-error the Console owns JSX compilation for its source modules
import { MissionRevisionSummary } from "../../../apps/web-console/src/features/missions/mission-page.js";

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
});

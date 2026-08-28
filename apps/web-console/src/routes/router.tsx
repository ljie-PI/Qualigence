import type { ReactNode } from "react";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { useAuth, useSession } from "../auth/session-context.js";
import { ProjectDetailPage, ProjectListPage } from "../features/projects/project-page.js";
import { PrdRevisionPage, TestPlanPage } from "../features/projects/prd-plan-page.js";
import { MissionDetailPage, MissionListPage } from "../features/missions/mission-page.js";
import { RunDetailPage, RunListPage } from "../features/runs/run-page.js";
import { ArtifactPage } from "../features/evidence/artifact-page.js";
import { SkillDetailPage, SkillListPage } from "../features/skills/skill-page.js";
import {
  InvestigationDetailPage,
  InvestigationListPage,
} from "../features/investigations/investigation-page.js";
import { ReviewQueuePage } from "../features/reviews/review-queue-page.js";
import { ReviewTaskPage } from "../features/reviews/review-task-page.js";

const NAV: readonly { readonly to: string; readonly label: string }[] = [
  { to: "/projects", label: "Projects" },
  { to: "/missions", label: "Missions" },
  { to: "/runs", label: "Runs" },
  { to: "/skills", label: "Skills" },
  { to: "/investigations", label: "Investigations" },
  { to: "/reviews", label: "Reviews" },
];

function RootLayout(): ReactNode {
  const session = useSession();
  const { logout } = useAuth();
  return (
    <div className="app-shell">
      <header className="app-header">
        <strong className="brand">Qualigence Console</strong>
        <nav className="app-nav">
          {NAV.map((item) => (
            <Link key={item.to} to={item.to} className="app-nav__link">
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="app-header__user">
          {session !== undefined ? (
            <>
              <span className="muted">
                {session.subject} · {session.tenantId} · {session.roles.join(", ")}
              </span>
              <button type="button" onClick={logout}>
                Log out
              </button>
            </>
          ) : null}
        </div>
      </header>
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}

const rootRoute = createRootRoute({ component: RootLayout });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/projects" });
  },
});

const projectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects",
  component: ProjectListPage,
});

const projectDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId",
  component: function ProjectDetailRoute(): ReactNode {
    const { projectId } = projectDetailRoute.useParams();
    return <ProjectDetailPage projectId={projectId} />;
  },
});

const prdRevisionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId/prd/$revision",
  component: function PrdRevisionRoute(): ReactNode {
    const { projectId, revision } = prdRevisionRoute.useParams();
    return <PrdRevisionPage projectId={projectId} revision={Number(revision)} />;
  },
});

const testPlanRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/test-plans/$planId",
  component: function TestPlanRoute(): ReactNode {
    const { planId } = testPlanRoute.useParams();
    return <TestPlanPage planId={planId} />;
  },
});

const missionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/missions",
  component: MissionListPage,
});

const missionDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/missions/$missionId",
  component: function MissionDetailRoute(): ReactNode {
    const { missionId } = missionDetailRoute.useParams();
    return <MissionDetailPage missionId={missionId} />;
  },
});

const runsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/runs",
  component: RunListPage,
});

const runDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/runs/$runId",
  component: function RunDetailRoute(): ReactNode {
    const { runId } = runDetailRoute.useParams();
    return <RunDetailPage runId={runId} />;
  },
});

const artifactRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId/runs/$runId/artifacts/$artifactId",
  component: function ArtifactRoute(): ReactNode {
    const { projectId, runId, artifactId } = artifactRoute.useParams();
    return <ArtifactPage projectId={projectId} runId={runId} artifactId={artifactId} />;
  },
});

const skillsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/skills",
  component: SkillListPage,
});

const skillDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/skills/$skillId",
  component: function SkillDetailRoute(): ReactNode {
    const { skillId } = skillDetailRoute.useParams();
    return <SkillDetailPage skillId={skillId} />;
  },
});

const investigationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/investigations",
  component: InvestigationListPage,
});

const investigationDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/investigations/$caseId",
  component: function InvestigationDetailRoute(): ReactNode {
    const { caseId } = investigationDetailRoute.useParams();
    return <InvestigationDetailPage caseId={caseId} />;
  },
});

const reviewsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/reviews",
  component: ReviewQueuePage,
});

const reviewTaskRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/reviews/$taskId",
  component: function ReviewTaskRoute(): ReactNode {
    const { taskId } = reviewTaskRoute.useParams();
    return <ReviewTaskPage taskId={taskId} />;
  },
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  projectsRoute,
  projectDetailRoute,
  prdRevisionRoute,
  testPlanRoute,
  missionsRoute,
  missionDetailRoute,
  runsRoute,
  runDetailRoute,
  artifactRoute,
  skillsRoute,
  skillDetailRoute,
  investigationsRoute,
  investigationDetailRoute,
  reviewsRoute,
  reviewTaskRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

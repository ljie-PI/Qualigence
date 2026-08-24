/**
 * TanStack Query key factories. Keys are namespaced by tenant and resource so a
 * logout / tenant switch can never surface another tenant's cached data, and so
 * a mutation can precisely invalidate the affected resource.
 */
export const queryKeys = {
  projects: (tenantId: string) => ["tenant", tenantId, "projects"] as const,
  project: (tenantId: string, projectId: string) =>
    ["tenant", tenantId, "projects", projectId] as const,
  targets: (tenantId: string, projectId: string) =>
    ["tenant", tenantId, "projects", projectId, "targets"] as const,
  prdRevisions: (tenantId: string, projectId: string) =>
    ["tenant", tenantId, "projects", projectId, "prd-revisions"] as const,
  testPlan: (tenantId: string, planId: string) =>
    ["tenant", tenantId, "test-plans", planId] as const,
  missions: (tenantId: string) => ["tenant", tenantId, "missions"] as const,
  mission: (tenantId: string, missionId: string) =>
    ["tenant", tenantId, "missions", missionId] as const,
  runs: (tenantId: string) => ["tenant", tenantId, "runs"] as const,
  run: (tenantId: string, runId: string) => ["tenant", tenantId, "runs", runId] as const,
  skills: (tenantId: string) => ["tenant", tenantId, "skills"] as const,
  skill: (tenantId: string, skillId: string) => ["tenant", tenantId, "skills", skillId] as const,
  skillVersions: (tenantId: string, skillId: string) => ["tenant", tenantId, "skills", skillId, "versions"] as const,
  investigations: (tenantId: string) => ["tenant", tenantId, "investigations"] as const,
  investigation: (tenantId: string, caseId: string) =>
    ["tenant", tenantId, "investigations", caseId] as const,
  reviewTasks: (tenantId: string) => ["tenant", tenantId, "review-tasks"] as const,
  reviewTask: (tenantId: string, taskId: string) =>
    ["tenant", tenantId, "review-tasks", taskId] as const,
};

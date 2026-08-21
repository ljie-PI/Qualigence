import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { CreateTestPlanBody, TestPlanDto } from "@qualigence/public-api";
import { useServices, useSession } from "../../auth/session-context.js";
import { queryKeys } from "../../routes/query-keys.js";
import { DataState, DefinitionList, StatusBadge } from "../../ui/components.js";

/** PRD revision detail (route `/projects/:projectId/prd/:revision`). */
export function PrdRevisionPage(props: {
  readonly projectId: string;
  readonly revision: number;
}): ReactNode {
  const { api } = useServices();
  const session = useSession();
  const tenantId = session?.tenantId ?? "";
  const { projectId, revision } = props;
  const [proposalJson, setProposalJson] = useState("");
  const [createdPlanId, setCreatedPlanId] = useState<string | undefined>();

  const prds = useQuery({
    queryKey: queryKeys.prdRevisions(tenantId, projectId),
    queryFn: () => api.listPrdRevisions(projectId),
    enabled: session !== undefined,
  });
  const prd = prds.data?.items.find((item) => item.revision === revision);
  const createPlan = useMutation({
    mutationFn: async () => {
      if (prd === undefined) throw new Error("PRD revision is not loaded");
      const proposal = JSON.parse(proposalJson) as Pick<CreateTestPlanBody, "expectedClaims" | "testCases">;
      return api.createTestPlan({ projectId, prdId: prd.prdId, prdRevision: prd.revision, sourceContentSha256: prd.contentSha256, ...proposal }, { idempotencyKey: crypto.randomUUID() });
    },
    onSuccess: (result) => setCreatedPlanId(result.resource.planId),
  });

  return (
    <section>
      <p>
        <Link to="/projects/$projectId" params={{ projectId }}>
          ← Project
        </Link>
      </p>
      <h1>
        PRD revision r{revision}
      </h1>
      <DataState isLoading={prds.isLoading} error={prds.error} isEmpty={prd === undefined}>
        {prd !== undefined ? (
          <DefinitionList
            items={[
              ["Title", prd.title],
              ["Revision", String(prd.revision)],
              ["Content SHA-256", prd.contentSha256],
              ["Ingested at", prd.ingestedAt],
            ]}
          />
        ) : null}
      </DataState>
      {prd !== undefined ? <form onSubmit={(event) => { event.preventDefault(); createPlan.mutate(); }}>
        <label>Grounded Test Plan proposal JSON<textarea aria-label="Grounded Test Plan proposal JSON" value={proposalJson} onChange={(event) => setProposalJson(event.target.value)} /></label>
        <button type="submit" disabled={createPlan.isPending || proposalJson.trim().length === 0}>Create draft Test Plan</button>
      </form> : null}
      {createdPlanId === undefined ? null : <Link to="/test-plans/$planId" params={{ planId: createdPlanId }}>Review created Test Plan</Link>}
    </section>
  );
}

/** Draft Test Plan review + expected-version approval (route `/test-plans/:planId`). */
export function TestPlanPage(props: { readonly planId: string }): ReactNode {
  const { api } = useServices();
  const session = useSession();
  const tenantId = session?.tenantId ?? "";
  const { planId } = props;
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | undefined>();
  const [targetId, setTargetId] = useState("");

  const plan = useQuery({
    queryKey: queryKeys.testPlan(tenantId, planId),
    queryFn: () => api.getTestPlan(planId),
    enabled: session !== undefined,
  });

  const approve = useMutation({
    mutationFn: () =>
      api.approveTestPlan(
        planId,
        { expectedVersion: plan.data?.version ?? 0 },
        { idempotencyKey: crypto.randomUUID() },
      ),
    onSuccess: (result) => {
      setError(undefined);
      queryClient.setQueryData(queryKeys.testPlan(tenantId, planId), result.resource);
    },
    onError: (err: unknown) => setError(err instanceof Error ? err.message : "approval failed"),
  });
  const targets = useQuery({
    queryKey: queryKeys.targets(tenantId, plan.data?.projectId ?? ""),
    queryFn: () => api.listTargets(plan.data?.projectId ?? ""),
    enabled: plan.data?.status === "approved",
  });
  const createMission = useMutation({
    mutationFn: async () => {
      const selected = targets.data?.items.find((target) => target.targetId === targetId);
      if (plan.data === undefined || selected === undefined) throw new Error("Select an approved Target revision");
      return api.createMission({ projectId: plan.data.projectId, targetId: selected.targetId, targetVersion: selected.version, targetSnapshotHash: selected.snapshotHash, planId: plan.data.planId, planVersion: plan.data.version }, { idempotencyKey: crypto.randomUUID() });
    },
  });

  const canApprove = session?.roles.some((r) => r === "admin" || r === "tester") ?? false;

  return (
    <section>
      <h1>Test plan {planId}</h1>
      <DataState isLoading={plan.isLoading} error={plan.error} isEmpty={plan.data === undefined}>
        {plan.data !== undefined ? (
          <>
            <TestPlanRevisionSummary plan={plan.data} />
            <ol className="resource-list">
              {plan.data.payload.testCases.map((testCase) => (
                <li key={testCase.testCaseId}>
                  <strong>{testCase.title}</strong> — {testCase.objective}
                </li>
              ))}
            </ol>
            {canApprove && plan.data.status === "draft" ? (
              <button type="button" onClick={() => approve.mutate()} disabled={approve.isPending}>
                Approve (v{plan.data.version})
              </button>
            ) : null}
            {error !== undefined ? (
              <p className="state state--error" role="alert">
                {error}
              </p>
            ) : null}
            {plan.data.status === "approved" ? <form onSubmit={(event) => { event.preventDefault(); createMission.mutate(); }}>
              <select aria-label="Approved Target revision" value={targetId} onChange={(event) => setTargetId(event.target.value)}>
                <option value="">Select Target revision</option>
                {targets.data?.items.map((target) => <option key={target.targetId} value={target.targetId}>{target.displayName} v{target.version} · {target.runnerId}</option>)}
              </select>
              <button type="submit" disabled={!targetId || createMission.isPending}>Create Mission from snapshots</button>
            </form> : null}
            {createMission.data === undefined ? null : <Link to="/missions/$missionId" params={{ missionId: createMission.data.resource.missionId }}>Open created Mission</Link>}
          </>
        ) : null}
      </DataState>
    </section>
  );
}

export function TestPlanRevisionSummary(props: { readonly plan: TestPlanDto }): ReactNode {
  return <DefinitionList items={[
    ["Status", <StatusBadge key="s" value={props.plan.status} />],
    ["Version", String(props.plan.version)],
    ["PRD revision", `${props.plan.prdId}@${props.plan.prdRevision}`],
    ["Test cases", String(props.plan.payload.testCases.length)],
  ]} />;
}

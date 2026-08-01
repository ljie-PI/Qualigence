import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
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

  const prds = useQuery({
    queryKey: queryKeys.prdRevisions(tenantId, projectId),
    queryFn: () => api.listPrdRevisions(projectId),
    enabled: session !== undefined,
  });
  const prd = prds.data?.items.find((item) => item.revision === revision);

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

  const plan = useQuery({
    queryKey: queryKeys.testPlan(tenantId, planId),
    queryFn: () => api.getTestPlan(planId),
    enabled: session !== undefined,
  });

  const approve = useMutation({
    mutationFn: () =>
      api.approveTestPlan(
        planId,
        { expectedVersion: plan.data?.version ?? 0, reviewerId: session?.subject ?? "" },
        { idempotencyKey: crypto.randomUUID() },
      ),
    onSuccess: (result) => {
      setError(undefined);
      queryClient.setQueryData(queryKeys.testPlan(tenantId, planId), result.resource);
    },
    onError: (err: unknown) => setError(err instanceof Error ? err.message : "approval failed"),
  });

  const canApprove = session?.roles.some((r) => r === "admin" || r === "reviewer") ?? false;

  return (
    <section>
      <h1>Test plan {planId}</h1>
      <DataState isLoading={plan.isLoading} error={plan.error} isEmpty={plan.data === undefined}>
        {plan.data !== undefined ? (
          <>
            <DefinitionList
              items={[
                ["Status", <StatusBadge key="s" value={plan.data.status} />],
                ["Version", String(plan.data.version)],
                ["PRD revision", String(plan.data.prdRevision)],
                ["Test cases", String(plan.data.payload.testCases.length)],
              ]}
            />
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
          </>
        ) : null}
      </DataState>
    </section>
  );
}

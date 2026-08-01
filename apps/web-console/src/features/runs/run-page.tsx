import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useServices, useSession } from "../../auth/session-context.js";
import { queryKeys } from "../../routes/query-keys.js";
import { DataState, DefinitionList, StatusBadge } from "../../ui/components.js";

export function RunListPage(): ReactNode {
  const { api } = useServices();
  const session = useSession();
  const tenantId = session?.tenantId ?? "";
  const runs = useQuery({
    queryKey: queryKeys.runs(tenantId),
    queryFn: () => api.listRuns(),
    enabled: session !== undefined,
  });
  return (
    <section>
      <h1>Runs</h1>
      <DataState
        isLoading={runs.isLoading}
        error={runs.error}
        isEmpty={runs.data?.items.length === 0}
        emptyLabel="No runs."
      >
        <ul className="resource-list">
          {runs.data?.items.map((run) => (
            <li key={run.runId}>
              <Link to="/runs/$runId" params={{ runId: run.runId }}>
                {run.runId}
              </Link>
              <StatusBadge value={run.status} />
            </li>
          ))}
        </ul>
      </DataState>
    </section>
  );
}

export function RunDetailPage(props: { readonly runId: string }): ReactNode {
  const { api } = useServices();
  const session = useSession();
  const tenantId = session?.tenantId ?? "";
  const run = useQuery({
    queryKey: queryKeys.run(tenantId, props.runId),
    queryFn: () => api.getRun(props.runId),
    enabled: session !== undefined,
  });
  return (
    <section>
      <p>
        <Link to="/runs">← Runs</Link>
      </p>
      <h1>Run {props.runId}</h1>
      <DataState isLoading={run.isLoading} error={run.error} isEmpty={run.data === undefined}>
        {run.data !== undefined ? (
          <>
            <DefinitionList
              items={[
                ["Status", <StatusBadge key="s" value={run.data.status} />],
                ["Created at", run.data.createdAt],
                ["Completed at", run.data.completedAt ?? "—"],
                ["Findings", String(run.data.findingIds.length)],
                ["Evidence refs", String(run.data.evidenceRefs.length)],
              ]}
            />
            <h2>Trace summary</h2>
            <ul className="resource-list">
              {run.data.findingIds.map((findingId) => (
                <li key={findingId}>finding {findingId}</li>
              ))}
            </ul>
          </>
        ) : null}
      </DataState>
    </section>
  );
}

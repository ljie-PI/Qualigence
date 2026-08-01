import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useServices, useSession } from "../../auth/session-context.js";
import { queryKeys } from "../../routes/query-keys.js";
import { DataState, DefinitionList, StatusBadge } from "../../ui/components.js";

export function InvestigationListPage(): ReactNode {
  const { api } = useServices();
  const session = useSession();
  const tenantId = session?.tenantId ?? "";
  const investigations = useQuery({
    queryKey: queryKeys.investigations(tenantId),
    queryFn: () => api.listInvestigations(),
    enabled: session !== undefined,
  });
  return (
    <section>
      <h1>Investigations</h1>
      <DataState
        isLoading={investigations.isLoading}
        error={investigations.error}
        isEmpty={investigations.data?.items.length === 0}
        emptyLabel="No investigations."
      >
        <ul className="resource-list">
          {investigations.data?.items.map((investigation) => (
            <li key={investigation.caseId}>
              <Link to="/investigations/$caseId" params={{ caseId: investigation.caseId }}>
                {investigation.caseId}
              </Link>
              <StatusBadge value={investigation.status} />
            </li>
          ))}
        </ul>
      </DataState>
    </section>
  );
}

export function InvestigationDetailPage(props: { readonly caseId: string }): ReactNode {
  const { api } = useServices();
  const session = useSession();
  const tenantId = session?.tenantId ?? "";
  const investigation = useQuery({
    queryKey: queryKeys.investigation(tenantId, props.caseId),
    queryFn: () => api.getInvestigation(props.caseId),
    enabled: session !== undefined,
  });

  const needsHuman = investigation.data?.status === "needs_human";

  return (
    <section>
      <p>
        <Link to="/investigations">← Investigations</Link>
      </p>
      <h1>Investigation {props.caseId}</h1>
      <DataState
        isLoading={investigation.isLoading}
        error={investigation.error}
        isEmpty={investigation.data === undefined}
      >
        {investigation.data !== undefined ? (
          <>
            <DefinitionList
              items={[
                ["Status", <StatusBadge key="s" value={investigation.data.status} />],
                ["Finding", investigation.data.findingId],
                ["Evidence completeness", investigation.data.evidenceCompleteness],
                ["Reproduction attempts", String(investigation.data.attemptIds.length)],
                ["Version", String(investigation.data.version)],
              ]}
            />
            {needsHuman ? (
              <p className="callout callout--attention">
                This case needs human review — see the Review queue.
              </p>
            ) : null}
            {investigation.data.evidenceCompleteness !== "complete" ? (
              <p className="callout">
                Evidence is {investigation.data.evidenceCompleteness}; capsule plaintext is not
                downloadable without an authorized endpoint.
              </p>
            ) : null}
          </>
        ) : null}
      </DataState>
    </section>
  );
}

import type { MissionDto } from "@qualigence/public-api";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useServices, useSession } from "../../auth/session-context.js";
import { queryKeys } from "../../routes/query-keys.js";
import { DataState, DefinitionList, StatusBadge } from "../../ui/components.js";

export function MissionListPage(): ReactNode {
  const { api } = useServices();
  const session = useSession();
  const tenantId = session?.tenantId ?? "";
  const missions = useQuery({
    queryKey: queryKeys.missions(tenantId),
    queryFn: () => api.listMissions(),
    enabled: session !== undefined,
  });
  return (
    <section>
      <h1>Missions</h1>
      <DataState
        isLoading={missions.isLoading}
        error={missions.error}
        isEmpty={missions.data?.items.length === 0}
        emptyLabel="No missions."
      >
        <ul className="resource-list">
          {missions.data?.items.map((mission) => (
            <li key={mission.missionId}>
              <Link to="/missions/$missionId" params={{ missionId: mission.missionId }}>
                {mission.missionId}
              </Link>
              <StatusBadge value={mission.status} />
            </li>
          ))}
        </ul>
      </DataState>
    </section>
  );
}

export function MissionDetailPage(props: { readonly missionId: string }): ReactNode {
  const { api } = useServices();
  const session = useSession();
  const tenantId = session?.tenantId ?? "";
  const mission = useQuery({
    queryKey: queryKeys.mission(tenantId, props.missionId),
    queryFn: () => api.getMission(props.missionId),
    enabled: session !== undefined,
  });
  return (
    <section>
      <p>
        <Link to="/missions">← Missions</Link>
      </p>
      <h1>Mission {props.missionId}</h1>
      <DataState isLoading={mission.isLoading} error={mission.error} isEmpty={mission.data === undefined}>
        {mission.data !== undefined ? (
          <MissionRevisionSummary mission={mission.data} />
        ) : null}
      </DataState>
    </section>
  );
}

export function MissionRevisionSummary(props: { readonly mission: MissionDto }): ReactNode {
  return <DefinitionList items={[
    ["Status", <StatusBadge key="s" value={props.mission.status} />],
    ["Project", props.mission.projectId],
    ["Target", props.mission.targetId],
    ["Target revision", `v${props.mission.targetVersion} (${props.mission.targetSnapshotHash})`],
    ["Runner", props.mission.runnerId],
    ["Test plan", `${props.mission.planId}@${props.mission.planVersion}`],
    ["Revision", String(props.mission.revision)],
    ["Version", String(props.mission.version)],
  ]} />;
}

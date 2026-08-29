import type { MissionDto } from "@qualigence/public-api";
import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ApiClientError } from "../../api/errors.js";
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
  const queryClient = useQueryClient();
  const [startError, setStartError] = useState<string | undefined>();
  const mission = useQuery({
    queryKey: queryKeys.mission(tenantId, props.missionId),
    queryFn: () => api.getMission(props.missionId),
    enabled: session !== undefined,
  });
  const runs = useQuery({
    queryKey: queryKeys.runs(tenantId),
    queryFn: () => api.listRuns(),
    enabled: session !== undefined,
  });
  const start = useMutation({
    mutationFn: () => {
      if (mission.data === undefined) throw new Error("Mission is not loaded");
      return api.startMission(
        props.missionId,
        { expectedVersion: mission.data.version },
        { idempotencyKey: crypto.randomUUID() },
      );
    },
    onSuccess: () => {
      setStartError(undefined);
      void queryClient.invalidateQueries({ queryKey: queryKeys.mission(tenantId, props.missionId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs(tenantId) });
    },
    onError: (error: unknown) => {
      if (error instanceof ApiClientError && error.code === "VersionConflict") {
        const actual = error.details?.actualVersion;
        setStartError(`Mission changed concurrently${typeof actual === "number" ? ` (current version ${actual})` : ""}. Reloaded current state.`);
        void queryClient.invalidateQueries({ queryKey: queryKeys.mission(tenantId, props.missionId) });
      } else {
        setStartError(error instanceof Error ? error.message : "Mission start failed");
      }
    },
  });
  const canStart = session?.roles.some((role) => role === "admin" || role === "tester") ?? false;
  const missionRuns = runs.data?.items.filter((run) => run.missionId === props.missionId) ?? [];
  return (
    <section>
      <p>
        <Link to="/missions">← Missions</Link>
      </p>
      <h1>Mission {props.missionId}</h1>
      <DataState isLoading={mission.isLoading} error={mission.error} isEmpty={mission.data === undefined}>
        {mission.data !== undefined ? <>
          <MissionRevisionSummary mission={mission.data} />
          {canStart && mission.data.status === "approved" ? <button type="button" onClick={() => start.mutate()} disabled={start.isPending}>Start Mission (v{mission.data.version})</button> : null}
          {startError === undefined ? null : <p className="state state--error" role="alert">{startError}</p>}
          {missionRuns.length === 0 ? null : <>
            <h2>Runs</h2>
            <ul className="resource-list">
              {missionRuns.map((run) => <li key={run.runId}>
                <Link to="/runs/$runId" params={{ runId: run.runId }}>{run.runId}</Link>
                {run.evidenceRefs.map((artifactId) => <Link key={artifactId} to="/projects/$projectId/runs/$runId/artifacts/$artifactId" params={{ projectId: mission.data.projectId, runId: run.runId, artifactId }}>Artifact {artifactId}</Link>)}
              </li>)}
            </ul>
          </>}
        </> : null}
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

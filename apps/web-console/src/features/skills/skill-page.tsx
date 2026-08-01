import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useServices, useSession } from "../../auth/session-context.js";
import { queryKeys } from "../../routes/query-keys.js";
import { DataState, DefinitionList, StatusBadge } from "../../ui/components.js";

export function SkillListPage(): ReactNode {
  const { api } = useServices();
  const session = useSession();
  const tenantId = session?.tenantId ?? "";
  const skills = useQuery({
    queryKey: queryKeys.skills(tenantId),
    queryFn: () => api.listSkills(),
    enabled: session !== undefined,
  });
  return (
    <section>
      <h1>Skills</h1>
      <DataState
        isLoading={skills.isLoading}
        error={skills.error}
        isEmpty={skills.data?.items.length === 0}
        emptyLabel="No skills."
      >
        <ul className="resource-list">
          {skills.data?.items.map((skill) => (
            <li key={skill.skillId}>
              <Link to="/skills/$skillId" params={{ skillId: skill.skillId }}>
                {skill.skillId}
              </Link>
              <StatusBadge value={skill.state} />
            </li>
          ))}
        </ul>
      </DataState>
    </section>
  );
}

export function SkillDetailPage(props: { readonly skillId: string }): ReactNode {
  const { api } = useServices();
  const session = useSession();
  const tenantId = session?.tenantId ?? "";
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | undefined>();

  const skill = useQuery({
    queryKey: queryKeys.skill(tenantId, props.skillId),
    queryFn: () => api.getSkill(props.skillId),
    enabled: session !== undefined,
  });

  const promote = useMutation({
    mutationFn: () =>
      api.promoteSkill(
        props.skillId,
        { expectedVersion: skill.data?.version ?? 0 },
        { idempotencyKey: crypto.randomUUID() },
      ),
    onSuccess: (result) => {
      setError(undefined);
      queryClient.setQueryData(queryKeys.skill(tenantId, props.skillId), result.resource);
    },
    onError: (err: unknown) => setError(err instanceof Error ? err.message : "promotion failed"),
  });

  const canPromote = session?.roles.some((r) => r === "admin" || r === "tester") ?? false;

  return (
    <section>
      <p>
        <Link to="/skills">← Skills</Link>
      </p>
      <h1>Skill {props.skillId}</h1>
      <DataState isLoading={skill.isLoading} error={skill.error} isEmpty={skill.data === undefined}>
        {skill.data !== undefined ? (
          <>
            <DefinitionList
              items={[
                ["Lifecycle state", <StatusBadge key="s" value={skill.data.state} />],
                ["Version", String(skill.data.version)],
                ["Signature", <StatusBadge key="sig" value={skill.data.signatureStatus} />],
                ["Evaluation", <StatusBadge key="ev" value={skill.data.evaluationStatus} />],
                ["Content SHA-256", skill.data.contentSha256],
              ]}
            />
            {canPromote && skill.data.state !== "promoted" && skill.data.state !== "deprecated" ? (
              <button type="button" onClick={() => promote.mutate()} disabled={promote.isPending}>
                Promote (v{skill.data.version})
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

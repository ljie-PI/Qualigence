import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { CreateProjectBody } from "@qualigence/public-api";
import { useServices, useSession } from "../../auth/session-context.js";
import { queryKeys } from "../../routes/query-keys.js";
import { DataState, DefinitionList } from "../../ui/components.js";

export function ProjectListPage(): ReactNode {
  const { api } = useServices();
  const session = useSession();
  const tenantId = session?.tenantId ?? "";
  const queryClient = useQueryClient();
  const [name, setName] = useState("");

  const projects = useQuery({
    queryKey: queryKeys.projects(tenantId),
    queryFn: () => api.listProjects(),
    enabled: session !== undefined,
  });

  const create = useMutation({
    mutationFn: (body: CreateProjectBody) =>
      api.createProject(body, { idempotencyKey: crypto.randomUUID() }),
    onSuccess: () => {
      setName("");
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects(tenantId) });
    },
  });

  const canCreate = session?.roles.some((r) => r === "admin" || r === "tester") ?? false;

  return (
    <section>
      <h1>Projects</h1>
      {canCreate ? (
        <form
          className="inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim().length > 0) {
              create.mutate({ name: name.trim() });
            }
          }}
        >
          <input
            aria-label="New project name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="New project name"
          />
          <button type="submit" disabled={create.isPending}>
            Create
          </button>
        </form>
      ) : null}
      <DataState
        isLoading={projects.isLoading}
        error={projects.error}
        isEmpty={projects.data?.items.length === 0}
        emptyLabel="No projects yet."
      >
        <ul className="resource-list">
          {projects.data?.items.map((project) => (
            <li key={project.projectId}>
              <Link to="/projects/$projectId" params={{ projectId: project.projectId }}>
                {project.name}
              </Link>
              <span className="muted"> · v{project.version}</span>
            </li>
          ))}
        </ul>
      </DataState>
    </section>
  );
}

export function ProjectDetailPage(props: { readonly projectId: string }): ReactNode {
  const { api } = useServices();
  const session = useSession();
  const tenantId = session?.tenantId ?? "";
  const { projectId } = props;
  const queryClient = useQueryClient();
  const [targetId, setTargetId] = useState("");
  const [targetName, setTargetName] = useState("");
  const [runnerId, setRunnerId] = useState("");

  const targets = useQuery({
    queryKey: queryKeys.targets(tenantId, projectId),
    queryFn: () => api.listTargets(projectId),
    enabled: session !== undefined,
  });
  const prds = useQuery({
    queryKey: queryKeys.prdRevisions(tenantId, projectId),
    queryFn: () => api.listPrdRevisions(projectId),
    enabled: session !== undefined,
  });
  const createTarget = useMutation({
    mutationFn: () => api.createTarget(projectId, {
      targetId: targetId.trim(), displayName: targetName.trim(), runnerId: runnerId.trim(), expectedVersion: 0,
      configuration: { kind: "web", startUrl: "https://example.test/", allowedOrigins: ["https://example.test"], browser: "chromium" },
    }, { idempotencyKey: crypto.randomUUID() }),
    onSuccess: () => { setTargetId(""); setTargetName(""); setRunnerId(""); void queryClient.invalidateQueries({ queryKey: queryKeys.targets(tenantId, projectId) }); },
  });
  const canCreate = session?.roles.some((role) => role === "admin" || role === "tester") ?? false;

  return (
    <section>
      <p>
        <Link to="/projects">← Projects</Link>
      </p>
      <h1>Project {projectId}</h1>

      <h2>Targets</h2>
      {canCreate ? <form className="inline-form" onSubmit={(event) => { event.preventDefault(); if (targetId.trim() && targetName.trim() && runnerId.trim()) createTarget.mutate(); }}>
        <input aria-label="Target ID" value={targetId} onChange={(event) => setTargetId(event.target.value)} placeholder="Target ID" />
        <input aria-label="Target name" value={targetName} onChange={(event) => setTargetName(event.target.value)} placeholder="Display name" />
        <input aria-label="Runner ID" value={runnerId} onChange={(event) => setRunnerId(event.target.value)} placeholder="Bound Runner ID" />
        <button type="submit" disabled={createTarget.isPending}>Create Web target</button>
      </form> : null}
      <DataState
        isLoading={targets.isLoading}
        error={targets.error}
        isEmpty={targets.data?.items.length === 0}
        emptyLabel="No targets."
      >
        <ul className="resource-list">
          {targets.data?.items.map((target) => (
            <li key={target.targetId}>
              {target.displayName} <span className="muted">({target.kind}, v{target.version}, Runner {target.runnerId})</span>
            </li>
          ))}
        </ul>
      </DataState>

      <h2>PRD revisions</h2>
      <DataState
        isLoading={prds.isLoading}
        error={prds.error}
        isEmpty={prds.data?.items.length === 0}
        emptyLabel="No PRD revisions."
      >
        <ul className="resource-list">
          {prds.data?.items.map((prd) => (
            <li key={prd.prdId}>
              <Link
                to="/projects/$projectId/prd/$revision"
                params={{ projectId, revision: String(prd.revision) }}
              >
                r{prd.revision}: {prd.title}
              </Link>
              <DefinitionList items={[["content sha256", prd.contentSha256]]} />
            </li>
          ))}
        </ul>
      </DataState>
    </section>
  );
}

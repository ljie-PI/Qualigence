import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { CreateProjectBody, TargetDto } from "@qualigence/public-api";
import { ApiClientError } from "../../api/errors.js";
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
  const [kind, setKind] = useState<"web" | "desktop">("web");
  const [startUrl, setStartUrl] = useState("https://example.test/");
  const [executable, setExecutable] = useState("C:\\Apps\\Reference\\Reference.exe");
  const [selectedTargetId, setSelectedTargetId] = useState<string | undefined>();
  const [conflict, setConflict] = useState<string | undefined>();
  const [prdTitle, setPrdTitle] = useState("");
  const [prdContent, setPrdContent] = useState("");
  const [prdError, setPrdError] = useState<string | undefined>();

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
    mutationFn: () => {
      const current = targets.data?.items.find((target) => target.targetId === (selectedTargetId ?? targetId.trim()));
      return api.createTarget(projectId, {
      targetId: targetId.trim(), displayName: targetName.trim(), runnerId: runnerId.trim(), expectedVersion: 0,
      ...(current === undefined ? {} : { targetId: current.targetId, expectedVersion: current.version }),
      configuration: kind === "web"
        ? { kind: "web", startUrl, allowedOrigins: [new URL(startUrl).origin], browser: "chromium" }
        : { kind: "desktop", app: current?.configuration.kind === "desktop"
          ? { ...current.configuration.app, launch: { ...current.configuration.app.launch, executable } }
          : { targetId: targetId.trim(), platform: "windows", launch: { executable, args: [] }, process: { expectedImageName: executable.split(/[\\/]/).at(-1) ?? "app.exe", allowedChildImageNames: [] }, window: {}, reset: { command: executable, args: ["--reset"], timeoutMs: 30_000 }, shutdown: { gracefulTimeoutMs: 10_000, forceAfterTimeout: true } } },
      }, { idempotencyKey: crypto.randomUUID() });
    },
    onSuccess: () => { setConflict(undefined); setSelectedTargetId(undefined); setTargetId(""); setTargetName(""); setRunnerId(""); void queryClient.invalidateQueries({ queryKey: queryKeys.targets(tenantId, projectId) }); },
    onError: (error: unknown) => {
      if (error instanceof ApiClientError && error.code === "VersionConflict") {
        const actual = error.details?.actualVersion;
        setConflict(`Target changed concurrently${typeof actual === "number" ? ` (current version ${actual})` : ""}. Reloaded current state.`);
        void queryClient.invalidateQueries({ queryKey: queryKeys.targets(tenantId, projectId) });
      } else setConflict(error instanceof Error ? error.message : "Target mutation failed");
    },
  });
  const ingestPrd = useMutation({
    mutationFn: () => api.ingestPrd(
      projectId,
      { title: prdTitle.trim(), content: prdContent },
      { idempotencyKey: crypto.randomUUID() },
    ),
    onSuccess: () => {
      setPrdTitle("");
      setPrdContent("");
      setPrdError(undefined);
      void queryClient.invalidateQueries({ queryKey: queryKeys.prdRevisions(tenantId, projectId) });
    },
    onError: (error: unknown) => {
      setPrdError(error instanceof Error ? error.message : "PRD ingestion failed");
    },
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
        <select aria-label="Target kind" value={kind} onChange={(event) => setKind(event.target.value as "web" | "desktop")}><option value="web">Web</option><option value="desktop">Windows Desktop</option></select>
        {kind === "web"
          ? <input aria-label="Start URL" value={startUrl} onChange={(event) => setStartUrl(event.target.value)} />
          : <input aria-label="Desktop executable" value={executable} onChange={(event) => setExecutable(event.target.value)} />}
        <button type="submit" disabled={createTarget.isPending}>{selectedTargetId === undefined ? "Create Target revision" : "Update Target revision"}</button>
      </form> : null}
      {conflict === undefined ? null : <p className="state state--error" role="alert">{conflict}</p>}
      <DataState
        isLoading={targets.isLoading}
        error={targets.error}
        isEmpty={targets.data?.items.length === 0}
        emptyLabel="No targets."
      >
        <ul className="resource-list">
          {targets.data?.items.map((target) => (
            <li key={target.targetId}>
              <TargetRevisionSummary target={target} />
              {canCreate ? <button type="button" onClick={() => { setSelectedTargetId(target.targetId); setTargetId(target.targetId); setTargetName(target.displayName); setRunnerId(target.runnerId); setKind(target.kind); if (target.configuration.kind === "web") setStartUrl(target.configuration.startUrl); else setExecutable(target.configuration.app.launch.executable); }}>Revise v{target.version}</button> : null}
            </li>
          ))}
        </ul>
      </DataState>

      <h2>PRD revisions</h2>
      {canCreate ? <form className="inline-form" onSubmit={(event) => {
        event.preventDefault();
        if (prdTitle.trim().length > 0 && prdContent.trim().length > 0) ingestPrd.mutate();
      }}>
        <input aria-label="PRD title" value={prdTitle} onChange={(event) => setPrdTitle(event.target.value)} placeholder="PRD title" />
        <textarea aria-label="PRD content" value={prdContent} onChange={(event) => setPrdContent(event.target.value)} placeholder="PRD content" />
        <button type="submit" disabled={ingestPrd.isPending || prdTitle.trim().length === 0 || prdContent.trim().length === 0}>Ingest PRD</button>
      </form> : null}
      {prdError === undefined ? null : <p className="state state--error" role="alert">{prdError}</p>}
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

export function TargetRevisionSummary(props: { readonly target: TargetDto }): ReactNode {
  return <div data-testid={`target-${props.target.targetId}`}>
    <strong>{props.target.displayName}</strong>
    <DefinitionList items={[
      ["Kind", props.target.kind],
      ["Revision", `v${props.target.version}`],
      ["Runner", props.target.runnerId],
      ["Snapshot SHA-256", props.target.snapshotHash],
      ["Approved configuration", <code key="config">{JSON.stringify(props.target.configuration)}</code>],
    ]} />
  </div>;
}

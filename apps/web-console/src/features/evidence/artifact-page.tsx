import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useServices, useSession } from "../../auth/session-context.js";
import { queryKeys } from "../../routes/query-keys.js";
import { DataState, DefinitionList } from "../../ui/components.js";

/**
 * Public Evidence route only. The Console does not learn Artifact storage or
 * KMS details; an inaccessible Artifact deliberately has the same visible
 * state as an absent one.
 */
export function ArtifactPage(props: {
  readonly projectId: string;
  readonly runId: string;
  readonly artifactId: string;
}): ReactNode {
  const { api } = useServices();
  const session = useSession();
  const tenantId = session?.tenantId ?? "";
  const artifactIdentity = useMemo(
    () => `${props.projectId}/${props.runId}/${props.artifactId}`,
    [props.projectId, props.runId, props.artifactId],
  );
  const [download, setDownload] = useState<{ readonly identity: string; readonly url: string } | undefined>();
  useEffect(() => () => {
    if (download !== undefined) URL.revokeObjectURL(download.url);
  }, [download]);
  useEffect(() => {
    setDownload((current) => current?.identity === artifactIdentity ? current : undefined);
  }, [artifactIdentity]);
  const artifact = useQuery({
    queryKey: queryKeys.artifact(tenantId, props.projectId, props.runId, props.artifactId),
    queryFn: () => api.getArtifactMetadata(props.projectId, props.runId, props.artifactId),
    enabled: session !== undefined,
  });
  const downloadMutation = useMutation({
    mutationFn: () => api.downloadArtifact(props.projectId, props.runId, props.artifactId),
    onSuccess: (bytes) => setDownload({ identity: artifactIdentity, url: URL.createObjectURL(bytes) }),
  });

  const denied = artifact.error !== null && artifact.error !== undefined;
  return <section>
    <p><Link to="/runs/$runId" params={{ runId: props.runId }}>← Run</Link></p>
    <h1>Artifact {props.artifactId}</h1>
    {denied ? <p className="state state--error" role="alert">Artifact is unavailable.</p> : <DataState isLoading={artifact.isLoading} error={undefined} isEmpty={artifact.data === undefined}>
      {artifact.data === undefined ? null : <>
        <DefinitionList items={[
          ["Kind", artifact.data.kind],
          ["Media type", artifact.data.mediaType],
          ["Size", String(artifact.data.size)],
          ["SHA-256", artifact.data.sha256],
          ["Download", artifact.data.downloadAllowed ? "Authorized" : "Not authorized"],
        ]} />
        {artifact.data.downloadAllowed ? <button type="button" onClick={() => downloadMutation.mutate()} disabled={downloadMutation.isPending}>Download authorized Artifact</button> : null}
        {downloadMutation.isError ? <p className="state state--error" role="alert">Artifact download is unavailable.</p> : null}
        {download === undefined || download.identity !== artifactIdentity ? null : <a href={download.url} download={`artifact-${props.artifactId}`}>Save authorized Artifact</a>}
      </>}
    </DataState>}
  </section>;
}

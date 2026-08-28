import { useState, type ReactNode } from "react";
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
  const [downloadUrl, setDownloadUrl] = useState<string | undefined>();
  const artifact = useQuery({
    queryKey: queryKeys.artifact(tenantId, props.projectId, props.runId, props.artifactId),
    queryFn: () => api.getArtifactMetadata(props.projectId, props.runId, props.artifactId),
    enabled: session !== undefined,
  });
  const download = useMutation({
    mutationFn: () => api.downloadArtifact(props.projectId, props.runId, props.artifactId),
    onSuccess: (bytes) => {
      if (downloadUrl !== undefined) URL.revokeObjectURL(downloadUrl);
      setDownloadUrl(URL.createObjectURL(bytes));
    },
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
        {artifact.data.downloadAllowed ? <button type="button" onClick={() => download.mutate()} disabled={download.isPending}>Download authorized Artifact</button> : null}
        {download.isError ? <p className="state state--error" role="alert">Artifact download is unavailable.</p> : null}
        {downloadUrl === undefined ? null : <a href={downloadUrl} download={`artifact-${props.artifactId}`}>Save authorized Artifact</a>}
      </>}
    </DataState>}
  </section>;
}

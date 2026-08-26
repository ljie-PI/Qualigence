import type { RunnerSession } from "@qualigence/grpc-runner-protocol";
import type { ExecutionJobLease } from "@qualigence/runner-protocol";
import type { RunnerSpool, SpoolBatchLimit } from "@qualigence/runner-spool";
import { ArtifactUploadPump, type ArtifactUploadSubmitter } from "./artifact-upload-pump.js";
import { RunnerAppError } from "./errors.js";
import { TraceUploadPump } from "./trace-upload-pump.js";

/**
 * Replays only durable upload side effects already recorded in the Runner Spool.
 * It intentionally does not re-execute actions or replay completion decisions:
 * completion outcome remains unknown after a transport loss, while Artifact
 * uploads are always drained before Trace so Trace references never advance
 * ahead of their durable Artifact ACK.
 */
export async function replayPendingRuns(
  session: RunnerSession,
  spool: RunnerSpool,
  signal?: AbortSignal,
): Promise<readonly string[]> {
  const pendingRunIds = await loadPendingRunIds(spool);
  for (const runId of pendingRunIds) {
    signal?.throwIfAborted();
    const artifacts = await loadPendingArtifacts(spool, runId);
    if (artifacts.length > 0) {
      const lease = await loadLeaseForRun(spool, runId);
      if (lease === undefined) {
        throw new RunnerAppError(
          "TransportError",
          `cannot replay artifact uploads for run ${runId} without a persisted lease`,
        );
      }
      await new ArtifactUploadPump(spool, artifactSubmitter(session), lease).drain(runId, signal);
    }
    await new TraceUploadPump(spool, session, runId, batchLimit(session)).drain(signal);
  }
  return pendingRunIds;
}

async function loadPendingRunIds(spool: RunnerSpool): Promise<readonly string[]> {
  if (spool.pendingRunIds === undefined) {
    throw new RunnerAppError("TransportError", "runner spool does not support pending run recovery");
  }
  return spool.pendingRunIds();
}

async function loadPendingArtifacts(spool: RunnerSpool, runId: string) {
  if (spool.pendingArtifactManifests === undefined) {
    return [];
  }
  return spool.pendingArtifactManifests(runId);
}

async function loadLeaseForRun(
  spool: RunnerSpool,
  runId: string,
): Promise<ExecutionJobLease | undefined> {
  return spool.loadLeaseForRun?.(runId);
}

function batchLimit(session: RunnerSession): SpoolBatchLimit {
  return {
    maximumEvents: session.welcome.traceBatchMaximumEvents,
    maximumBytes: session.welcome.traceBatchMaximumBytes,
  };
}

function artifactSubmitter(session: RunnerSession): ArtifactUploadSubmitter {
  if (session.registerArtifactManifest === undefined || session.uploadArtifactChunk === undefined) {
    throw new RunnerAppError("TransportError", "active session does not support artifact upload");
  }
  return {
    registerArtifactManifest: session.registerArtifactManifest.bind(session),
    uploadArtifactChunk: session.uploadArtifactChunk.bind(session),
  };
}

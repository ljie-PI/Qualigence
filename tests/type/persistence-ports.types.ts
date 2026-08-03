// This file is verified by `pnpm typecheck`; Vitest should not execute it.
import type {
  ArtifactManifest,
  ArtifactManifestStore,
  ArtifactStore,
  ArtifactWriteRequest,
  ExecutionRunRecord,
  ModelInvocationStore,
  ModelInvocationSummary,
  RunStore,
  RunTerminalUpdate,
} from "@qualigence/evidence";

declare const runs: RunStore;
declare const artifacts: ArtifactStore;
declare const manifests: ArtifactManifestStore;
declare const invocations: ModelInvocationStore;

void runs.get("run-1");

const manifest: ArtifactManifest = {
  artifactId: "a1",
  runId: "run-1",
  kind: "screenshot",
  mediaType: "image/png",
  relativePath: "run-1/a.png",
  sha256: "0".repeat(64),
  size: 1,
  createdAt: "2026-08-01T00:00:00.000Z",
};

void artifacts.verify(manifest);
void manifests.append(manifest);
void manifests.listForRun("run-1");

const writeRequest: ArtifactWriteRequest = {
  artifactId: "a1",
  runId: "run-1",
  name: "a.png",
  kind: "screenshot",
  mediaType: "image/png",
  bytes: new Uint8Array([1, 2, 3]),
};

void artifacts.write(writeRequest);

const runningRecord: ExecutionRunRecord = {
  runId: "run-1",
  jobId: "job-1",
  targetKind: "web",
  objective: "verify checkout total",
  status: "running",
  nextSequenceNumber: 1,
  createdAt: "2026-08-01T00:00:00.000Z",
};

void runs.create(runningRecord);

const terminal: RunTerminalUpdate = {
  status: "passed",
  completedAt: "2026-08-01T00:00:01.000Z",
};

void runs.complete("run-1", terminal);

const invalidTerminal: RunTerminalUpdate = {
  // @ts-expect-error a terminal update cannot leave a run in the running state
  status: "running",
  completedAt: "2026-08-01T00:00:01.000Z",
};

void invalidTerminal;

const summary: ModelInvocationSummary = {
  invocationId: "inv-1",
  runId: "run-1",
  operation: "execution.decision",
  model: "compatible-model",
  status: "succeeded",
  latencyMs: 12,
  occurredAt: "2026-08-01T00:00:02.000Z",
};

void invocations.append(summary);
void invocations.listForRun("run-1");

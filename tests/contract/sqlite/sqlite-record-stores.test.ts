import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ArtifactManifest,
  ExecutionRunRecord,
  ModelInvocationSummary,
  RunTerminalUpdate,
} from "@qualigence/evidence";
import {
  SqliteArtifactManifestStore,
  SqliteModelInvocationStore,
  SqliteRunStore,
  SqliteRuntime,
  SqliteRuntimeError,
} from "@qualigence/sqlite-runtime";

let dir: string;
let filename: string;

beforeEach(async () => {
  dir = await mkdtemp(join(process.cwd(), ".tmp-records-"));
  filename = join(dir, "qualigence.db");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function openRuntime(): Promise<SqliteRuntime> {
  return SqliteRuntime.open({ filename, busyTimeoutMs: 5_000 });
}

function runningRun(runId: string): ExecutionRunRecord {
  return {
    runId,
    jobId: "job-1",
    targetKind: "web",
    objective: "verify checkout",
    status: "running",
    nextSequenceNumber: 1,
    createdAt: "2026-08-01T00:00:00.000Z",
  };
}

function passedAt(at: string): RunTerminalUpdate {
  return { status: "passed", completedAt: at };
}

function manifest(artifactId: string): ArtifactManifest {
  return {
    artifactId,
    runId: "run-1",
    kind: "screenshot",
    mediaType: "image/png",
    relativePath: `run-1/${artifactId}.png`,
    sha256: "a".repeat(64),
    size: 128,
    createdAt: "2026-08-01T00:01:00.000Z",
  };
}

function summary(invocationId: string): ModelInvocationSummary {
  return {
    invocationId,
    runId: "run-1",
    operation: "plan",
    model: "gpt-x",
    status: "succeeded",
    latencyMs: 1200,
    inputTokens: 512,
    outputTokens: 256,
    providerRequestId: "req-42",
    occurredAt: "2026-08-01T00:02:00.000Z",
  };
}

describe("SqliteRunStore", () => {
  it("creates, completes idempotently, and reopens a run", async () => {
    const runtime = await openRuntime();
    const runs = new SqliteRunStore(runtime);

    await runs.create(runningRun("run-1"));
    expect(await runs.complete("run-1", passedAt("2026-08-01T00:05:00.000Z"))).toBe(
      "completed",
    );
    expect(await runs.complete("run-1", passedAt("2026-08-01T00:05:00.000Z"))).toBe(
      "duplicate",
    );
    await runtime.close();

    const reopened = await openRuntime();
    const record = await new SqliteRunStore(reopened).get("run-1");
    expect(record).toMatchObject({
      runId: "run-1",
      status: "passed",
      completedAt: "2026-08-01T00:05:00.000Z",
    });
    await reopened.close();
  });

  it("rejects completing a run with a conflicting terminal value", async () => {
    const runtime = await openRuntime();
    const runs = new SqliteRunStore(runtime);

    await runs.create(runningRun("run-1"));
    await runs.complete("run-1", passedAt("2026-08-01T00:05:00.000Z"));

    await expect(
      runs.complete("run-1", {
        status: "finding",
        completedAt: "2026-08-01T00:09:00.000Z",
      }),
    ).rejects.toBeInstanceOf(SqliteRuntimeError);
    await runtime.close();
  });
});

describe("SqliteArtifactManifestStore", () => {
  it("appends manifests idempotently and lists them after reopen", async () => {
    const runtime = await openRuntime();
    const runs = new SqliteRunStore(runtime);
    await runs.create(runningRun("run-1"));

    const store = new SqliteArtifactManifestStore(runtime);
    expect(await store.append(manifest("art-1"))).toBe("accepted");
    expect(await store.append(manifest("art-1"))).toBe("duplicate");
    expect(await store.append(manifest("art-2"))).toBe("accepted");
    await runtime.close();

    const reopened = await openRuntime();
    const listed = await new SqliteArtifactManifestStore(reopened).listForRun(
      "run-1",
    );
    expect(listed.map((m) => m.artifactId)).toEqual(["art-1", "art-2"]);
    expect(listed[0]).toMatchObject({
      relativePath: "run-1/art-1.png",
      sha256: "a".repeat(64),
      size: 128,
    });
    await reopened.close();
  });
});

describe("SqliteModelInvocationStore", () => {
  it("appends model summaries and lists them after reopen", async () => {
    const runtime = await openRuntime();
    const runs = new SqliteRunStore(runtime);
    await runs.create(runningRun("run-1"));

    const store = new SqliteModelInvocationStore(runtime);
    await store.append(summary("inv-1"));
    await store.append(summary("inv-1"));
    await store.append(summary("inv-2"));
    await runtime.close();

    const reopened = await openRuntime();
    const listed = await new SqliteModelInvocationStore(reopened).listForRun(
      "run-1",
    );
    expect(listed.map((s) => s.invocationId)).toEqual(["inv-1", "inv-2"]);
    expect(listed[0]).toMatchObject({
      operation: "plan",
      model: "gpt-x",
      status: "succeeded",
      latencyMs: 1200,
      inputTokens: 512,
      outputTokens: 256,
      providerRequestId: "req-42",
    });
    await reopened.close();
  });
});

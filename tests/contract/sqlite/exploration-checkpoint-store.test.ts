import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteBenchmarkStore, SqliteRuntime } from "@qualigence/sqlite-runtime";
import type {
  ExplorationBudgetSnapshot,
  ExplorationInFlightAction,
  ExplorationSeedCursor,
} from "@qualigence/mission";

let dir: string;
let runtime: SqliteRuntime;
let store: SqliteBenchmarkStore;
let nowCounter: number;

const remaining: ExplorationBudgetSnapshot = {
  remainingSteps: 4,
  remainingWallClockMs: 30_000,
  remainingModelTokens: 1_000,
  remainingStateVisits: 3,
  remainingRecoveries: 1,
};

const seedCursor: ExplorationSeedCursor = {
  nextSeedIndex: 0,
  completedSeedSkillBundleIds: [],
};

const inFlight: ExplorationInFlightAction = {
  step: 1,
  actionDigest: "action-digest-1",
  actionJson: JSON.stringify({ kind: "click", nodeId: "node-1" }),
};

beforeEach(async () => {
  dir = await mkdtemp(join(process.cwd(), ".tmp-exploration-progress-"));
  runtime = await SqliteRuntime.open({
    filename: join(dir, "qualigence.db"),
    busyTimeoutMs: 5_000,
  });
  nowCounter = 0;
  store = new SqliteBenchmarkStore(runtime, {
    now: () => {
      nowCounter += 1;
      return `2026-08-01T00:00:${nowCounter.toString().padStart(2, "0")}.000Z`;
    },
  });
  await store.saveRun({
    runId: "run-1",
    benchmarkVersion: "benchmark/v1",
    manifestSha256: "manifest-hash",
    profileSha256: "profile-hash",
    groundTruthSha256: "truth-hash",
    createdAt: "2026-08-01T00:00:00.000Z",
  });
});

afterEach(async () => {
  await runtime.close();
  await rm(dir, { recursive: true, force: true });
});

describe("SqliteBenchmarkStore exploration attempt progress", () => {
  it("persists live progress and safe checkpoints before the terminal attempt exists", async () => {
    const created = await store.initializeAttemptProgress({
      attemptId: "attempt-1",
      runId: "run-1",
      sourceBindingHash: "source-hash",
      policyBindingHash: "policy-hash",
      seedBindingHash: "seed-hash",
      phase: "seed_replay",
      seedCursor,
      lastSafeStep: 0,
      remaining,
    });

    const inFlightResult = await store.compareAndSetAttemptProgress({
      attemptId: "attempt-1",
      expectedVersion: created.version,
      phase: "action_in_flight",
      seedCursor,
      lastSafeStep: 0,
      remaining,
      inFlightAction: inFlight,
    });
    expect(inFlightResult.status).toBe("updated");

    const updated = inFlightResult.status === "updated" ? inFlightResult.progress : created;
    const checkpointResult = await store.compareAndSetAttemptProgress({
      attemptId: "attempt-1",
      expectedVersion: updated.version,
      phase: "exploring",
      seedCursor,
      lastSafeStep: 1,
      lastSafeGraphFingerprint: "graph-fp-1",
      remaining: { ...remaining, remainingSteps: 3 },
      checkpoint: {
        step: 1,
        graphFingerprint: "graph-fp-1",
        remaining: { ...remaining, remainingSteps: 3 },
      },
    });

    expect(checkpointResult.status).toBe("updated");
    expect(await store.liveCheckpointsForAttempt("attempt-1")).toEqual([
      {
        step: 1,
        graphFingerprint: "graph-fp-1",
        remaining: { ...remaining, remainingSteps: 3 },
      },
    ]);

    const attempts = await runtime.db.selectFrom("benchmark_attempts").selectAll().execute();
    expect(attempts).toHaveLength(0);
  });

  it("reloads live progress after SQLite restart and enforces CAS", async () => {
    const created = await store.initializeAttemptProgress({
      attemptId: "attempt-restart",
      runId: "run-1",
      sourceBindingHash: "source-hash",
      policyBindingHash: "policy-hash",
      seedBindingHash: "seed-hash",
      phase: "seed_replay",
      seedCursor,
      lastSafeStep: 0,
      remaining,
    });
    await runtime.close();

    runtime = await SqliteRuntime.open({
      filename: join(dir, "qualigence.db"),
      busyTimeoutMs: 5_000,
    });
    store = new SqliteBenchmarkStore(runtime, { now: () => "2026-08-01T00:01:00.000Z" });

    const loaded = await store.loadAttemptProgress("attempt-restart");
    expect(loaded).toMatchObject({
      attemptId: "attempt-restart",
      runId: "run-1",
      phase: "seed_replay",
      remaining,
      version: created.version,
    });

    await expect(store.compareAndSetAttemptProgress({
      attemptId: "attempt-restart",
      expectedVersion: 999,
      phase: "exploring",
      seedCursor,
      lastSafeStep: 0,
      remaining,
    })).resolves.toMatchObject({ status: "conflict" });
  });
});

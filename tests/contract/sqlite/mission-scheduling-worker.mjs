import { parentPort, workerData } from "node:worker_threads";
import { MissionSchedulingService } from "@qualigence/mission";
import { SqlitePrdMissionStore, SqliteRuntime } from "@qualigence/sqlite-runtime";

if (parentPort === null) throw new Error("Mission scheduling worker requires a parent port");

const runtime = await SqliteRuntime.open({ filename: workerData.filename, busyTimeoutMs: 5_000 });
const persisted = new SqlitePrdMissionStore(runtime);
if (workerData.operation === "accept" || workerData.operation === "block") {
  parentPort.postMessage({ type: "loaded" });
  await new Promise((resolve) => parentPort.once("message", resolve));
  try {
    const value = workerData.operation === "accept"
      ? await persisted.markDispatchAccepted(workerData.attemptId, workerData.receipt, workerData.expectedVersion)
      : await persisted.markDispatchBlocked(workerData.attemptId, workerData.expectedVersion);
    parentPort.postMessage({ outcome: { status: "fulfilled", value } });
  } catch (error) {
    parentPort.postMessage({
      outcome: {
        status: "rejected",
        reason: error instanceof Error
          ? { name: error.name, message: error.message, code: error.code, actualVersion: error.actualVersion }
          : error,
      },
    });
  } finally {
    await runtime.close();
  }
  process.exit(0);
}
let allocations = 0;
const ids = {
  allocateAttemptId: () => `attempt-${workerData.allocatorSuffix}-${++allocations}`,
  allocateRunnerJobId: () => `runner-job-${workerData.allocatorSuffix}-${++allocations}`,
  allocateRunId: () => `run-${workerData.allocatorSuffix}-${++allocations}`,
};
const repository = {
  ...persisted,
  replayMissionSchedule: (command) => persisted.replayMissionSchedule(command),
  async loadMissionForScheduling(missionId) {
    const mission = await persisted.loadMissionForScheduling(missionId);
    parentPort.postMessage({ type: "loaded" });
    await new Promise((resolve) => parentPort.once("message", resolve));
    return mission;
  },
  scheduleMission: (input) => persisted.scheduleMission(input),
};

try {
  const value = await new MissionSchedulingService(repository, ids, { now: () => "2026-08-22T00:00:00.000Z" }).start({
    missionId: `mission-${workerData.name}`,
    expectedVersion: workerData.expectedVersion,
    idempotencyKey: workerData.idempotencyKey,
  });
  parentPort.postMessage({ outcome: { status: "fulfilled", value }, allocations });
} catch (error) {
  parentPort.postMessage({
    outcome: {
      status: "rejected",
      reason: error instanceof Error
        ? { name: error.name, message: error.message, code: error.code, actualVersion: error.actualVersion }
        : error,
    },
    allocations,
  });
} finally {
  await runtime.close();
}

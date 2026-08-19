import { randomBytes } from "node:crypto";
import { link, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LauncherError } from "./errors.js";

/** Persisted record of a running Local topology, shared across CLI invocations. */
export interface RuntimeState {
  readonly supervisorPid: number;
  readonly corePid: number;
  readonly runnerPid: number;
  readonly corePort: number;
  readonly dataDir: string;
  readonly startedAt: string;
}

function stateFile(dataDir: string): string {
  return join(dataDir, "runtime-state.json");
}

export async function readRuntimeState(dataDir: string): Promise<RuntimeState | undefined> {
  try {
    const text = await readFile(stateFile(dataDir), "utf8");
    return parseRuntimeState(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function parseRuntimeState(value: unknown): RuntimeState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid runtime state.");
  const state = value as Partial<RuntimeState>;
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "corePid,corePort,dataDir,runnerPid,startedAt,supervisorPid" ||
    !positivePid(state.supervisorPid) || !positivePid(state.corePid) || !positivePid(state.runnerPid) ||
    !Number.isSafeInteger(state.corePort) || (state.corePort ?? 0) <= 0 || (state.corePort ?? 0) > 65_535 ||
    typeof state.dataDir !== "string" || state.dataDir.length === 0 || !canonicalInstant(state.startedAt)) throw new Error("Invalid runtime state.");
  return state as RuntimeState;
}

function positivePid(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function canonicalInstant(value: unknown): value is string { if (typeof value !== "string") return false; const time = Date.parse(value); return Number.isFinite(time) && new Date(time).toISOString() === value; }

export async function writeRuntimeState(state: RuntimeState): Promise<void> {
  const temporary = join(state.dataDir, `runtime-state.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", flag: "wx", flush: true });
  try { await rename(temporary, stateFile(state.dataDir)); }
  finally { await rm(temporary, { force: true }); }
}

export { localStopRequestSchema } from "@qualigence/local-control";
export type { LocalStopRequest } from "@qualigence/local-control";
import { localStopRequestSchema } from "@qualigence/local-control";
import type { LocalStopRequest } from "@qualigence/local-control";
export function parseStopRequest(value: unknown): LocalStopRequest { return localStopRequestSchema.parse(value); }

export function stopRequestMatchesTopology(
  marker: LocalStopRequest,
  topology: Pick<RuntimeState, "supervisorPid" | "corePid" | "runnerPid" | "startedAt">,
  now: number,
  maximumAgeMs: number,
): boolean {
  const requestedAt = Date.parse(marker.requestedAt);
  return marker.supervisorPid === topology.supervisorPid &&
    marker.corePid === topology.corePid &&
    marker.runnerPid === topology.runnerPid &&
    marker.startedAt === topology.startedAt &&
    requestedAt <= now &&
    now - requestedAt <= maximumAgeMs;
}

export async function publishStopRequest(dataDir: string, marker: LocalStopRequest): Promise<void> {
  const canonical = join(dataDir, "local-stop-request.json");
  const temporary = join(dataDir, `local-stop-request.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  await writeFile(temporary, JSON.stringify(marker), { encoding: "utf8", flag: "wx", flush: true });
  try {
    for (;;) {
      try { await link(temporary, canonical); return; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const claimed = join(dataDir, `local-stop-request.${process.pid}.${randomBytes(8).toString("hex")}.claimed`);
      try {
        await rename(canonical, claimed);
      } catch {
        continue;
      }
      let existing: LocalStopRequest | undefined;
      try {
        existing = parseStopRequest(JSON.parse(await readFile(claimed, "utf8")));
      } catch {
        existing = undefined;
      }
      if (existing !== undefined) {
        try { await link(claimed, canonical); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      await rm(claimed, { force: true });
      if (existing === undefined) continue;
      if (sameTopology(existing, marker)) {
        const current = await readFile(canonical, "utf8").catch(() => undefined);
        if (current !== undefined) {
          try {
            if (sameTopology(parseStopRequest(JSON.parse(current)), marker)) return;
          } catch { /* retry through the atomic claim path */ }
        }
        continue;
      }
      throw new LauncherError("StopRequestInvalid", "a stop request for a different topology already exists");
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function claimMatchingStopRequest(
  dataDir: string,
  topology: Pick<RuntimeState, "supervisorPid" | "corePid" | "runnerPid" | "startedAt">,
  now: number,
  maximumAgeMs: number,
  claimantPid: number,
): Promise<boolean> {
  const canonical = join(dataDir, "local-stop-request.json");
  const claim = join(dataDir, `local-stop-request.${claimantPid}.claim`);
  try {
    await rename(canonical, claim);
  } catch {
    return false;
  }
  try {
    const marker = parseStopRequest(JSON.parse(await readFile(claim, "utf8")));
    const state = await readRuntimeState(dataDir);
    return state !== undefined && sameTopology(state, topology) &&
      stopRequestMatchesTopology(marker, topology, now, maximumAgeMs);
  } catch {
    return false;
  } finally {
    await rm(claim, { force: true });
  }
}

export function sameTopology(left: Pick<RuntimeState, "supervisorPid" | "corePid" | "runnerPid" | "startedAt">, right: Pick<RuntimeState, "supervisorPid" | "corePid" | "runnerPid" | "startedAt">): boolean {
  return left.supervisorPid === right.supervisorPid && left.corePid === right.corePid && left.runnerPid === right.runnerPid && left.startedAt === right.startedAt;
}

export async function clearRuntimeState(dataDir: string): Promise<void> {
  await rm(stateFile(dataDir), { force: true });
}

export async function clearOwnedTopologyFiles(dataDir: string, topology: Pick<RuntimeState, "supervisorPid" | "corePid" | "runnerPid" | "startedAt">): Promise<void> {
  for (const path of [join(dataDir, "local-stop-request.json"), join(dataDir, `local-stop-request.${topology.supervisorPid}.claim`)]) {
    try {
      const marker = parseStopRequest(JSON.parse(await readFile(path, "utf8")));
      if (sameTopology(marker, topology)) await rm(path, { force: true });
    } catch {
      // A malformed or differently owned marker is not ours to remove.
    }
  }
  const claimedState = join(dataDir, `runtime-state.${process.pid}.${randomBytes(8).toString("hex")}.claim`);
  try {
    await rename(stateFile(dataDir), claimedState);
  } catch {
    return;
  }
  let claimed: RuntimeState | undefined;
  try {
    claimed = parseRuntimeState(JSON.parse(await readFile(claimedState, "utf8")));
  } catch {
    claimed = undefined;
  }
  if (claimed !== undefined && sameTopology(claimed, topology)) {
    await rm(claimedState, { force: true });
    return;
  }
  try {
    await link(claimedState, stateFile(dataDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    await rm(claimedState, { force: true });
  }
}

/** True when the OS process for `pid` is alive (and we may signal it). */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A running topology exists only if both recorded PIDs are still alive. */
export function isTopologyRunning(state: RuntimeState | undefined): state is RuntimeState {
  return (
    state !== undefined && isPidAlive(state.supervisorPid) && isPidAlive(state.corePid) && isPidAlive(state.runnerPid)
  );
}

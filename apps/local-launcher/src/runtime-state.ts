import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Persisted record of a running Local topology, shared across CLI invocations. */
export interface RuntimeState {
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
    return JSON.parse(text) as RuntimeState;
  } catch {
    return undefined;
  }
}

export async function writeRuntimeState(state: RuntimeState): Promise<void> {
  await writeFile(stateFile(state.dataDir), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function clearRuntimeState(dataDir: string): Promise<void> {
  await rm(stateFile(dataDir), { force: true });
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
    state !== undefined && isPidAlive(state.corePid) && isPidAlive(state.runnerPid)
  );
}

import {
  aggregateHealthStatus,
  type HealthCheck,
  type HealthReport,
} from "@qualigence/local-control";
import { LauncherError } from "./errors.js";

/**
 * One supervised child process (Core or Runner). Concrete implementations spawn
 * and monitor a real OS process; the supervisor only coordinates ordering,
 * rollback, shutdown and status across units.
 */
export interface ProcessUnit {
  readonly name: string;
  /** Spawn and block until the process reports ready, or throw a coded error. */
  start(signal?: AbortSignal): Promise<void>;
  /** Terminate the process gracefully (SIGTERM then SIGKILL after a grace). */
  stop(): Promise<void>;
  /** Deep readiness checks (may touch the database/artifact store/disk). */
  readinessChecks(): Promise<readonly HealthCheck[]>;
  /** Cheap liveness checks that never touch the database or model. */
  livenessChecks(): Promise<readonly HealthCheck[]>;
}

/** Exclusive single-instance guard over the data directory. */
export interface DataDirLock {
  acquire(): Promise<void>;
  release(): Promise<void>;
}

export interface ProcessSupervisorOptions {
  readonly version: string;
  readonly units: readonly ProcessUnit[];
  readonly lock?: DataDirLock;
}

/**
 * Orchestrates the ordered start, reverse-order rollback/shutdown and health
 * aggregation of the Local Launcher's child processes. The supervisor holds a
 * single-instance lock for the lifetime of a started topology so a second
 * `start` fails fast with `AlreadyRunning` rather than double-binding ports.
 */
export class ProcessSupervisor {
  private readonly recorded: string[] = [];
  private readonly running: ProcessUnit[] = [];
  private locked = false;

  constructor(private readonly options: ProcessSupervisorOptions) {}

  /** The ordered lifecycle events observed so far (`name:event`). */
  events(): readonly string[] {
    return [...this.recorded];
  }

  async start(signal?: AbortSignal): Promise<HealthReport> {
    if (this.running.length > 0) {
      throw new LauncherError("AlreadyRunning", "the launcher topology is already running");
    }
    await this.acquireLock();
    try {
      for (const unit of this.options.units) {
        this.record(`${unit.name}:start`);
        await unit.start(signal);
        this.running.push(unit);
        this.record(`${unit.name}:ready`);
      }
    } catch (error) {
      await this.rollback();
      await this.releaseLock();
      throw error;
    }
    return this.status();
  }

  async stop(): Promise<void> {
    await this.rollback();
    await this.releaseLock();
  }

  async status(): Promise<HealthReport> {
    const checks: HealthCheck[] = [];
    for (const unit of this.options.units) {
      checks.push(...(await unit.readinessChecks()));
    }
    return {
      status: aggregateHealthStatus(checks),
      version: this.options.version,
      checks,
    };
  }

  async liveness(): Promise<HealthReport> {
    const checks: HealthCheck[] = [];
    for (const unit of this.options.units) {
      checks.push(...(await unit.livenessChecks()));
    }
    return {
      status: aggregateHealthStatus(checks),
      version: this.options.version,
      checks,
    };
  }

  private async rollback(): Promise<void> {
    // Stop already-started units in reverse order so dependants shut down first.
    while (this.running.length > 0) {
      const unit = this.running.pop() as ProcessUnit;
      this.record(`${unit.name}:stop`);
      await unit.stop();
    }
  }

  private async acquireLock(): Promise<void> {
    if (this.options.lock === undefined) {
      return;
    }
    await this.options.lock.acquire();
    this.locked = true;
  }

  private async releaseLock(): Promise<void> {
    if (this.options.lock === undefined || !this.locked) {
      return;
    }
    await this.options.lock.release();
    this.locked = false;
  }

  private record(event: string): void {
    this.recorded.push(event);
  }
}

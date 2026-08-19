import { connect } from "node:net";
import { access, constants, statfs } from "node:fs/promises";
import { join } from "node:path";
import { writeFile, rm } from "node:fs/promises";
import BetterSqlite3 from "better-sqlite3";
import {
  aggregateHealthStatus,
  type HealthCheck,
  type HealthReport,
} from "@qualigence/local-control";
import { isPidAlive } from "./child-process-unit.js";
import { request } from "node:http";

const DEFAULT_MIN_FREE_DISK_BYTES = 256 * 1024 * 1024;
const LOW_FREE_DISK_BYTES = 1024 * 1024 * 1024;
const PORT_PROBE_TIMEOUT_MS = 500;

function check(
  name: HealthCheck["name"],
  status: HealthCheck["status"],
  safeMessage: string,
  code?: string,
): HealthCheck {
  return code === undefined
    ? { name, status, safeMessage }
    : { name, status, safeMessage, code };
}

/** Everything the health client needs to probe a running local topology. */
export interface HealthTarget {
  readonly coreHost: string;
  readonly corePort: number;
  readonly dbFile: string;
  readonly artifactDir: string;
  readonly spoolFile?: string;
  readonly corePid?: number;
  readonly runnerPid?: number;
  readonly minFreeDiskBytes?: number;
}

/**
 * Probes a running Local topology and folds the results into a
 * {@link HealthReport}. Liveness is deliberately cheap — it only checks process
 * presence and whether the Core port accepts a connection, never opening the
 * database — while readiness performs the deeper database/artifact/spool/disk
 * checks. No secret or credential value ever reaches a check message.
 */
export class HealthClient {
  constructor(private readonly version: string) {}

  async liveness(target: HealthTarget): Promise<HealthReport> {
    const checks: HealthCheck[] = [
      await this.checkCorePort(target.coreHost, target.corePort),
    ];
    if (target.runnerPid !== undefined) {
      checks.push(this.checkProcess("runner", target.runnerPid));
    }
    return this.report(checks);
  }

  async readiness(target: HealthTarget): Promise<HealthReport> {
    const checks: HealthCheck[] = [
      await this.checkDatabase(target.dbFile),
      await this.checkArtifactStore(target.artifactDir),
      await this.checkRunner(target.runnerPid),
      await this.checkDisk(target.dbFile, target.minFreeDiskBytes),
    ];
    if (target.spoolFile !== undefined) {
      checks.push(await this.checkSpool(target.spoolFile));
    }
    return this.report(checks);
  }

  private report(checks: readonly HealthCheck[]): HealthReport {
    return {
      status: aggregateHealthStatus(checks),
      version: this.version,
      checks,
    };
  }

  async checkCorePort(host: string, port: number): Promise<HealthCheck> {
    const open = await this.isPortOpen(host, port);
    return check(
      "database",
      open ? "pass" : "fail",
      open
        ? `core port ${host}:${port} is listening`
        : `core port ${host}:${port} is not listening`,
      open ? undefined : "CorePortClosed",
    );
  }

  async coreHealth(host: string, port: number, path: "/health/internal-ready" | "/health/ready"): Promise<HealthCheck> {
    const ok = await new Promise<boolean>((resolve) => {
      const probe = request({ host, port, path, method: "GET", timeout: PORT_PROBE_TIMEOUT_MS }, (response) => { response.resume(); resolve(response.statusCode === 200); });
      probe.once("error", () => resolve(false)); probe.once("timeout", () => { probe.destroy(); resolve(false); }); probe.end();
    });
    return check("runner", ok ? "pass" : "fail", ok ? `${path} is ready` : `${path} is unavailable`, ok ? undefined : "CoreNotReady");
  }

  async checkDatabase(dbFile: string): Promise<HealthCheck> {
    try {
      const database = new BetterSqlite3(dbFile, { readonly: true, fileMustExist: true });
      try {
        const row = database
          .prepare(
            "SELECT MAX(version) AS version FROM schema_migrations",
          )
          .get() as { version: number | null } | undefined;
        const version = Number(row?.version ?? 0);
        return {
          name: "database",
          status: "pass",
          safeMessage: `database reachable at schema version ${version}`,
        };
      } finally {
        database.close();
      }
    } catch {
      return {
        name: "database",
        status: "fail",
        code: "DatabaseUnreachable",
        safeMessage: "database file is missing or unreadable",
      };
    }
  }

  async checkArtifactStore(artifactDir: string): Promise<HealthCheck> {
    try {
      await access(artifactDir, constants.W_OK);
    } catch {
      return {
        name: "artifact_store",
        status: "fail",
        code: "ArtifactStoreUnwritable",
        safeMessage: "artifact store directory is missing or not writable",
      };
    }
    const marker = join(artifactDir, `.health-${process.pid}-${Date.now()}`);
    try {
      await writeFile(marker, "ok");
      await rm(marker, { force: true });
    } catch {
      return {
        name: "artifact_store",
        status: "warn",
        code: "ArtifactStoreProbeFailed",
        safeMessage: "artifact store exists but a write probe failed",
      };
    }
    return {
      name: "artifact_store",
      status: "pass",
      safeMessage: "artifact store is writable",
    };
  }

  async checkRunner(runnerPid?: number): Promise<HealthCheck> {
    if (runnerPid === undefined) {
      return {
        name: "runner",
        status: "warn",
        code: "RunnerUnknown",
        safeMessage: "runner process is not registered with the launcher",
      };
    }
    return this.checkProcess("runner", runnerPid);
  }

  async checkSpool(spoolFile: string): Promise<HealthCheck> {
    try {
      await access(spoolFile, constants.R_OK);
      return { name: "spool", status: "pass", safeMessage: "runner spool is present" };
    } catch {
      return {
        name: "spool",
        status: "warn",
        code: "SpoolAbsent",
        safeMessage: "runner spool has not been created yet",
      };
    }
  }

  async checkDisk(path: string, minFreeBytes?: number): Promise<HealthCheck> {
    const min = minFreeBytes ?? DEFAULT_MIN_FREE_DISK_BYTES;
    try {
      const stats = await statfs(path);
      const freeBytes = stats.bsize * stats.bavail;
      if (freeBytes < min) {
        return {
          name: "disk",
          status: "fail",
          code: "DiskLow",
          safeMessage: `only ${freeBytes} bytes free below the ${min} byte floor`,
        };
      }
      if (freeBytes < LOW_FREE_DISK_BYTES) {
        return {
          name: "disk",
          status: "warn",
          code: "DiskWarning",
          safeMessage: `${freeBytes} bytes free is approaching the low-space threshold`,
        };
      }
      return { name: "disk", status: "pass", safeMessage: `${freeBytes} bytes free` };
    } catch {
      return {
        name: "disk",
        status: "warn",
        code: "DiskUnknown",
        safeMessage: "free disk space could not be determined",
      };
    }
  }

  private checkProcess(name: "runner", pid: number): HealthCheck {
    const alive = isPidAlive(pid);
    return check(
      name,
      alive ? "pass" : "fail",
      alive ? `${name} process is running` : `${name} process is not running`,
      alive ? undefined : "ProcessNotRunning",
    );
  }

  private isPortOpen(host: string, port: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const socket = connect({ host, port });
      const done = (result: boolean): void => {
        socket.destroy();
        resolve(result);
      };
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
      socket.setTimeout(PORT_PROBE_TIMEOUT_MS, () => done(false));
    });
  }
}

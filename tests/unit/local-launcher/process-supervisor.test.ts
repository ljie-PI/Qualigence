import { describe, expect, it, vi } from "vitest";
import {
  ProcessSupervisor,
  type ProcessUnit,
} from "../../../apps/local-launcher/src/process-supervisor.js";
import { LauncherError } from "../../../apps/local-launcher/src/errors.js";
import type { HealthCheck } from "@qualigence/local-control";
import { terminateProcess } from "../../../apps/local-launcher/src/child-process-unit.js";

/** An in-memory {@link ProcessUnit} used to drive supervisor orchestration. */
class FakeProcessUnit implements ProcessUnit {
  private startFailure: LauncherError | undefined;
  private started = false;
  readonly startSpy = vi.fn();
  readonly stopSpy = vi.fn();

  constructor(
    readonly name: string,
    private readonly checkStatus: HealthCheck["status"] = "pass",
  ) {}

  failStart(code: ConstructorParameters<typeof LauncherError>[0]): void {
    this.startFailure = new LauncherError(code, `${this.name} failed to start`);
  }

  async start(): Promise<void> {
    this.startSpy();
    if (this.startFailure !== undefined) {
      throw this.startFailure;
    }
    this.started = true;
  }

  async stop(): Promise<void> {
    this.stopSpy();
    this.started = false;
  }

  isStarted(): boolean {
    return this.started;
  }

  async readinessChecks(): Promise<readonly HealthCheck[]> {
    return [
      {
        name: this.name === "core" ? "database" : "runner",
        status: this.checkStatus,
        safeMessage: `${this.name} readiness`,
      },
    ];
  }

  async livenessChecks(): Promise<readonly HealthCheck[]> {
    return [
      {
        name: this.name === "core" ? "database" : "runner",
        status: this.started ? "pass" : "fail",
        safeMessage: `${this.name} liveness`,
      },
    ];
  }
}

function supervisorWith(
  core: FakeProcessUnit,
  runner: FakeProcessUnit,
  lockHeld = false,
): ProcessSupervisor {
  let locked = lockHeld;
  return new ProcessSupervisor({
    version: "9.9.9",
    units: [core, runner],
    lock: {
      acquire: async () => {
        if (locked) {
          throw new LauncherError("AlreadyRunning", "data dir lock is held");
        }
        locked = true;
      },
      release: async () => {
        locked = false;
      },
    },
  });
}

describe("ProcessSupervisor.start", () => {
  it("starts Core then Runner in order and reports healthy", async () => {
    const core = new FakeProcessUnit("core");
    const runner = new FakeProcessUnit("runner");
    const supervisor = supervisorWith(core, runner);

    const report = await supervisor.start();

    expect(supervisor.events()).toEqual([
      "core:start",
      "core:ready",
      "runner:start",
      "runner:ready",
    ]);
    expect(report.status).toBe("healthy");
    await supervisor.stop();
  });

  it("rolls back a ready Core when the Runner fails to start", async () => {
    const core = new FakeProcessUnit("core");
    const runner = new FakeProcessUnit("runner");
    runner.failStart("RunnerUnhealthy");
    const supervisor = supervisorWith(core, runner);

    await expect(supervisor.start()).rejects.toMatchObject({ code: "RunnerUnhealthy" });

    expect(core.stopSpy).toHaveBeenCalledOnce();
    expect(runner.stopSpy).not.toHaveBeenCalled();
    expect(supervisor.events()).toEqual([
      "core:start",
      "core:ready",
      "runner:start",
      "core:stop",
    ]);
  });

  it("does not start the Runner when the Core fails to start", async () => {
    const core = new FakeProcessUnit("core");
    const runner = new FakeProcessUnit("runner");
    core.failStart("CoreUnhealthy");
    const supervisor = supervisorWith(core, runner);

    await expect(supervisor.start()).rejects.toMatchObject({ code: "CoreUnhealthy" });

    expect(runner.startSpy).not.toHaveBeenCalled();
    expect(core.stopSpy).not.toHaveBeenCalled();
    expect(supervisor.events()).toEqual(["core:start"]);
  });

  it("refuses a second start while the data-dir lock is held", async () => {
    const core = new FakeProcessUnit("core");
    const runner = new FakeProcessUnit("runner");
    const supervisor = supervisorWith(core, runner, true);

    await expect(supervisor.start()).rejects.toMatchObject({ code: "AlreadyRunning" });
    expect(core.startSpy).not.toHaveBeenCalled();
  });

  it("propagates a startup timeout and rolls back", async () => {
    const core = new FakeProcessUnit("core");
    const runner = new FakeProcessUnit("runner");
    runner.failStart("StartupTimedOut");
    const supervisor = supervisorWith(core, runner);

    await expect(supervisor.start()).rejects.toMatchObject({ code: "StartupTimedOut" });
    expect(core.stopSpy).toHaveBeenCalledOnce();
  });
});

describe("ProcessSupervisor.stop", () => {
  it("stops Runner before Core (reverse order)", async () => {
    const core = new FakeProcessUnit("core");
    const runner = new FakeProcessUnit("runner");
    const supervisor = supervisorWith(core, runner);
    await supervisor.start();

    await supervisor.stop();

    expect(supervisor.events()).toEqual([
      "core:start",
      "core:ready",
      "runner:start",
      "runner:ready",
      "runner:stop",
      "core:stop",
    ]);
  });

  it("still stops Core when Runner stop fails, then reports the shutdown error", async () => {
    const core = new FakeProcessUnit("core");
    const runner = new FakeProcessUnit("runner");
    runner.stopSpy.mockImplementationOnce(() => { throw new Error("runner stop failed"); });
    const supervisor = supervisorWith(core, runner);
    await supervisor.start();

    await expect(supervisor.stop()).rejects.toThrow("runner stop failed");

    expect(core.stopSpy).toHaveBeenCalledOnce();
    expect(supervisor.events().slice(-2)).toEqual(["runner:stop", "core:stop"]);
  });

  it("does not report success or discard a unit whose process cannot be reaped", async () => {
    const core = new FakeProcessUnit("core");
    const runner = new FakeProcessUnit("runner");
    runner.stopSpy.mockImplementationOnce(() => { throw new LauncherError("ProcessReapTimedOut", "runner remained alive"); });
    const supervisor = supervisorWith(core, runner);
    await supervisor.start();

    await expect(supervisor.stop()).rejects.toMatchObject({ code: "ProcessReapTimedOut" });
    expect(supervisor.events().slice(-2)).toEqual(["runner:stop", "core:stop"]);
    await expect(supervisor.stop()).resolves.toBeUndefined();
    expect(runner.stopSpy).toHaveBeenCalledTimes(2);
  });
});

describe("terminateProcess", () => {
  it("throws ProcessReapTimedOut when the PID remains alive after SIGKILL", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      await expect(terminateProcess(2_147_000_000, 0)).rejects.toMatchObject({ code: "ProcessReapTimedOut" });
      expect(kill).toHaveBeenCalledWith(2_147_000_000, "SIGKILL");
    } finally { kill.mockRestore(); }
  }, 5_000);
});

describe("ProcessSupervisor.status", () => {
  it("aggregates readiness checks into a single report", async () => {
    const core = new FakeProcessUnit("core");
    const runner = new FakeProcessUnit("runner", "warn");
    const supervisor = supervisorWith(core, runner);
    await supervisor.start();

    const report = await supervisor.status();

    expect(report.version).toBe("9.9.9");
    expect(report.status).toBe("degraded");
    expect(report.checks.map((check) => check.name)).toContain("runner");
    await supervisor.stop();
  });
});

import { describe, expect, it } from "vitest";
import {
  AppTargetAggregate,
  ProjectTargetError,
} from "@qualigence/project-target";

const validTarget = {
  targetId: "wpf-reference",
  platform: "windows",
  launch: {
    executable: "C:\\Apps\\Reference\\Reference.exe",
    args: ["--fixture", "default"],
  },
  process: {
    expectedImageName: "Reference.exe",
    allowedChildImageNames: [],
  },
  window: {},
  reset: { command: "C:\\Apps\\Reference\\Reset.exe", args: [], timeoutMs: 5000 },
  shutdown: { gracefulTimeoutMs: 3000, forceAfterTimeout: true },
};

describe("AppTargetAggregate", () => {
  it("starts at version 0 with no target", () => {
    const aggregate = AppTargetAggregate.create();
    expect(aggregate.version).toBe(0);
    expect(aggregate.target).toBeUndefined();
  });

  it("applies a valid configuration and bumps the version", () => {
    const aggregate = AppTargetAggregate.create();
    const event = aggregate.update({ expectedVersion: 0, target: validTarget });
    expect(event.version).toBe(1);
    expect(event.target.targetId).toBe("wpf-reference");
    expect(aggregate.version).toBe(1);
  });

  it("rejects a stale expectedVersion with a conflict carrying the current truth", () => {
    const aggregate = AppTargetAggregate.create();
    aggregate.update({ expectedVersion: 0, target: validTarget });
    try {
      aggregate.update({ expectedVersion: 0, target: validTarget });
      expect.unreachable("stale write must conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectTargetError);
      const conflict = error as ProjectTargetError;
      expect(conflict.code).toBe("AppTargetVersionConflict");
      expect(conflict.currentVersion).toBe(1);
    }
  });

  it("rejects an invalid configuration without advancing the version", () => {
    const aggregate = AppTargetAggregate.create();
    expect(() =>
      aggregate.update({ expectedVersion: 0, target: { ...validTarget, platform: "linux" } }),
    ).toThrowError(/InvalidAppTargetConfiguration/);
    expect(aggregate.version).toBe(0);
  });

  it("rejects a shell command string via the domain validator", () => {
    const aggregate = AppTargetAggregate.create();
    expect(() =>
      aggregate.update({
        expectedVersion: 0,
        target: { ...validTarget, launch: { command: "app.exe --flag" } },
      }),
    ).toThrowError(/InvalidAppTargetConfiguration/);
  });

  it("rehydrates from a persisted target + version", () => {
    const original = AppTargetAggregate.create();
    const event = original.update({ expectedVersion: 0, target: validTarget });
    const rehydrated = AppTargetAggregate.rehydrate(event.target, event.version);
    expect(rehydrated.version).toBe(1);
    const next = rehydrated.update({ expectedVersion: 1, target: validTarget });
    expect(next.version).toBe(2);
  });
});

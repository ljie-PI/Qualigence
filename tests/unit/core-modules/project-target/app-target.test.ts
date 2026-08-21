import { describe, expect, it } from "vitest";
import {
  AppTargetAggregate,
  createTargetRevision,
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

describe("immutable Target revisions", () => {
  it("creates a project- and Runner-bound Web revision with a stable snapshot hash", () => {
    const input = {
      targetId: "checkout",
      projectId: "project-1",
      displayName: "Checkout",
      runnerId: "runner-1",
      expectedVersion: 0,
      configuration: {
        kind: "web" as const,
        startUrl: "https://shop.example.test/checkout",
        allowedOrigins: ["https://shop.example.test"],
        browser: "chromium" as const,
        authenticationProfileId: "shop-test-user",
      },
    };

    const first = createTargetRevision(input);
    const replay = createTargetRevision(input);

    expect(first).toMatchObject({
      targetId: "checkout",
      projectId: "project-1",
      runnerId: "runner-1",
      version: 1,
      configuration: { kind: "web" },
    });
    expect(first.snapshotHash).toMatch(/^[a-f0-9]{64}$/);
    expect(replay.snapshotHash).toBe(first.snapshotHash);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.configuration)).toBe(true);
  });

  it("creates a Desktop revision from the existing canonical AppTarget contract", () => {
    const revision = createTargetRevision({
      targetId: "wpf-reference",
      projectId: "project-1",
      displayName: "WPF reference",
      runnerId: "runner-windows",
      expectedVersion: 0,
      configuration: { kind: "desktop", app: validTarget },
    });

    expect(revision.configuration).toMatchObject({
      kind: "desktop",
      app: { platform: "windows", targetId: "wpf-reference" },
    });
    expect(revision.configuration).toEqual({ kind: "desktop", app: validTarget });
  });

  it.each([
    ["launch argv", { ...validTarget, launch: { ...validTarget.launch, args: ["--password=hunter2"] } }],
    ["reset argv", { ...validTarget, reset: { ...validTarget.reset, args: ["API_TOKEN=abc123"] } }],
    ["arbitrary launch value", { ...validTarget, launch: { ...validTarget.launch, args: ["--account", "hunter2"] } }],
    ["unapproved value for an approved flag", { ...validTarget, launch: { ...validTarget.launch, args: ["--fixture", "hunter2"] } }],
    ["arbitrary reset value", { ...validTarget, reset: { ...validTarget.reset, args: ["hunter2"] } }],
    ["launch environment", { ...validTarget, launch: { ...validTarget.launch, env: { CLIENT_SECRET: "abc123" } } }],
    ["target environment", { ...validTarget, environment: { PASSWORD: "hunter2" } }],
  ])("rejects secret-bearing %s values", (_name, app) => {
    expect(() =>
      createTargetRevision({
        targetId: "wpf-reference",
        projectId: "project-1",
        displayName: "WPF reference",
        runnerId: "runner-windows",
        expectedVersion: 0,
        configuration: { kind: "desktop", app },
      }),
    ).toThrowError(/TargetSecretRejected/);
  });

  it("accepts the closed launch/reset argument contract and opaque references", () => {
    const revision = createTargetRevision({
      targetId: "wpf-reference",
      projectId: "project-1",
      displayName: "WPF reference",
      runnerId: "runner-windows",
      expectedVersion: 0,
      configuration: { kind: "desktop", app: { ...validTarget, launch: { ...validTarget.launch, args: ["--fixture", "default", "ref:credentials/test-user"] }, reset: { ...validTarget.reset, args: ["--clean"] } } },
    });
    expect(revision.configuration).toMatchObject({ kind: "desktop", app: { launch: { args: ["--fixture", "default", "ref:credentials/test-user"] }, reset: { args: ["--clean"] } } });
  });

  it("rejects secret-bearing or mismatched revisions before hashing", () => {
    expect(() =>
      createTargetRevision({
        targetId: "checkout",
        projectId: "project-1",
        displayName: "Checkout",
        runnerId: "runner-1",
        expectedVersion: 0,
        configuration: {
          kind: "web",
          startUrl: "https://user:password@shop.example.test/checkout",
          allowedOrigins: ["https://shop.example.test"],
          browser: "chromium",
        },
      }),
    ).toThrowError(/TargetSecretRejected/);

    expect(() =>
      createTargetRevision({
        targetId: "desktop-id",
        projectId: "project-1",
        displayName: "Desktop",
        runnerId: "runner-1",
        expectedVersion: 0,
        configuration: { kind: "desktop", app: validTarget },
      }),
    ).toThrowError(/InvalidTargetConfiguration/);
  });
});

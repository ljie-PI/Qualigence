import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AcceptedExecutionJob } from "@qualigence/runner-protocol";
import {
  PlaywrightBrowserSession,
  PlaywrightObserver,
  type WebSessionOptions,
} from "@qualigence/web-playwright/internal";
import {
  SENSITIVE_EVIDENCE_STATE_PROPERTY,
  SENSITIVE_SHADOW_ROOTS_PROPERTY,
} from "../../../packages/target-adapters/web-playwright/src/sensitive-evidence-authority.js";
import { htmlDocument, startFixtureServer, type FixtureServer } from "./fixtures.js";

interface SnapshotSummary {
  readonly count: number;
  readonly validationFailed: boolean;
  readonly ownerThenIsOriginal: boolean;
  readonly ownerThenIsReplacement: boolean;
  readonly ownerPrototypeIsOriginal?: boolean;
}

const job: AcceptedExecutionJob = {
  jobId: "job-promise-owner-snapshot",
  runId: "run-promise-owner-snapshot",
  projectId: "project-test",
  target: { kind: "web", url: "http://placeholder.test" },
  objective: "Observe Promise owner snapshot integrity",
  policy: {
    policyId: "policy-1",
    environment: "isolated_test",
    allowedOrigins: ["http://placeholder.test"],
    allowedActionKinds: ["click"],
    maximumRisk: "Normal",
    explorationAllowed: false,
    issuedAt: "2026-08-26T00:00:00.000Z",
    expiresAt: "2026-08-26T00:01:00.000Z",
  },
};

describe("immutable first Promise owner snapshots", () => {
  let fixture: FixtureServer;
  let session: PlaywrightBrowserSession;

  beforeEach(async () => {
    fixture = await startFixtureServer({
      "/": htmlDocument("<main data-qualigence-observe>Promise owner snapshots</main>", "Promise Snapshot"),
    });
    session = new PlaywrightBrowserSession(options());
    await session.start();
  });

  afterEach(async () => {
    await session?.close();
    await fixture?.close();
  });

  function options(): WebSessionOptions {
    return {
      url: fixture.url,
      expectedOrigin: fixture.origin,
      headed: false,
      navigationTimeoutMs: 15_000,
      actionTimeoutMs: 10_000,
      allowedOrigins: [fixture.origin],
    };
  }

  function observer(): PlaywrightObserver {
    return new PlaywrightObserver(session);
  }

  async function approveCustomOwner(): Promise<SnapshotSummary> {
    return session.withPage((page) => page.evaluate((input) => {
      const epoch = {
        schedulerRegistrations: 0,
        pendingSchedulerCallbacks: 0,
        poisoned: false,
        processSchedulerCallback: () => undefined,
      };
      const state: {
        active: typeof epoch | null;
        records: unknown[];
        poisoned: boolean;
        schedulerSessionRegistrations: number;
        retainedSchedulerEpochs: unknown[];
      } = {
        active: epoch,
        records: [],
        poisoned: false,
        schedulerSessionRegistrations: 0,
        retainedSchedulerEpochs: [],
      };
      (globalThis as unknown as Record<string, unknown>)[input.stateProperty] = state;
      const owner = {
        then(onfulfilled?: (value: string) => unknown) {
          (globalThis as unknown as Record<string, string[]>).__ticket44Calls?.push("original-then");
          if (typeof onfulfilled === "function") onfulfilled("approved");
          return "original-return";
        },
      };
      (globalThis as unknown as Record<string, unknown>).__ticket44Calls = [];
      (globalThis as unknown as Record<string, unknown>).__ticket44Owner = owner;
      (globalThis as unknown as Record<string, unknown>).__ticket44OriginalThen = owner.then;
      (globalThis as unknown as Record<string, unknown>).__ticket44OriginalThenDescriptor = Object.getOwnPropertyDescriptor(owner, "then");
      const returned = Promise.prototype.catch.call(owner as never, () => "handled") as unknown;
      state.active = null;
      if (returned !== "original-return") throw new Error("custom then return changed");
      return summarize(input.runtimeRegistryProperty);

      function summarize(runtimeRegistryProperty: string): SnapshotSummary {
        const registry = (globalThis as unknown as Record<string, {
          readonly promiseOwners?: readonly {
            readonly owner: object;
            readonly prototype: object | null;
            readonly descriptors: Record<"then" | "catch" | "finally", { readonly value?: unknown }>;
          }[];
          readonly promiseOwnerValidationFailed?: boolean;
        }>)[runtimeRegistryProperty];
        const record = registry?.promiseOwners?.find((candidate) => candidate.owner === owner);
        return {
          count: registry?.promiseOwners?.length ?? 0,
          validationFailed: registry?.promiseOwnerValidationFailed === true,
          ownerThenIsOriginal: record?.descriptors.then.value === owner.then,
          ownerThenIsReplacement: record?.descriptors.then.value === (globalThis as unknown as Record<string, unknown>).__ticket44ReplacementThen,
        };
      }
    }, {
      stateProperty: SENSITIVE_EVIDENCE_STATE_PROPERTY,
      runtimeRegistryProperty: SENSITIVE_SHADOW_ROOTS_PROPERTY,
    }));
  }

  async function snapshotSummary(): Promise<SnapshotSummary> {
    return session.withPage((page) => page.evaluate((runtimeRegistryProperty) => {
      const host = globalThis as unknown as Record<string, unknown>;
      const owner = host.__ticket44Owner;
      const registry = (globalThis as unknown as Record<string, {
        readonly promiseOwners?: readonly {
          readonly owner: object;
          readonly prototype: object | null;
          readonly descriptors: Record<"then" | "catch" | "finally", { readonly value?: unknown }>;
        }[];
        readonly promiseOwnerValidationFailed?: boolean;
      }>)[runtimeRegistryProperty];
      const record = registry?.promiseOwners?.find((candidate) => candidate.owner === owner);
      return {
        count: registry?.promiseOwners?.length ?? 0,
        validationFailed: registry?.promiseOwnerValidationFailed === true,
        ownerThenIsOriginal: record?.descriptors.then.value === host.__ticket44OriginalThen,
        ownerThenIsReplacement: record?.descriptors.then.value === host.__ticket44ReplacementThen,
        ...(record === undefined ? {} : { ownerPrototypeIsOriginal: record.prototype === host.__ticket44OriginalPrototype }),
      };
    }, SENSITIVE_SHADOW_ROOTS_PROPERTY));
  }

  it("stores one first-approved owner snapshot and does not replace it after defineProperty restoration", async () => {
    const approved = await approveCustomOwner();
    expect(approved.count).toBeGreaterThan(0);
    expect(approved.validationFailed).toBe(false);
    expect(approved.ownerThenIsOriginal).toBe(true);

    const nativeReturn = await session.withPage((page) => page.evaluate(() => {
      const host = globalThis as unknown as {
        __ticket44Owner?: { then: (onfulfilled?: (value: string) => unknown) => string };
        __ticket44OriginalThen?: (onfulfilled?: (value: string) => unknown) => string;
        __ticket44ReplacementThen?: (onfulfilled?: (value: string) => unknown) => string;
        __ticket44Calls?: string[];
      };
      const owner = host.__ticket44Owner;
      const original = host.__ticket44OriginalThen;
      if (owner === undefined || original === undefined) throw new Error("missing owner");
      host.__ticket44ReplacementThen = function replacementThen(onfulfilled?: (value: string) => unknown): string {
        host.__ticket44Calls?.push("replacement-then");
        if (typeof onfulfilled === "function") onfulfilled("replacement");
        return "replacement-return";
      };
      Object.defineProperty(owner, "then", {
        configurable: true,
        enumerable: true,
        writable: true,
        value: host.__ticket44ReplacementThen,
      });
      Object.defineProperty(owner, "then", {
        configurable: true,
        enumerable: true,
        writable: true,
        value: original,
      });
      return Promise.prototype.catch.call(owner as never, () => "handled");
    }));
    expect(nativeReturn).toBe("original-return");

    const restored = await snapshotSummary();
    expect(restored).toMatchObject({
      validationFailed: true,
      ownerThenIsOriginal: true,
      ownerThenIsReplacement: false,
    });
    await expect(observer().capture(job)).rejects.toMatchObject({ code: "SensitiveEvidenceUnavailable" });
  });

  it("preserves native behavior for direct assignment plus exact restoration entirely between observation points", async () => {
    await approveCustomOwner();

    const nativeReturn = await session.withPage((page) => page.evaluate(() => {
      const host = globalThis as unknown as {
        __ticket44Owner?: { then: (onfulfilled?: (value: string) => unknown) => string };
        __ticket44OriginalThen?: (onfulfilled?: (value: string) => unknown) => string;
        __ticket44ReplacementThen?: (onfulfilled?: (value: string) => unknown) => string;
      };
      const owner = host.__ticket44Owner;
      const original = host.__ticket44OriginalThen;
      if (owner === undefined || original === undefined) throw new Error("missing owner");
      host.__ticket44ReplacementThen = function unobservedAssignedThen(onfulfilled?: (value: string) => unknown): string {
        if (typeof onfulfilled === "function") onfulfilled("unobserved");
        return "unobserved-return";
      };
      owner.then = host.__ticket44ReplacementThen;
      owner.then = original;
      return Promise.prototype.catch.call(owner as never, () => "handled");
    }));
    expect(nativeReturn).toBe("original-return");

    const restored = await snapshotSummary();
    expect(restored).toMatchObject({
      validationFailed: false,
      ownerThenIsOriginal: true,
      ownerThenIsReplacement: false,
    });
    const graph = await observer().capture(job);
    expect(graph.graphId).toBe("run-promise-owner-snapshot:observation:1");
    expect(session.artifactsFor(graph.graphId)).toHaveLength(2);
  });

  it("latches direct assignment detected by re-registration and never blesses the restored method", async () => {
    await approveCustomOwner();

    const returns = await session.withPage((page) => page.evaluate((stateProperty) => {
      const host = globalThis as unknown as {
        __ticket44Owner?: { then: (onfulfilled?: (value: string) => unknown) => string };
        __ticket44OriginalThen?: (onfulfilled?: (value: string) => unknown) => string;
        __ticket44ReplacementThen?: (onfulfilled?: (value: string) => unknown) => string;
      };
      const owner = host.__ticket44Owner;
      const original = host.__ticket44OriginalThen;
      if (owner === undefined || original === undefined) throw new Error("missing owner");
      const epoch = {
        schedulerRegistrations: 0,
        pendingSchedulerCallbacks: 0,
        poisoned: false,
        processSchedulerCallback: () => undefined,
      };
      const state: {
        active: typeof epoch | null;
        records: unknown[];
        poisoned: boolean;
        schedulerSessionRegistrations: number;
        retainedSchedulerEpochs: unknown[];
      } = {
        active: epoch,
        records: [],
        poisoned: false,
        schedulerSessionRegistrations: 0,
        retainedSchedulerEpochs: [],
      };
      (globalThis as unknown as Record<string, unknown>)[stateProperty] = state;
      host.__ticket44ReplacementThen = function assignedThen(onfulfilled?: (value: string) => unknown): string {
        if (typeof onfulfilled === "function") onfulfilled("assigned");
        return "assigned-return";
      };
      owner.then = host.__ticket44ReplacementThen;
      const assignedReturn = Promise.prototype.catch.call(owner as never, () => "handled");
      owner.then = original;
      const restoredReturn = Promise.prototype.catch.call(owner as never, () => "handled");
      state.active = null;
      return { assignedReturn, restoredReturn };
    }, SENSITIVE_EVIDENCE_STATE_PROPERTY));

    expect(returns).toEqual({ assignedReturn: "assigned-return", restoredReturn: "original-return" });
    const restored = await snapshotSummary();
    expect(restored).toMatchObject({ validationFailed: true, ownerThenIsOriginal: true });
    await expect(observer().capture(job)).rejects.toMatchObject({ code: "SensitiveEvidenceUnavailable" });
  });

  it("latches Reflect delete and restore after first approval while preserving native behavior", async () => {
    await approveCustomOwner();

    const nativeReturn = await session.withPage((page) => page.evaluate(() => {
      const host = globalThis as unknown as {
        __ticket44Owner?: { then?: (onfulfilled?: (value: string) => unknown) => string };
        __ticket44OriginalThenDescriptor?: PropertyDescriptor;
      };
      const owner = host.__ticket44Owner;
      const descriptor = host.__ticket44OriginalThenDescriptor;
      if (owner === undefined || descriptor === undefined) throw new Error("missing owner");
      const deleted = Reflect.deleteProperty(owner, "then");
      const restored = Reflect.defineProperty(owner, "then", descriptor);
      if (!deleted || !restored) throw new Error("Reflect delete/restore failed");
      return Promise.prototype.catch.call(owner as never, () => "handled");
    }));

    expect(nativeReturn).toBe("original-return");
    const restored = await snapshotSummary();
    expect(restored).toMatchObject({ validationFailed: true, ownerThenIsOriginal: true });
    await expect(observer().capture(job)).rejects.toMatchObject({ code: "SensitiveEvidenceUnavailable" });
  });

  it("latches prototype round trips after first approval while preserving native Promise behavior", async () => {
    const approved = await session.withPage((page) => page.evaluate(async (input) => {
      const epoch = {
        schedulerRegistrations: 0,
        pendingSchedulerCallbacks: 0,
        poisoned: false,
        processSchedulerCallback: () => undefined,
      };
      const state: {
        active: typeof epoch | null;
        records: unknown[];
        poisoned: boolean;
        schedulerSessionRegistrations: number;
        retainedSchedulerEpochs: unknown[];
      } = {
        active: epoch,
        records: [],
        poisoned: false,
        schedulerSessionRegistrations: 0,
        retainedSchedulerEpochs: [],
      };
      (globalThis as unknown as Record<string, unknown>)[input.stateProperty] = state;
      const receiver = Promise.resolve("prototype-ok");
      (globalThis as unknown as Record<string, unknown>).__ticket44Owner = receiver;
      (globalThis as unknown as Record<string, unknown>).__ticket44OriginalPrototype = Object.getPrototypeOf(receiver);
      const value = await receiver.then((resolved) => resolved);
      state.active = null;
      return value;
    }, { stateProperty: SENSITIVE_EVIDENCE_STATE_PROPERTY }));
    expect(approved).toBe("prototype-ok");

    const restoredValue = await session.withPage((page) => page.evaluate(async () => {
      const host = globalThis as unknown as Record<string, unknown>;
      const receiver = host.__ticket44Owner as Promise<string>;
      const originalPrototype = host.__ticket44OriginalPrototype as object;
      const replacementPrototype = Object.create(originalPrototype) as { then?: Promise<string>["then"] };
      replacementPrototype.then = Promise.prototype.then;
      Object.setPrototypeOf(receiver, replacementPrototype);
      Object.setPrototypeOf(receiver, originalPrototype);
      return receiver.then((resolved) => resolved);
    }));
    expect(restoredValue).toBe("prototype-ok");

    const restored = await snapshotSummary();
    expect(restored).toMatchObject({ validationFailed: true, ownerPrototypeIsOriginal: true });
    await expect(observer().capture(job)).rejects.toMatchObject({ code: "SensitiveEvidenceUnavailable" });
  });

  it("validates with captured descriptor/prototype intrinsics after ambient Object and Reflect helpers are replaced", async () => {
    await approveCustomOwner();
    await session.withPage((page) => page.evaluate(() => {
      Object.getOwnPropertyDescriptor = (() => { throw new Error("ambient descriptor helper is untrusted"); }) as typeof Object.getOwnPropertyDescriptor;
      Object.getPrototypeOf = (() => null) as typeof Object.getPrototypeOf;
      Object.prototype.hasOwnProperty = (() => false) as typeof Object.prototype.hasOwnProperty;
      Reflect.apply = (() => { throw new Error("ambient apply helper is untrusted"); }) as typeof Reflect.apply;
    }));

    const graph = await observer().capture(job);
    expect(graph.graphId).toBe("run-promise-owner-snapshot:observation:1");
    expect(session.artifactsFor(graph.graphId)).toHaveLength(2);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AcceptedExecutionJob, ObservationGraphV1 } from "@qualigence/runner-protocol";
import {
  PlaywrightBrowserSession,
  PlaywrightObserver,
  type WebSessionOptions,
} from "@qualigence/web-playwright/internal";
import {
  MAX_SENSITIVE_PROMISE_OWNER_REGISTRY_OWNERS,
  SENSITIVE_EVIDENCE_STATE_PROPERTY,
  SENSITIVE_SHADOW_ROOTS_PROPERTY,
} from "../../../packages/target-adapters/web-playwright/src/sensitive-evidence-authority.js";
import { htmlDocument, startFixtureServer, type FixtureServer } from "./fixtures.js";

interface OwnerRegistrySummary {
  readonly count: number;
  readonly overflow: boolean;
  readonly validationFailed: boolean;
  readonly hasPromisePrototype: boolean;
  readonly hasTrackedReceiver: boolean;
  readonly hasTrackedPrototype: boolean;
  readonly promisePrototypeThen: {
    readonly present: boolean;
    readonly kind?: string;
    readonly writable?: boolean;
    readonly configurable?: boolean;
  };
  readonly receiverThenPresent: boolean;
  readonly receiverThenOwner: string;
}

const job: AcceptedExecutionJob = {
  jobId: "job-promise-owner",
  runId: "run-promise-owner",
  projectId: "project-test",
  target: { kind: "web", url: "http://placeholder.test" },
  objective: "Observe Promise owner integrity",
  policy: {
    policyId: "policy-1",
    environment: "isolated_test",
    allowedOrigins: ["http://placeholder.test"],
    allowedActionKinds: ["click"],
    maximumRisk: "Normal",
    explorationAllowed: false,
    issuedAt: "2026-08-18T00:00:00.000Z",
    expiresAt: "2026-08-18T00:01:00.000Z",
  },
};

describe("Promise owner descriptor integrity", () => {
  let fixture: FixtureServer;
  let session: PlaywrightBrowserSession;

  beforeEach(async () => {
    fixture = await startFixtureServer({
      "/": htmlDocument("<main data-qualigence-observe>Promise owner integrity</main>", "Promise Owners"),
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

  function observer(hooks: ConstructorParameters<typeof PlaywrightObserver>[1] = {}): PlaywrightObserver {
    return new PlaywrightObserver(session, hooks);
  }

  async function observePromiseOwners(): Promise<OwnerRegistrySummary> {
    return session.withPage(async (page) => page.evaluate(async (input) => {
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

      const trackedReceiver = Promise.resolve("tracked") as Promise<string>;
      const trackedPrototype = Object.create(Promise.prototype) as Promise<string>;
      const customReceiver = Promise.resolve("custom") as Promise<string>;
      Object.setPrototypeOf(customReceiver, trackedPrototype);
      Object.defineProperty(trackedPrototype, "then", {
        configurable: true,
        enumerable: false,
        writable: true,
        value: Promise.prototype.then,
      });
      (globalThis as unknown as Record<string, unknown>).__ticket43TrackedReceiver = trackedReceiver;
      (globalThis as unknown as Record<string, unknown>).__ticket43TrackedPrototype = trackedPrototype;

      const callbackRuns: string[] = [];
      const fulfilled = trackedReceiver.then((value) => {
        callbackRuns.push(`then:${value}`);
        return value;
      });
      const caught = Promise.reject("boom").catch((reason) => {
        callbackRuns.push(`catch:${reason}`);
        return "handled";
      });
      const finalized = Promise.resolve("finally").finally(() => {
        callbackRuns.push("finally");
      });
      const custom = Promise.prototype.then.call(customReceiver, (value) => {
        callbackRuns.push(`custom:${value}`);
        return value;
      });

      state.active = null;
      await Promise.all([fulfilled, caught, finalized, custom]);
      await new Promise((resolve) => setTimeout(resolve, 0));
      (globalThis as unknown as Record<string, unknown>).__ticket43CallbackRuns = callbackRuns;
      return summarizeOwnerRegistry(input.runtimeRegistryProperty);

      function summarizeOwnerRegistry(runtimeRegistryProperty: string): OwnerRegistrySummary {
        const registry = (globalThis as unknown as Record<string, {
          readonly promiseOwners?: readonly {
            readonly owner: object;
            readonly descriptors: Record<"then" | "catch" | "finally", { readonly present: boolean; readonly kind?: string; readonly writable?: boolean; readonly configurable?: boolean }>;
            readonly resolvedMethodOwners: Record<"then" | "catch" | "finally", { readonly present: boolean; readonly owner?: object }>;
          }[];
          readonly promiseOwnerOverflow?: boolean;
          readonly promiseOwnerValidationFailed?: boolean;
        }>)[runtimeRegistryProperty];
        const owners = registry?.promiseOwners ?? [];
        const promisePrototype = owners.find((record) => record.owner === Promise.prototype);
        const receiverRecord = owners.find((record) => record.owner === trackedReceiver);
        const promisePrototypeThen = promisePrototype?.descriptors.then;
        return {
          count: owners.length,
          overflow: registry?.promiseOwnerOverflow === true,
          validationFailed: registry?.promiseOwnerValidationFailed === true,
          hasPromisePrototype: promisePrototype !== undefined,
          hasTrackedReceiver: receiverRecord !== undefined,
          hasTrackedPrototype: owners.some((record) => record.owner === trackedPrototype),
          promisePrototypeThen: {
            present: promisePrototypeThen?.present === true,
            ...(promisePrototypeThen?.kind === undefined ? {} : { kind: promisePrototypeThen.kind }),
            ...(promisePrototypeThen?.writable === undefined ? {} : { writable: promisePrototypeThen.writable }),
            ...(promisePrototypeThen?.configurable === undefined ? {} : { configurable: promisePrototypeThen.configurable }),
          },
          receiverThenPresent: receiverRecord?.descriptors.then.present === true,
          receiverThenOwner: receiverRecord?.resolvedMethodOwners.then.owner === Promise.prototype
            ? "Promise.prototype"
            : receiverRecord?.resolvedMethodOwners.then.owner === trackedPrototype
              ? "trackedPrototype"
              : "other",
        };
      }
    }, {
      stateProperty: SENSITIVE_EVIDENCE_STATE_PROPERTY,
      runtimeRegistryProperty: SENSITIVE_SHADOW_ROOTS_PROPERTY,
    }));
  }

  async function runTrackedPromiseCallbacks(count: number): Promise<number> {
    return session.withPage(async (page) => page.evaluate(async (input) => {
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
      let callbackRuns = 0;
      const promises = Array.from({ length: input.count }, (_unused, index) => Promise.resolve(index).then((value) => {
        callbackRuns += 1;
        return value;
      }));
      state.active = null;
      await Promise.all(promises);
      (globalThis as unknown as Record<string, unknown>).__ticket43CallbackRuns = callbackRuns;
      return callbackRuns;
    }, {
      stateProperty: SENSITIVE_EVIDENCE_STATE_PROPERTY,
      count,
    }));
  }

  async function callbackRuns(): Promise<number> {
    return session.withPage(async (page) => page.evaluate(() =>
      (globalThis as unknown as Record<string, number | undefined>).__ticket43CallbackRuns ?? 0,
    ));
  }

  async function observeCustomThenOwner(): Promise<boolean> {
    return session.withPage(async (page) => page.evaluate((input) => {
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
        then() {
          return "custom-return";
        },
      };
      (globalThis as unknown as Record<string, unknown>).__ticket43CustomThenOwner = owner;
      const returned = Promise.prototype.catch.call(owner as never, () => "handled") as unknown;
      state.active = null;
      if (returned !== "custom-return") throw new Error("custom owner return changed");
      const registry = (globalThis as unknown as Record<string, {
        readonly promiseOwners?: readonly { readonly owner: object }[];
      } | undefined>)[input.runtimeRegistryProperty];
      return registry?.promiseOwners?.some((record) => record.owner === owner) === true;
    }, {
      stateProperty: SENSITIVE_EVIDENCE_STATE_PROPERTY,
      runtimeRegistryProperty: SENSITIVE_SHADOW_ROOTS_PROPERTY,
    }));
  }

  async function restorePromiseThen(): Promise<void> {
    await session.withPage(async (page) => page.evaluate(() => {
      const host = globalThis as unknown as Record<string, PropertyDescriptor | object | undefined>;
      const descriptor = host.__ticket43OriginalPromiseThenDescriptor;
      if (descriptor !== undefined) {
        Object.defineProperty(Promise.prototype, "then", descriptor as PropertyDescriptor);
        delete host.__ticket43OriginalPromiseThenDescriptor;
      }
      const trackedPrototypeDescriptor = host.__ticket43OriginalTrackedPrototypeThenDescriptor;
      const trackedPrototype = host.__ticket43TrackedPrototype;
      if (trackedPrototypeDescriptor !== undefined && trackedPrototype !== undefined) {
        Object.defineProperty(trackedPrototype, "then", trackedPrototypeDescriptor as PropertyDescriptor);
        delete host.__ticket43OriginalTrackedPrototypeThenDescriptor;
      }
      const receiver = (globalThis as unknown as Record<string, Promise<unknown> | undefined>).__ticket43TrackedReceiver;
      if (receiver !== undefined) Object.setPrototypeOf(receiver, Promise.prototype);
    }));
  }

  it("retains an enumerable bounded registry of observed receivers and traversed method owners", async () => {
    const summary = await observePromiseOwners();

    expect(summary.count).toBeGreaterThanOrEqual(3);
    expect(summary.count).toBeLessThanOrEqual(MAX_SENSITIVE_PROMISE_OWNER_REGISTRY_OWNERS);
    expect(summary.overflow).toBe(false);
    expect(summary.validationFailed).toBe(false);
    expect(summary.hasPromisePrototype).toBe(true);
    expect(summary.hasTrackedReceiver).toBe(true);
    expect(summary.hasTrackedPrototype).toBe(true);
    expect(summary.promisePrototypeThen).toMatchObject({
      present: true,
      kind: "data",
      writable: true,
      configurable: true,
    });
    expect(summary.receiverThenPresent).toBe(false);
    expect(summary.receiverThenOwner).toBe("Promise.prototype");
  });

  it("rejects descriptor mutation after DOM collection without suppressing native callbacks or accepting artifacts", async () => {
    await runTrackedPromiseCallbacks(1);
    const capture = observer({
      afterDomCollection: async (page) => {
        await page.evaluate(() => {
          const host = globalThis as unknown as Record<string, PropertyDescriptor | undefined>;
          host.__ticket43OriginalPromiseThenDescriptor = Object.getOwnPropertyDescriptor(Promise.prototype, "then");
          const original = Promise.prototype.then;
          Object.defineProperty(Promise.prototype, "then", {
            configurable: true,
            enumerable: false,
            writable: true,
            value: function ticket43MutatedThen(this: Promise<unknown>, ...args: Parameters<Promise<unknown>["then"]>) {
              return original.apply(this, args);
            },
          });
        });
      },
    });

    try {
      await expect(capture.capture(job)).rejects.toMatchObject({ code: "SensitiveEvidenceUnavailable" });
      expect(await callbackRuns()).toBe(1);
      expect(() => session.artifactsFor("run-promise-owner:observation:1"))
        .toThrowError(expect.objectContaining({ code: "StaleObservation" }));
    } finally {
      await restorePromiseThen();
    }
  });

  it("rejects owner prototype mutation after screenshot before artifact acceptance", async () => {
    await observePromiseOwners();
    const capture = observer({
      afterScreenshotCapture: async (page) => {
        await page.evaluate(() => {
          const receiver = (globalThis as unknown as Record<string, Promise<unknown>>).__ticket43TrackedReceiver;
          Object.setPrototypeOf(receiver, { then: Promise.prototype.then });
        });
      },
    });

    try {
      await expect(capture.capture(job)).rejects.toMatchObject({ code: "SensitiveEvidenceUnavailable" });
      expect(() => session.artifactsFor("run-promise-owner:observation:1"))
        .toThrowError(expect.objectContaining({ code: "StaleObservation" }));
    } finally {
      await restorePromiseThen();
    }
  });

  it("accepts an exact restored current descriptor before immediate validation", async () => {
    await runTrackedPromiseCallbacks(1);
    const graph = await observer({
      afterDomCollection: async (page) => {
        await page.evaluate(() => {
          const descriptor = Object.getOwnPropertyDescriptor(Promise.prototype, "then");
          if (descriptor === undefined) throw new Error("missing then descriptor");
          delete (Promise.prototype as Partial<Promise<unknown>>).then;
          Object.defineProperty(Promise.prototype, "then", descriptor);
        });
      },
    }).capture(job) as ObservationGraphV1;

    expect(graph.graphId).toBe("run-promise-owner:observation:1");
    expect(session.artifactsFor(graph.graphId)).toHaveLength(2);
  });

  it("poisons evidence on the 257th distinct observed receiver while Promise callbacks still run", async () => {
    await expect(runTrackedPromiseCallbacks(MAX_SENSITIVE_PROMISE_OWNER_REGISTRY_OWNERS + 1))
      .resolves.toBe(MAX_SENSITIVE_PROMISE_OWNER_REGISTRY_OWNERS + 1);

    await expect(observer().capture(job)).rejects.toMatchObject({ code: "SensitiveEvidenceUnavailable" });
    expect(await callbackRuns()).toBe(MAX_SENSITIVE_PROMISE_OWNER_REGISTRY_OWNERS + 1);
    expect(() => session.artifactsFor("run-promise-owner:observation:1"))
      .toThrowError(expect.objectContaining({ code: "StaleObservation" }));
  });

  it("fails closed when owner inspection throws before return while preserving the custom method return", async () => {
    const customReturn = await session.withPage(async (page) => page.evaluate((input) => {
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
      const receiver = new Proxy({
        get then() {
          return function customThen() {
            return "custom-return";
          };
        },
      }, {
        get(target, property, targetReceiver) {
          return Reflect.get(target, property, targetReceiver);
        },
        getOwnPropertyDescriptor() {
          throw new Error("descriptor inspection denied");
        },
      });
      const returned = Promise.prototype.catch.call(receiver as never, () => "handled");
      state.active = null;
      return returned;
    }, { stateProperty: SENSITIVE_EVIDENCE_STATE_PROPERTY }));

    expect(customReturn).toBe("custom-return");
    await expect(observer().capture(job)).rejects.toMatchObject({ code: "SensitiveEvidenceUnavailable" });
    expect(() => session.artifactsFor("run-promise-owner:observation:1"))
      .toThrowError(expect.objectContaining({ code: "StaleObservation" }));
  });

  it("does not trust page-visible owner entry removal, truncation, or compaction to hide descriptor mutation", async () => {
    await expect(observeCustomThenOwner()).resolves.toBe(true);
    const capture = observer({
      afterGraphAssembly: async (page) => {
        await page.evaluate((runtimeRegistryProperty) => {
          const registry = (globalThis as unknown as Record<string, { readonly promiseOwners?: unknown[] } | undefined>)[runtimeRegistryProperty];
          const owners = registry?.promiseOwners;
          if (owners !== undefined) {
            try { owners.length = 0; } catch {}
            try { owners.splice(0, owners.length); } catch {}
            try { delete owners[0]; } catch {}
          }
          const owner = (globalThis as unknown as Record<string, { then: () => string } | undefined>).__ticket43CustomThenOwner;
          if (owner === undefined) throw new Error("missing custom then owner");
          Object.defineProperty(owner, "then", {
            configurable: true,
            enumerable: true,
            writable: true,
            value: function ticket43TruncatedRegistryThen() {
              return "custom-return";
            },
          });
        }, SENSITIVE_SHADOW_ROOTS_PROPERTY);
      },
    });

    try {
      await expect(capture.capture(job)).rejects.toMatchObject({ code: "SensitiveEvidenceUnavailable" });
      expect(() => session.artifactsFor("run-promise-owner:observation:1"))
        .toThrowError(expect.objectContaining({ code: "StaleObservation" }));
    } finally {
      await restorePromiseThen();
    }
  });

  it("does not trust page-visible descriptor record rewrites after owner mutation", async () => {
    await expect(observeCustomThenOwner()).resolves.toBe(true);
    const capture = observer({
      afterGraphAssembly: async (page) => {
        await page.evaluate((runtimeRegistryProperty) => {
          const owner = (globalThis as unknown as Record<string, { then: () => string } | undefined>).__ticket43CustomThenOwner;
          if (owner === undefined) throw new Error("missing custom then owner");
          Object.defineProperty(owner, "then", {
            configurable: true,
            enumerable: true,
            writable: true,
            value: function ticket43RewrittenDescriptorThen() {
              return "custom-return";
            },
          });
          const registry = (globalThis as unknown as Record<string, {
            readonly promiseOwners?: readonly { readonly owner: object; readonly descriptors: Record<string, Record<string, unknown>> }[];
          } | undefined>)[runtimeRegistryProperty];
          const record = registry?.promiseOwners?.find((candidate) => candidate.owner === owner);
          try {
            if (record?.descriptors.then !== undefined) record.descriptors.then.value = owner.then;
          } catch {}
        }, SENSITIVE_SHADOW_ROOTS_PROPERTY);
      },
    });

    try {
      await expect(capture.capture(job)).rejects.toMatchObject({ code: "SensitiveEvidenceUnavailable" });
      expect(() => session.artifactsFor("run-promise-owner:observation:1"))
        .toThrowError(expect.objectContaining({ code: "StaleObservation" }));
    } finally {
      await restorePromiseThen();
    }
  });

  it("does not trust page-visible prototype and method-owner record rewrites after owner mutation", async () => {
    await observePromiseOwners();
    const capture = observer({
      afterGraphAssembly: async (page) => {
        await page.evaluate((runtimeRegistryProperty) => {
          const receiver = (globalThis as unknown as Record<string, Promise<unknown>>).__ticket43TrackedReceiver;
          const replacementPrototype = { then: Promise.prototype.then };
          Object.setPrototypeOf(receiver, replacementPrototype);
          const registry = (globalThis as unknown as Record<string, {
            readonly promiseOwners?: readonly {
              readonly owner: object;
              prototype?: object | null;
              readonly resolvedMethodOwners: Record<string, { present: boolean; owner?: object }>;
            }[];
          } | undefined>)[runtimeRegistryProperty];
          const record = registry?.promiseOwners?.find((candidate) => candidate.owner === receiver);
          try {
            if (record !== undefined) record.prototype = replacementPrototype;
          } catch {}
          try {
            if (record !== undefined) record.resolvedMethodOwners.then = { present: true, owner: replacementPrototype };
          } catch {}
        }, SENSITIVE_SHADOW_ROOTS_PROPERTY);
      },
    });

    try {
      await expect(capture.capture(job)).rejects.toMatchObject({ code: "SensitiveEvidenceUnavailable" });
      expect(() => session.artifactsFor("run-promise-owner:observation:1"))
        .toThrowError(expect.objectContaining({ code: "StaleObservation" }));
    } finally {
      await restorePromiseThen();
    }
  });

  it("starts a new browser session with an empty owner registry after close", async () => {
    const summary = await observePromiseOwners();
    expect(summary.count).toBeGreaterThan(0);
    await session.close();

    session = new PlaywrightBrowserSession(options());
    await session.start();
    const freshCount = await session.withPage(async (page) => page.evaluate((runtimeRegistryProperty) => {
      const registry = (globalThis as unknown as Record<string, { readonly promiseOwners?: readonly unknown[] } | undefined>)[runtimeRegistryProperty];
      return registry?.promiseOwners?.length ?? 0;
    }, SENSITIVE_SHADOW_ROOTS_PROPERTY));
    expect(freshCount).toBe(0);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PlaywrightBrowserSession,
  chromiumLauncher,
  type WebSessionOptions,
} from "@qualigence/web-playwright/internal";
import { SENSITIVE_EVIDENCE_STATE_PROPERTY } from "../../../packages/target-adapters/web-playwright/src/sensitive-evidence-authority.js";
import { htmlDocument, startFixtureServer, type FixtureServer } from "./fixtures.js";

interface OracleResult {
  readonly cases: Record<string, unknown>;
}

interface AccountingResult {
  readonly twoHandlerThen: RegistrationSnapshot;
  readonly omittedThen: RegistrationSnapshot;
  readonly catchCall: RegistrationSnapshot;
  readonly finallyReturningPromise: RegistrationSnapshot;
  readonly nestedApplicationThen: RegistrationSnapshot;
  readonly epochBoundary: RegistrationSnapshot;
  readonly epochOverflow: RegistrationSnapshot;
  readonly sessionOverflow: RegistrationSnapshot;
}

interface RegistrationSnapshot {
  readonly epochRegistrations: number;
  readonly sessionRegistrations: number;
  readonly poisoned: boolean;
  readonly callbackRuns: number | string[];
  readonly settlement?: unknown;
}

describe("native Promise oracle for sensitive instrumentation", () => {
  let fixture: FixtureServer;
  let session: PlaywrightBrowserSession;
  let nativeBrowser: Awaited<ReturnType<typeof chromiumLauncher.launch>>;
  let nativePage: Awaited<ReturnType<Awaited<ReturnType<typeof chromiumLauncher.launch>>["newContext"]>> extends infer Context
    ? Context extends { newPage(): Promise<infer Page> } ? Page : never
    : never;

  beforeEach(async () => {
    fixture = await startFixtureServer({
      "/": htmlDocument("<main>Promise oracle</main>", "Promise Oracle"),
    });
    nativeBrowser = await chromiumLauncher.launch({ headless: true });
    nativePage = await (await nativeBrowser.newContext()).newPage();
    await nativePage.goto(fixture.url, { waitUntil: "domcontentloaded" });

    session = new PlaywrightBrowserSession(options());
    await session.start();
  });

  afterEach(async () => {
    await session?.close();
    await nativeBrowser?.close();
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

  async function instrumentedOracle(): Promise<OracleResult> {
    return session.withPage((page) => page.evaluate(runPromiseOracle, {
      stateProperty: SENSITIVE_EVIDENCE_STATE_PROPERTY,
      enableSensitiveEpoch: true,
    }));
  }

  async function nativeOracle(): Promise<OracleResult> {
    return nativePage.evaluate(runPromiseOracle, {
      stateProperty: SENSITIVE_EVIDENCE_STATE_PROPERTY,
      enableSensitiveEpoch: false,
    });
  }

  it("matches native then/catch/finally, species, thenable, custom receiver, and cycle behavior", async () => {
    const [native, instrumented] = await Promise.all([
      nativeOracle(),
      instrumentedOracle(),
    ]);

    expect(instrumented).toEqual(native);
  }, 60_000);

  it("accounts each application-visible Promise registration exactly once without suppressing native execution", async () => {
    const accounting = await session.withPage((page) => page.evaluate(runPromiseAccounting, {
      stateProperty: SENSITIVE_EVIDENCE_STATE_PROPERTY,
    }));

    expect(accounting.twoHandlerThen).toMatchObject({
      epochRegistrations: 1,
      sessionRegistrations: 1,
      poisoned: false,
      callbackRuns: ["fulfilled"],
      settlement: { status: "fulfilled", value: "ok" },
    });
    expect(accounting.omittedThen).toMatchObject({
      epochRegistrations: 1,
      sessionRegistrations: 1,
      poisoned: false,
      settlement: { status: "fulfilled", value: "pass-through" },
    });
    expect(accounting.catchCall).toMatchObject({
      epochRegistrations: 1,
      sessionRegistrations: 1,
      poisoned: false,
      callbackRuns: ["caught"],
      settlement: { status: "fulfilled", value: "handled" },
    });
    expect(accounting.finallyReturningPromise).toMatchObject({
      epochRegistrations: 1,
      sessionRegistrations: 1,
      poisoned: false,
      callbackRuns: ["finally"],
      settlement: { status: "fulfilled", value: "original" },
    });
    expect(accounting.nestedApplicationThen).toMatchObject({
      epochRegistrations: 2,
      sessionRegistrations: 2,
      poisoned: false,
      callbackRuns: ["outer", "nested"],
      settlement: { status: "fulfilled", value: "outer-result" },
    });
    expect(accounting.epochBoundary).toMatchObject({
      epochRegistrations: 1024,
      sessionRegistrations: 1024,
      poisoned: false,
      callbackRuns: 1024,
    });
    expect(accounting.epochOverflow).toMatchObject({
      epochRegistrations: 1025,
      sessionRegistrations: 1025,
      poisoned: true,
      callbackRuns: 1025,
    });
    expect(accounting.sessionOverflow).toMatchObject({
      epochRegistrations: 1,
      sessionRegistrations: 4097,
      poisoned: true,
      callbackRuns: ["session-overflow-callback"],
      settlement: { status: "fulfilled", value: "session-overflow" },
    });
  }, 60_000);
});

async function runPromiseOracle(input: {
  readonly stateProperty: string;
  readonly enableSensitiveEpoch: boolean;
}): Promise<OracleResult> {
  function startSensitiveEpoch(stateProperty: string): void {
    const epoch = {
      schedulerRegistrations: 0,
      pendingSchedulerCallbacks: 0,
      poisoned: false,
      processSchedulerCallback: () => undefined,
    };
    (globalThis as unknown as Record<string, unknown>)[stateProperty] = {
      active: epoch,
      poisoned: false,
      schedulerSessionRegistrations: 0,
      retainedSchedulerEpochs: [],
    };
  }

  function clearSensitiveEpoch(stateProperty: string): void {
    delete (globalThis as unknown as Record<string, unknown>)[stateProperty];
  }

  async function settlement(promise: Promise<unknown>): Promise<{ readonly status: "fulfilled"; readonly value: unknown } | { readonly status: "rejected"; readonly reason: unknown }> {
    try {
      return { status: "fulfilled", value: await promise };
    } catch (reason) {
      return { status: "rejected", reason };
    }
  }

  function tagSettlement(
    result: { readonly status: "fulfilled"; readonly value: unknown } | { readonly status: "rejected"; readonly reason: unknown },
    identities: Record<string, unknown> = {},
  ): unknown {
    if (result.status === "fulfilled") {
      return { status: "fulfilled", value: tagValue(result.value, identities) };
    }
    return { status: "rejected", reason: tagValue(result.reason, identities) };
  }

  function tagValue(value: unknown, identities: Record<string, unknown>): unknown {
    for (const [name, identity] of Object.entries(identities)) {
      if (value === identity) return { identity: name };
    }
    if (value instanceof Error) {
      return { errorName: value.name };
    }
    if (typeof value === "object" && value !== null) {
      return { objectTag: Object.prototype.toString.call(value) };
    }
    return value;
  }

  function constructorTags<T>(
    value: Promise<T>,
    Sub: abstract new (...args: never[]) => Promise<T>,
    Alternate: abstract new (...args: never[]) => Promise<T>,
  ): unknown {
    return {
      promise: value instanceof Promise,
      sub: value instanceof Sub,
      alternate: value instanceof Alternate,
      protoIsSub: Object.getPrototypeOf(value) === Sub.prototype,
      protoIsAlternate: Object.getPrototypeOf(value) === Alternate.prototype,
      protoIsPromise: Object.getPrototypeOf(value) === Promise.prototype,
    };
  }

  function synchronousOutcome(
    operation: () => unknown,
    identities: Record<string, unknown> = {},
  ): unknown {
    try {
      const value = operation();
      return { status: "returned", value: tagValue(value, identities) };
    } catch (reason) {
      return { status: "threw", reason: tagValue(reason, identities) };
    }
  }

  const cases: Record<string, unknown> = {};

  async function runCase(name: string, body: () => Promise<unknown> | unknown): Promise<void> {
    if (input.enableSensitiveEpoch) startSensitiveEpoch(input.stateProperty);
    try {
      cases[name] = await body();
    } finally {
      if (input.enableSensitiveEpoch) clearSensitiveEpoch(input.stateProperty);
    }
  }

  await runCase("base-then-catch-finally", async () => {
    const log: string[] = [];
    const sentinel = { name: "sentinel" };
    const rejection = { name: "rejection" };
    const thenResult = await Promise.resolve(sentinel).then(function (this: unknown, value) {
      log.push(`then:${value === sentinel}:${this === undefined}`);
      return value;
    });
    const catchResult = await Promise.reject(rejection).catch(function (this: unknown, reason) {
      log.push(`catch:${reason === rejection}:${this === undefined}`);
      return sentinel;
    });
    const finallyResult = await Promise.resolve(sentinel).finally(function (this: unknown) {
      log.push(`finally:${this === undefined}`);
      return "ignored";
    });
    const passThrough = await Promise.resolve("pass").then(undefined, 7 as never);
    const throwThrough = await settlement(Promise.reject(rejection).then(null, undefined));
    return {
      log,
      thenSameValue: thenResult === sentinel,
      catchSameValue: catchResult === sentinel,
      finallySameValue: finallyResult === sentinel,
      passThrough,
      throwThrough: tagSettlement(throwThrough, { rejection }),
    };
  });

  await runCase("species", async () => {
    const log: string[] = [];
    class DefaultSub<T> extends Promise<T> {}
    class BaseSpeciesSub<T> extends Promise<T> {}
    Object.defineProperty(BaseSpeciesSub, Symbol.species, {
      configurable: true,
      get() {
        log.push("base-species");
        return Promise;
      },
    });
    class Alternate<T> extends Promise<T> {}
    class AlternateSpeciesSub<T> extends Promise<T> {}
    Object.defineProperty(AlternateSpeciesSub, Symbol.species, {
      configurable: true,
      get() {
        log.push("alternate-species");
        return Alternate;
      },
    });
    class NullSpeciesSub<T> extends Promise<T> {}
    Object.defineProperty(NullSpeciesSub, Symbol.species, {
      configurable: true,
      get() {
        log.push("null-species");
        return null;
      },
    });
    class InvalidSpeciesSub<T> extends Promise<T> {}
    Object.defineProperty(InvalidSpeciesSub, Symbol.species, {
      configurable: true,
      get() {
        log.push("invalid-species");
        return {};
      },
    });

    const defaultResult = new DefaultSub<string>((resolve) => resolve("default")).then((value) => value);
    const baseResult = new BaseSpeciesSub<string>((resolve) => resolve("base")).then((value) => value);
    const alternateResult = new AlternateSpeciesSub<string>((resolve) => resolve("alternate")).then((value) => value);
    const nullResult = new NullSpeciesSub<string>((resolve) => resolve("null")).then((value) => value);
    const invalidResult = synchronousOutcome(() => new InvalidSpeciesSub<string>((resolve) => resolve("invalid")).then((value) => value));

    await Promise.all([defaultResult, baseResult, alternateResult, nullResult]);
    return {
      log,
      default: constructorTags(defaultResult, DefaultSub, Alternate),
      base: constructorTags(baseResult, BaseSpeciesSub, Alternate),
      alternate: constructorTags(alternateResult, AlternateSpeciesSub, Alternate),
      null: constructorTags(nullResult, NullSpeciesSub, Alternate),
      invalid: invalidResult,
    };
  });

  await runCase("finally-thenable-assimilation", async () => {
    const log: string[] = [];
    const getterReason = { name: "getter" };
    const returnedReason = { name: "returned" };
    const fulfilledThenable = Object.defineProperty({}, "then", {
      get() {
        log.push("fulfilled-then-get");
        return (resolve: (value: string) => void) => {
          log.push("fulfilled-then-call");
          resolve("ignored");
        };
      },
    });
    const rejectingThenable = {
      then(_resolve: (value: string) => void, reject: (reason: object) => void) {
        log.push("rejecting-then-call");
        reject(returnedReason);
      },
    };
    const throwingGetterThenable = Object.defineProperty({}, "then", {
      get() {
        log.push("throwing-then-get");
        throw getterReason;
      },
    });

    const fulfilled = await settlement(Promise.resolve("original").finally(() => {
      log.push("finally-fulfilled");
      return fulfilledThenable;
    }));
    const rejected = await settlement(Promise.resolve("original").finally(() => {
      log.push("finally-rejecting");
      return rejectingThenable;
    }));
    const throwing = await settlement(Promise.resolve("original").finally(() => {
      log.push("finally-throwing-getter");
      return throwingGetterThenable;
    }));

    return {
      log,
      fulfilled: tagSettlement(fulfilled),
      rejected: tagSettlement(rejected, { returnedReason }),
      throwing: tagSettlement(throwing, { getterReason }),
    };
  });

  await runCase("custom-receiver-methods", () => {
    const log: string[] = [];
    const catchReceiver = Promise.resolve("unused") as Promise<string> & { then: Promise<string>["then"] };
    Object.defineProperty(catchReceiver, "then", {
      configurable: true,
      get() {
        log.push("catch-get-then");
        return function (this: unknown, onfulfilled: unknown, onrejected: unknown) {
          log.push(`catch-call-then:${this === catchReceiver}:${typeof onfulfilled}:${typeof onrejected}`);
          return "catch-custom-return";
        };
      },
    });
    const catchReturn = catchReceiver.catch(() => "handled");

    const finallyReceiver = Promise.resolve("unused") as Promise<string> & { then: Promise<string>["then"] };
    Object.defineProperty(finallyReceiver, "then", {
      configurable: true,
      get() {
        log.push("finally-get-then");
        return function (this: unknown, onfulfilled: unknown, onrejected: unknown) {
          log.push(`finally-call-then:${this === finallyReceiver}:${typeof onfulfilled}:${typeof onrejected}`);
          return "finally-custom-return";
        };
      },
    });
    const finallyReturn = finallyReceiver.finally(() => "ignored");

    const throwingReceiver = Promise.resolve("unused") as Promise<string> & { then: Promise<string>["then"] };
    const accessorReason = { name: "accessor" };
    Object.defineProperty(throwingReceiver, "then", {
      configurable: true,
      get() {
        log.push("throwing-get-then");
        throw accessorReason;
      },
    });
    const throwingReturn = synchronousOutcome(() => throwingReceiver.catch(() => "handled"), { accessorReason });

    return {
      log,
      catchReturn,
      finallyReturn,
      throwingReturn,
    };
  });

  await runCase("self-resolution-and-unhandled", async () => {
    const log: string[] = [];
    const unhandled: string[] = [];
    const onUnhandled = (event: { reason: unknown; preventDefault(): void }): void => {
      unhandled.push(String(event.reason));
      event.preventDefault();
    };
    (globalThis as unknown as {
      addEventListener(type: string, listener: (event: { reason: unknown; preventDefault(): void }) => void): void;
    }).addEventListener("unhandledrejection", onUnhandled);
    try {
      let cycle: Promise<unknown>;
      cycle = Promise.resolve("cycle").then(() => cycle);
      const cycleSettlement = await settlement(cycle);
      await Promise.reject("handled-catch").catch((reason) => {
        log.push(`handled:${reason}`);
      });
      await Promise.reject("handled-finally").finally(() => {
        log.push("finally-before-catch");
      }).catch((reason) => {
        log.push(`finally-caught:${reason}`);
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      return {
        log,
        cycle: tagSettlement(cycleSettlement),
        unhandled,
      };
    } finally {
      (globalThis as unknown as {
        removeEventListener(type: string, listener: (event: { reason: unknown; preventDefault(): void }) => void): void;
      }).removeEventListener("unhandledrejection", onUnhandled);
    }
  });

  return { cases };
}

async function runPromiseAccounting(input: {
  readonly stateProperty: string;
}): Promise<AccountingResult> {
  function startSensitiveEpoch(stateProperty: string, sessionSeed = 0): { schedulerRegistrations?: number; poisoned?: boolean } {
    const epoch = {
      schedulerRegistrations: 0,
      pendingSchedulerCallbacks: 0,
      poisoned: false,
      processSchedulerCallback: () => undefined,
    };
    (globalThis as unknown as Record<string, unknown>)[stateProperty] = {
      active: epoch,
      poisoned: false,
      schedulerSessionRegistrations: sessionSeed,
      retainedSchedulerEpochs: [],
    };
    return epoch;
  }

  function clearSensitiveEpoch(stateProperty: string): void {
    delete (globalThis as unknown as Record<string, unknown>)[stateProperty];
  }

  async function settlement(promise: Promise<unknown>): Promise<{ readonly status: "fulfilled"; readonly value: unknown } | { readonly status: "rejected"; readonly reason: unknown }> {
    try {
      return { status: "fulfilled", value: await promise };
    } catch (reason) {
      return { status: "rejected", reason };
    }
  }

  function tagSettlement(
    result: { readonly status: "fulfilled"; readonly value: unknown } | { readonly status: "rejected"; readonly reason: unknown },
  ): unknown {
    return result.status === "fulfilled"
      ? { status: "fulfilled", value: result.value }
      : { status: "rejected", reason: result.reason };
  }

  async function measure(
    body: () => {
      readonly callbackRuns: number | string[];
      readonly promise?: Promise<unknown>;
      readonly afterSettle?: () => Promise<void>;
    },
    sessionSeed = 0,
  ): Promise<RegistrationSnapshot> {
    const epoch = startSensitiveEpoch(input.stateProperty, sessionSeed);
    const plan = body();
    const state = (globalThis as unknown as Record<string, {
      active?: unknown;
      retainedSchedulerEpochs?: unknown[];
      schedulerSessionRegistrations?: number;
      poisoned?: boolean;
    }>)[input.stateProperty];
    if (state !== undefined) {
      state.active = null;
      state.retainedSchedulerEpochs = [epoch];
    }
    const settled = plan.promise === undefined ? undefined : tagSettlement(await settlement(plan.promise));
    await plan.afterSettle?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const snapshot = {
      epochRegistrations: epoch.schedulerRegistrations ?? 0,
      sessionRegistrations: state?.schedulerSessionRegistrations ?? 0,
      poisoned: state?.poisoned === true || epoch.poisoned === true,
      callbackRuns: plan.callbackRuns,
      ...(settled === undefined ? {} : { settlement: settled }),
    };
    clearSensitiveEpoch(input.stateProperty);
    return snapshot;
  }

  return {
    twoHandlerThen: await measure(() => {
      const callbackRuns: string[] = [];
      const promise = Promise.resolve("ok").then(
        (value) => {
          callbackRuns.push("fulfilled");
          return value;
        },
        () => {
          callbackRuns.push("rejected");
          return "unexpected";
        },
      );
      return { callbackRuns, promise };
    }),
    omittedThen: await measure(() => ({
      callbackRuns: [],
      promise: Promise.resolve("pass-through").then(undefined, 42 as never),
    })),
    catchCall: await measure(() => {
      const callbackRuns: string[] = [];
      const promise = Promise.reject("boom").catch(() => {
        callbackRuns.push("caught");
        return "handled";
      });
      return { callbackRuns, promise };
    }),
    finallyReturningPromise: await measure(() => {
      const callbackRuns: string[] = [];
      const promise = Promise.resolve("original").finally(() => {
        callbackRuns.push("finally");
        return Promise.resolve("ignored");
      });
      return { callbackRuns, promise };
    }),
    nestedApplicationThen: await measure(() => {
      const callbackRuns: string[] = [];
      const promise = Promise.resolve("outer-result").then((value) => {
        callbackRuns.push("outer");
        Promise.resolve().then(() => {
          callbackRuns.push("nested");
        });
        return value;
      });
      return {
        callbackRuns,
        promise,
        afterSettle: async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        },
      };
    }),
    epochBoundary: await measure(() => {
      const runs = { count: 0 };
      const promises = Array.from({ length: 1024 }, (_unused, index) => Promise.resolve(index).then(() => {
        runs.count += 1;
      }));
      return {
        get callbackRuns() { return runs.count; },
        afterSettle: async () => {
          await Promise.all(promises);
        },
      };
    }),
    epochOverflow: await measure(() => {
      const runs = { count: 0 };
      const promises = Array.from({ length: 1025 }, (_unused, index) => Promise.resolve(index).then(() => {
        runs.count += 1;
      }));
      return {
        get callbackRuns() { return runs.count; },
        afterSettle: async () => {
          await Promise.all(promises);
        },
      };
    }),
    sessionOverflow: await measure(() => {
      const callbackRuns: string[] = [];
      const promise = Promise.resolve("session-overflow").then((value) => {
        callbackRuns.push("session-overflow-callback");
        return value;
      });
      return { callbackRuns, promise };
    }, 4096),
  };
}

function startSensitiveEpoch(stateProperty: string, sessionSeed = 0): { schedulerRegistrations?: number; poisoned?: boolean } {
  const epoch = {
    schedulerRegistrations: 0,
    pendingSchedulerCallbacks: 0,
    poisoned: false,
    processSchedulerCallback: () => undefined,
  };
  (globalThis as unknown as Record<string, unknown>)[stateProperty] = {
    active: epoch,
    poisoned: false,
    schedulerSessionRegistrations: sessionSeed,
    retainedSchedulerEpochs: [],
  };
  return epoch;
}

function clearSensitiveEpoch(stateProperty: string): void {
  delete (globalThis as unknown as Record<string, unknown>)[stateProperty];
}

async function settlement(promise: Promise<unknown>): Promise<{ readonly status: "fulfilled"; readonly value: unknown } | { readonly status: "rejected"; readonly reason: unknown }> {
  try {
    return { status: "fulfilled", value: await promise };
  } catch (reason) {
    return { status: "rejected", reason };
  }
}

function tagSettlement(
  result: { readonly status: "fulfilled"; readonly value: unknown } | { readonly status: "rejected"; readonly reason: unknown },
  identities: Record<string, unknown> = {},
): unknown {
  if (result.status === "fulfilled") {
    return { status: "fulfilled", value: tagValue(result.value, identities) };
  }
  return { status: "rejected", reason: tagValue(result.reason, identities) };
}

function tagValue(value: unknown, identities: Record<string, unknown>): unknown {
  for (const [name, identity] of Object.entries(identities)) {
    if (value === identity) return { identity: name };
  }
  if (value instanceof Error) {
    return { errorName: value.name };
  }
  if (typeof value === "object" && value !== null) {
    return { objectTag: Object.prototype.toString.call(value) };
  }
  return value;
}

function constructorTags<T>(
  value: Promise<T>,
  Sub: abstract new (...args: never[]) => Promise<T>,
  Alternate: abstract new (...args: never[]) => Promise<T>,
): unknown {
  return {
    promise: value instanceof Promise,
    sub: value instanceof Sub,
    alternate: value instanceof Alternate,
    protoIsSub: Object.getPrototypeOf(value) === Sub.prototype,
    protoIsAlternate: Object.getPrototypeOf(value) === Alternate.prototype,
    protoIsPromise: Object.getPrototypeOf(value) === Promise.prototype,
  };
}

function synchronousOutcome(
  operation: () => unknown,
  identities: Record<string, unknown> = {},
): unknown {
  try {
    const value = operation();
    return { status: "returned", value: tagValue(value, identities) };
  } catch (reason) {
    return { status: "threw", reason: tagValue(reason, identities) };
  }
}

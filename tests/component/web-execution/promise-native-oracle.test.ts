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
  readonly finallyThenableNestedRegistration: RegistrationSnapshot;
  readonly catchAccessorDefaultThen: RegistrationSnapshot;
  readonly finallyAccessorDefaultThen: RegistrationSnapshot;
  readonly customCatchDelegatesThen: RegistrationSnapshot;
  readonly customFinallyDelegatesThen: RegistrationSnapshot;
  readonly invalidSpeciesThrowCleanup: RegistrationSnapshot;
  readonly invalidArrowSpeciesFinallyCleanup: RegistrationSnapshot;
  readonly nestedApplicationThen: RegistrationSnapshot;
  readonly epochBoundary: RegistrationSnapshot;
  readonly epochOverflow: RegistrationSnapshot;
  readonly sessionOverflow: RegistrationSnapshot;
}

interface RegistrationSnapshot {
  readonly epochRegistrations: number;
  readonly sessionRegistrations: number;
  readonly pendingSchedulerCallbacks: number;
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
      pendingSchedulerCallbacks: 0,
      poisoned: false,
      callbackRuns: ["fulfilled"],
      settlement: { status: "fulfilled", value: "ok" },
    });
    expect(accounting.omittedThen).toMatchObject({
      epochRegistrations: 1,
      sessionRegistrations: 1,
      pendingSchedulerCallbacks: 0,
      poisoned: false,
      settlement: { status: "fulfilled", value: "pass-through" },
    });
    expect(accounting.catchCall).toMatchObject({
      epochRegistrations: 1,
      sessionRegistrations: 1,
      pendingSchedulerCallbacks: 0,
      poisoned: false,
      callbackRuns: ["caught"],
      settlement: { status: "fulfilled", value: "handled" },
    });
    expect(accounting.finallyReturningPromise).toMatchObject({
      epochRegistrations: 1,
      sessionRegistrations: 1,
      pendingSchedulerCallbacks: 0,
      poisoned: false,
      callbackRuns: ["finally"],
      settlement: { status: "fulfilled", value: "original" },
    });
    expect(accounting.finallyThenableNestedRegistration).toMatchObject({
      epochRegistrations: 2,
      sessionRegistrations: 2,
      pendingSchedulerCallbacks: 0,
      poisoned: false,
      callbackRuns: ["finally", "thenable", "nested"],
      settlement: { status: "fulfilled", value: "original" },
    });
    expect(accounting.catchAccessorDefaultThen).toMatchObject({
      epochRegistrations: 1,
      sessionRegistrations: 1,
      pendingSchedulerCallbacks: 0,
      poisoned: false,
      callbackRuns: ["get-then", "caught"],
      settlement: { status: "fulfilled", value: "handled" },
    });
    expect(accounting.finallyAccessorDefaultThen).toMatchObject({
      epochRegistrations: 1,
      sessionRegistrations: 1,
      pendingSchedulerCallbacks: 0,
      poisoned: false,
      callbackRuns: ["get-then", "finally"],
      settlement: { status: "fulfilled", value: "accessor-finally" },
    });
    expect(accounting.customCatchDelegatesThen).toMatchObject({
      epochRegistrations: 2,
      sessionRegistrations: 2,
      pendingSchedulerCallbacks: 0,
      poisoned: false,
      callbackRuns: ["custom-then", "caught"],
      settlement: { status: "fulfilled", value: "handled" },
    });
    expect(accounting.customFinallyDelegatesThen).toMatchObject({
      epochRegistrations: 2,
      sessionRegistrations: 2,
      pendingSchedulerCallbacks: 0,
      poisoned: false,
      callbackRuns: ["custom-then", "finally"],
      settlement: { status: "fulfilled", value: "custom-finally" },
    });
    expect(accounting.invalidSpeciesThrowCleanup).toMatchObject({
      epochRegistrations: 1,
      sessionRegistrations: 1,
      pendingSchedulerCallbacks: 0,
      poisoned: false,
      callbackRuns: [],
      settlement: { status: "threw", reason: { errorName: "TypeError" } },
    });
    expect(accounting.invalidArrowSpeciesFinallyCleanup).toMatchObject({
      epochRegistrations: 1,
      sessionRegistrations: 1,
      pendingSchedulerCallbacks: 0,
      poisoned: false,
      callbackRuns: ["species"],
      settlement: { status: "threw", reason: { errorName: "TypeError" } },
    });
    expect(accounting.nestedApplicationThen).toMatchObject({
      epochRegistrations: 2,
      sessionRegistrations: 2,
      pendingSchedulerCallbacks: 0,
      poisoned: false,
      callbackRuns: ["outer", "nested"],
      settlement: { status: "fulfilled", value: "outer-result" },
    });
    expect(accounting.epochBoundary).toMatchObject({
      epochRegistrations: 1024,
      sessionRegistrations: 1024,
      pendingSchedulerCallbacks: 0,
      poisoned: false,
      callbackRuns: 1024,
    });
    expect(accounting.epochOverflow).toMatchObject({
      epochRegistrations: 1025,
      sessionRegistrations: 1025,
      pendingSchedulerCallbacks: 0,
      poisoned: true,
      callbackRuns: 1025,
    });
    expect(accounting.sessionOverflow).toMatchObject({
      epochRegistrations: 1,
      sessionRegistrations: 4097,
      pendingSchedulerCallbacks: 0,
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
      return { errorName: value.name, errorMessage: value.message };
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
    class ArrowSpeciesSub<T> extends Promise<T> {}
    Object.defineProperty(ArrowSpeciesSub, Symbol.species, {
      configurable: true,
      get() {
        log.push("arrow-species");
        return () => ({});
      },
    });

    const defaultResult = new DefaultSub<string>((resolve) => resolve("default")).then((value) => value);
    const baseThenResult = new BaseSpeciesSub<string>((resolve) => resolve("base")).then((value) => value);
    const baseCatchResult = new BaseSpeciesSub<string>((_resolve, reject) => reject("base-catch")).catch((reason) => reason);
    const baseFinallyResult = new BaseSpeciesSub<string>((resolve) => resolve("base-finally")).finally(() => undefined);
    const alternateThenResult = new AlternateSpeciesSub<string>((resolve) => resolve("alternate")).then((value) => value);
    const alternateCatchResult = new AlternateSpeciesSub<string>((_resolve, reject) => reject("alternate-catch")).catch((reason) => reason);
    const alternateFinallyResult = new AlternateSpeciesSub<string>((resolve) => resolve("alternate-finally")).finally(() => undefined);
    const nullThenResult = new NullSpeciesSub<string>((resolve) => resolve("null")).then((value) => value);
    const nullCatchResult = new NullSpeciesSub<string>((_resolve, reject) => reject("null-catch")).catch((reason) => reason);
    const nullFinallyResult = new NullSpeciesSub<string>((resolve) => resolve("null-finally")).finally(() => undefined);
    const invalidThenResult = synchronousOutcome(() => new InvalidSpeciesSub<string>((resolve) => resolve("invalid")).then((value) => value));
    const invalidCatchResult = synchronousOutcome(() => new InvalidSpeciesSub<string>((_resolve, reject) => reject("invalid")).catch((reason) => reason));
    const invalidFinallyResult = synchronousOutcome(() => new InvalidSpeciesSub<string>((resolve) => resolve("invalid")).finally(() => undefined));
    const invalidArrowFinallyResult = synchronousOutcome(() => new ArrowSpeciesSub<string>((resolve) => resolve("invalid-arrow")).finally(() => undefined));

    await Promise.all([
      defaultResult,
      baseThenResult,
      baseCatchResult,
      baseFinallyResult,
      alternateThenResult,
      alternateCatchResult,
      alternateFinallyResult,
      nullThenResult,
      nullCatchResult,
      nullFinallyResult,
    ]);
    return {
      log,
      default: constructorTags(defaultResult, DefaultSub, Alternate),
      base: {
        then: constructorTags(baseThenResult, BaseSpeciesSub, Alternate),
        catch: constructorTags(baseCatchResult, BaseSpeciesSub, Alternate),
        finally: constructorTags(baseFinallyResult, BaseSpeciesSub, Alternate),
      },
      alternate: {
        then: constructorTags(alternateThenResult, AlternateSpeciesSub, Alternate),
        catch: constructorTags(alternateCatchResult, AlternateSpeciesSub, Alternate),
        finally: constructorTags(alternateFinallyResult, AlternateSpeciesSub, Alternate),
      },
      null: {
        then: constructorTags(nullThenResult, NullSpeciesSub, Alternate),
        catch: constructorTags(nullCatchResult, NullSpeciesSub, Alternate),
        finally: constructorTags(nullFinallyResult, NullSpeciesSub, Alternate),
      },
      invalid: {
        then: invalidThenResult,
        catch: invalidCatchResult,
        finally: invalidFinallyResult,
        arrowFinally: invalidArrowFinallyResult,
      },
    };
  });

  await runCase("finally-promise-resolve-semantics", async () => {
    const log: string[] = [];
    const baseResolveReason = { name: "base-resolve-getter" };
    const originalResolve = Object.getOwnPropertyDescriptor(Promise, "resolve");
    Object.defineProperty(Promise, "resolve", {
      configurable: true,
      get() {
        log.push("base-resolve-get");
        throw baseResolveReason;
      },
    });
    let base: Awaited<ReturnType<typeof settlement>>;
    try {
      base = await settlement(new Promise<string>((resolve) => resolve("base-original")).finally(() => {
        log.push("base-finally");
        return "ignored";
      }));
    } finally {
      if (originalResolve === undefined) {
        delete (Promise as unknown as { resolve?: unknown }).resolve;
      } else {
        Object.defineProperty(Promise, "resolve", originalResolve);
      }
    }

    class StaticResolveRejectSub<T> extends Promise<T> {}
    Object.defineProperty(StaticResolveRejectSub, Symbol.species, {
      configurable: true,
      get() {
        log.push("reject-species");
        return StaticResolveRejectSub;
      },
    });
    Object.defineProperty(StaticResolveRejectSub, "resolve", {
      configurable: true,
      get() {
        log.push("reject-resolve-get");
        return () => {
          log.push("reject-resolve-call");
          return new StaticResolveRejectSub((_resolve, reject) => reject("custom-reject"));
        };
      },
    });
    const staticReject = await settlement(new StaticResolveRejectSub<string>((resolve) => resolve("static-original")).finally(() => {
      log.push("reject-finally");
      return "ignored";
    }));

    class StaticResolveThrowSub<T> extends Promise<T> {}
    Object.defineProperty(StaticResolveThrowSub, Symbol.species, {
      configurable: true,
      get() {
        log.push("throw-species");
        return StaticResolveThrowSub;
      },
    });
    Object.defineProperty(StaticResolveThrowSub, "resolve", {
      configurable: true,
      value() {
        log.push("throw-resolve-call");
        throw new Error("custom-resolve-throw");
      },
    });
    const staticThrow = await settlement(new StaticResolveThrowSub<string>((resolve) => resolve("throw-original")).finally(() => {
      log.push("throw-finally");
      return "ignored";
    }));

    return {
      log,
      base: tagSettlement(base, { baseResolveReason }),
      staticReject: tagSettlement(staticReject),
      staticThrow: tagSettlement(staticThrow),
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

  await runCase("custom-receiver-methods", async () => {
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

    const delegatedCatchReceiver = Promise.reject("delegated-catch") as Promise<string> & { then: Promise<string>["then"] };
    Object.defineProperty(delegatedCatchReceiver, "then", {
      configurable: true,
      get() {
        log.push("delegated-catch-get-then");
        return function (this: Promise<string>, onfulfilled: Parameters<Promise<string>["then"]>[0], onrejected: Parameters<Promise<string>["then"]>[1]) {
          log.push(`delegated-catch-call-then:${this === delegatedCatchReceiver}:${typeof onfulfilled}:${typeof onrejected}`);
          return Promise.prototype.then.call(this, onfulfilled, onrejected);
        };
      },
    });
    const delegatedCatchReturn = delegatedCatchReceiver.catch((reason) => `handled:${reason}`);

    const delegatedFinallyReceiver = Promise.resolve("delegated-finally") as Promise<string> & { then: Promise<string>["then"] };
    Object.defineProperty(delegatedFinallyReceiver, "then", {
      configurable: true,
      get() {
        log.push("delegated-finally-get-then");
        return function (this: Promise<string>, onfulfilled: Parameters<Promise<string>["then"]>[0], onrejected: Parameters<Promise<string>["then"]>[1]) {
          log.push(`delegated-finally-call-then:${this === delegatedFinallyReceiver}:${typeof onfulfilled}:${typeof onrejected}`);
          return Promise.prototype.then.call(this, onfulfilled, onrejected);
        };
      },
    });
    const delegatedFinallyReturn = delegatedFinallyReceiver.finally(() => {
      log.push("delegated-finally-handler");
    });

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

    function proxyTrapOutcome(method: "catch" | "finally"): unknown {
      const proxyLog: string[] = [];
      const target = Promise.resolve("proxy");
      const proxy = new Proxy(target, {
        get(targetValue, property, receiver) {
          proxyLog.push(`get:${String(property)}`);
          return Reflect.get(targetValue, property, receiver);
        },
        getOwnPropertyDescriptor(targetValue, property) {
          proxyLog.push(`gopd:${String(property)}`);
          return Reflect.getOwnPropertyDescriptor(targetValue, property);
        },
        getPrototypeOf(targetValue) {
          proxyLog.push("gpo");
          return Reflect.getPrototypeOf(targetValue);
        },
      });
      const outcome = synchronousOutcome(() => Promise.prototype[method].call(proxy, () => "proxy-handled"));
      return { log: proxyLog, outcome };
    }

    return {
      log,
      catchReturn,
      finallyReturn,
      delegatedCatch: tagSettlement(await settlement(delegatedCatchReturn)),
      delegatedFinally: tagSettlement(await settlement(delegatedFinallyReturn)),
      throwingReturn,
      proxyCatch: proxyTrapOutcome("catch"),
      proxyFinally: proxyTrapOutcome("finally"),
    };
  });

  await runCase("synchronous-type-errors", () => {
    const log: string[] = [];
    const nonCallableFinallyReceiver = {
      get constructor() {
        log.push("noncallable-constructor");
        return Promise;
      },
      get then() {
        log.push("noncallable-then");
        return 1;
      },
    };
    const invalidSpeciesReceiver = {
      get constructor() {
        log.push("invalid-constructor");
        return {
          get [Symbol.species]() {
            log.push("invalid-species");
            return {};
          },
        };
      },
      get then() {
        log.push("invalid-then");
        return Promise.prototype.then;
      },
    };
    const arrowSpeciesReceiver = {
      get constructor() {
        log.push("arrow-constructor");
        return {
          get [Symbol.species]() {
            log.push("arrow-species");
            return () => ({});
          },
        };
      },
      get then() {
        log.push("arrow-then");
        return Promise.prototype.then;
      },
    };

    return {
      log,
      catchNonCallableThen: synchronousOutcome(() => Promise.prototype.catch.call({ then: 1 }, () => "handled")),
      finallyNonCallableThen: synchronousOutcome(() => Promise.prototype.finally.call(nonCallableFinallyReceiver, () => "ignored")),
      finallyPrimitiveReceiver: synchronousOutcome(() => Promise.prototype.finally.call(1, () => "ignored")),
      finallyInvalidSpecies: synchronousOutcome(() => Promise.prototype.finally.call(invalidSpeciesReceiver, () => "ignored")),
      finallyArrowSpecies: synchronousOutcome(() => Promise.prototype.finally.call(arrowSpeciesReceiver, () => "ignored")),
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
      const handlerThrowReason = { name: "handler-throw" };
      const handlerThrowSettlement = await settlement(Promise.resolve("throw").then(() => {
        log.push("handler-throw");
        throw handlerThrowReason;
      }));
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
        handlerThrow: tagSettlement(handlerThrowSettlement, { handlerThrowReason }),
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

  function tagThrown(value: unknown): unknown {
    return value instanceof Error ? { errorName: value.name, errorMessage: value.message } : value;
  }

  function synchronousOutcome(operation: () => unknown): unknown {
    try {
      return { status: "returned", value: operation() };
    } catch (reason) {
      return { status: "threw", reason: tagThrown(reason) };
    }
  }

  async function measure(
    body: () => {
      readonly callbackRuns: number | string[];
      readonly promise?: Promise<unknown>;
      readonly settlement?: unknown;
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
    if (plan.afterSettle === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    } else {
      await plan.afterSettle();
    }
    const settled = plan.promise === undefined ? plan.settlement : tagSettlement(await settlement(plan.promise));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const snapshot = {
      epochRegistrations: epoch.schedulerRegistrations ?? 0,
      sessionRegistrations: state?.schedulerSessionRegistrations ?? 0,
      pendingSchedulerCallbacks: (epoch as { pendingSchedulerCallbacks?: number }).pendingSchedulerCallbacks ?? 0,
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
    finallyThenableNestedRegistration: await measure(() => {
      const callbackRuns: string[] = [];
      const promise = Promise.resolve("original").finally(() => {
        callbackRuns.push("finally");
        return {
          then(resolve: (value: string) => void) {
            callbackRuns.push("thenable");
            Promise.resolve().then(() => {
              callbackRuns.push("nested");
            });
            resolve("ignored");
          },
        };
      });
      return {
        callbackRuns,
        promise,
        afterSettle: async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        },
      };
    }),
    catchAccessorDefaultThen: await measure(() => {
      const callbackRuns: string[] = [];
      const receiver = Promise.reject("boom") as Promise<string> & { then: Promise<string>["then"] };
      Object.defineProperty(receiver, "then", {
        configurable: true,
        get() {
          callbackRuns.push("get-then");
          return Promise.prototype.then;
        },
      });
      const promise = receiver.catch(() => {
        callbackRuns.push("caught");
        return "handled";
      });
      return { callbackRuns, promise };
    }),
    finallyAccessorDefaultThen: await measure(() => {
      const callbackRuns: string[] = [];
      const receiver = Promise.resolve("accessor-finally") as Promise<string> & { then: Promise<string>["then"] };
      Object.defineProperty(receiver, "then", {
        configurable: true,
        get() {
          callbackRuns.push("get-then");
          return Promise.prototype.then;
        },
      });
      const promise = receiver.finally(() => {
        callbackRuns.push("finally");
      });
      return { callbackRuns, promise };
    }),
    customCatchDelegatesThen: await measure(() => {
      const callbackRuns: string[] = [];
      const receiver = Promise.reject("boom") as Promise<string> & { then: Promise<string>["then"] };
      Object.defineProperty(receiver, "then", {
        configurable: true,
        get() {
          return function (this: Promise<string>, onfulfilled: Parameters<Promise<string>["then"]>[0], onrejected: Parameters<Promise<string>["then"]>[1]) {
            callbackRuns.push("custom-then");
            return Promise.prototype.then.call(this, onfulfilled, onrejected);
          };
        },
      });
      const promise = receiver.catch(() => {
        callbackRuns.push("caught");
        return "handled";
      });
      return { callbackRuns, promise };
    }),
    customFinallyDelegatesThen: await measure(() => {
      const callbackRuns: string[] = [];
      const receiver = Promise.resolve("custom-finally") as Promise<string> & { then: Promise<string>["then"] };
      Object.defineProperty(receiver, "then", {
        configurable: true,
        get() {
          return function (this: Promise<string>, onfulfilled: Parameters<Promise<string>["then"]>[0], onrejected: Parameters<Promise<string>["then"]>[1]) {
            callbackRuns.push("custom-then");
            return Promise.prototype.then.call(this, onfulfilled, onrejected);
          };
        },
      });
      const promise = receiver.finally(() => {
        callbackRuns.push("finally");
      });
      return { callbackRuns, promise };
    }),
    invalidSpeciesThrowCleanup: await measure(() => {
      class InvalidSpeciesSub<T> extends Promise<T> {}
      Object.defineProperty(InvalidSpeciesSub, Symbol.species, {
        configurable: true,
        get() {
          return {};
        },
      });
      const outcome = synchronousOutcome(() => new InvalidSpeciesSub<string>((resolve) => resolve("invalid")).then((value) => value));
      return { callbackRuns: [], settlement: outcome };
    }),
    invalidArrowSpeciesFinallyCleanup: await measure(() => {
      const callbackRuns: string[] = [];
      class ArrowSpeciesSub<T> extends Promise<T> {}
      Object.defineProperty(ArrowSpeciesSub, Symbol.species, {
        configurable: true,
        get() {
          callbackRuns.push("species");
          return () => ({});
        },
      });
      const outcome = synchronousOutcome(() => new ArrowSpeciesSub<string>((resolve) => resolve("invalid-arrow")).finally(() => {
        callbackRuns.push("finally");
      }));
      return { callbackRuns, settlement: outcome };
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
    return { errorName: value.name, errorMessage: value.message };
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

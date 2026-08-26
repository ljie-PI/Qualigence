import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { ExecutionTargetError, type ExecutionTargetErrorStatus } from "@qualigence/runner-kernel";
import type { CapturedArtifact, LocatorDescriptor } from "./types.js";
import {
  MAX_SENSITIVE_PROMISE_OWNER_REGISTRY_OWNERS,
  MAX_SENSITIVE_SCHEDULER_REGISTRATIONS_PER_EPOCH,
  MAX_SENSITIVE_SCHEDULER_REGISTRATIONS_PER_SESSION,
  MAX_SENSITIVE_SHADOW_ROOTS,
  SensitiveEvidenceAuthority,
  SENSITIVE_EVIDENCE_STATE_PROPERTY,
  SENSITIVE_SHADOW_ROOTS_PROPERTY,
  type PreparedSensitiveEvidenceRecord,
} from "./sensitive-evidence-authority.js";

export type WebTargetErrorCode =
  | "BrowserLaunchFailed"
  | "NavigationFailed"
  | "NavigationTimedOut"
  | "StaleObservation"
  | "UnknownObservationNode"
  | "TargetNotFound"
  | "AmbiguousTarget"
  | "OriginViolation"
  | "ActionTimedOut"
  | "ActionInfrastructureFailure"
  | "TargetNotVisible"
  | "TargetDisabled"
  | "ActionValueUnavailable"
  | "SensitiveEvidenceUnavailable"
  | "UnsupportedAction"
  | "ConcurrentSessionOperation"
  | "SessionClosed";

export class WebTargetError extends ExecutionTargetError {
  constructor(
    readonly code: WebTargetErrorCode,
    message?: string,
  ) {
    super(code, completionStatus(code), message);
    this.name = "WebTargetError";
  }
}

function completionStatus(code: WebTargetErrorCode): ExecutionTargetErrorStatus {
  switch (code) {
    case "StaleObservation":
    case "UnknownObservationNode":
    case "TargetNotFound":
    case "AmbiguousTarget":
    case "OriginViolation":
    case "ActionTimedOut":
    case "TargetNotVisible":
    case "TargetDisabled":
    case "ActionValueUnavailable":
    case "UnsupportedAction":
      return "blocked";
    case "SensitiveEvidenceUnavailable":
    case "BrowserLaunchFailed":
    case "NavigationFailed":
    case "NavigationTimedOut":
    case "ActionInfrastructureFailure":
    case "ConcurrentSessionOperation":
    case "SessionClosed":
      return "error";
    default:
      return assertNever(code);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled WebTargetError code: ${String(value)}`);
}

function sensitiveEvidenceUnavailable(): WebTargetError {
  return new WebTargetError(
    "SensitiveEvidenceUnavailable",
    "Sensitive target evidence could not be proven.",
  );
}

function validateSensitivePromiseOwnerRegistryInPage(input: {
  readonly runtimeRegistryProperty: string;
  readonly maxPromiseOwners: number;
}): { readonly status: "ok" | "failed"; readonly reason?: string } {
  type PromiseOwnerValidationResult = { readonly status: "ok" | "failed"; readonly reason?: string };
  type RuntimeRegistry = {
    readonly validatePromiseOwners?: (maxPromiseOwners: number) => PromiseOwnerValidationResult;
    promiseOwnerValidationFailed?: boolean;
  };
  const registry = (globalThis as unknown as Record<string, RuntimeRegistry | undefined>)[input.runtimeRegistryProperty];
  if (registry === undefined) return { status: "ok" };
  const validatePromiseOwners = registry.validatePromiseOwners;
  if (typeof validatePromiseOwners !== "function") return fail(registry, "missing-validator");
  try {
    const result = validatePromiseOwners(input.maxPromiseOwners);
    if (result.status !== "ok") {
      try {
        registry.promiseOwnerValidationFailed = true;
      } catch {
        // The authoritative validation latch is closure-owned; a read-only debug
        // surface may reject direct writes. The returned failure is sufficient.
      }
    }
    return result;
  } catch {
    return fail(registry, "inspection-threw");
  }

  function fail(target: RuntimeRegistry, reason: string): { readonly status: "failed"; readonly reason: string } {
    try {
      target.promiseOwnerValidationFailed = true;
    } catch {
      // Best effort only: validation must fail closed even if page-visible debug
      // fields are immutable or accessor-backed.
    }
    return { status: "failed", reason };
  }
}

async function installSensitiveEvidenceRuntime(page: Page): Promise<void> {
  if (typeof page.addInitScript !== "function") return;
  await page.addInitScript((input: {
    readonly shadowRootsProperty: string;
    readonly evidenceStateProperty: string;
    readonly maxShadowRoots: number;
    readonly maxSchedulerRegistrationsPerEpoch: number;
    readonly maxSchedulerRegistrationsPerSession: number;
    readonly maxPromiseOwners: number;
  }) => {
    type PromiseMethodName = "then" | "catch" | "finally";
    type DescriptorSnapshot =
      | { readonly present: false }
      | {
        readonly present: true;
        readonly kind: "data";
        readonly configurable: boolean;
        readonly enumerable: boolean;
        readonly writable: boolean;
        readonly value: unknown;
      }
      | {
        readonly present: true;
        readonly kind: "accessor";
        readonly configurable: boolean;
        readonly enumerable: boolean;
        readonly get: unknown;
        readonly set: unknown;
      };
    type ResolvedMethodOwnerSnapshot =
      | { readonly present: false }
      | { readonly present: true; readonly owner: object };
    type PromiseOwnerRecord = {
      readonly owner: object;
      readonly prototype: object | null;
      readonly descriptors: Readonly<Record<PromiseMethodName, DescriptorSnapshot>>;
      readonly resolvedMethodOwners: Readonly<Record<PromiseMethodName, ResolvedMethodOwnerSnapshot>>;
    };
    type PromiseOwnerValidationResult = { readonly status: "ok" | "failed"; readonly reason?: string };
    type SensitiveRuntimeRegistry = {
      readonly roots: ShadowRoot[];
      readonly listenerTargets: { readonly type: string; readonly target: EventTarget; readonly listener: EventListenerOrEventListenerObject }[];
      readonly promiseOwners?: readonly PromiseOwnerRecord[];
      shadowRootOverflow: boolean;
      readonly promiseOwnerOverflow?: boolean;
      readonly promiseOwnerValidationFailed?: boolean;
      readonly validatePromiseOwners?: (maxPromiseOwners: number) => PromiseOwnerValidationResult;
      readonly originalAttachShadow: typeof Element.prototype.attachShadow;
      readonly originalAddEventListener: typeof EventTarget.prototype.addEventListener;
      readonly originalSetTimeout: typeof window.setTimeout;
      readonly originalSetInterval: typeof window.setInterval;
      readonly originalRequestAnimationFrame: typeof window.requestAnimationFrame;
      readonly originalQueueMicrotask: typeof window.queueMicrotask;
      readonly originalPromiseThen: typeof Promise.prototype.then;
      readonly originalPromiseCatch: typeof Promise.prototype.catch;
      readonly originalPromiseFinally: typeof Promise.prototype.finally;
      readonly originalReflectApply: typeof Reflect.apply;
    };
    type PendingSchedulerCallback = {
      settled: boolean;
      readonly settles: boolean;
      readonly retainObjectResult: boolean;
      retainedAfterReturn: boolean;
    };
    type SensitiveSchedulerEpoch = {
      schedulerRegistrations?: number;
      pendingSchedulerCallbacks?: number;
      retainedSchedulerCallbacks?: number;
      inSchedulerCallback?: boolean;
      poisoned?: boolean;
      processSchedulerCallback?: () => void;
    };
    type SensitiveRuntimeState = {
      active?: SensitiveSchedulerEpoch | null;
      poisoned?: boolean;
      schedulerSessionRegistrations?: number;
      retainedSchedulerEpochs?: SensitiveSchedulerEpoch[];
    };
    type InternalPromiseThenCall = {
      readonly receiver: unknown;
      readonly onfulfilled?: unknown;
      readonly onrejected?: unknown;
      readonly epoch: SensitiveSchedulerEpoch | undefined;
      readonly wrapHandlers: boolean;
      consumed: boolean;
    };
    const promiseMethods: readonly PromiseMethodName[] = ["then", "catch", "finally"];
    const win = window as unknown as Record<string, SensitiveRuntimeRegistry | undefined>;
    if (win[input.shadowRootsProperty] !== undefined) return;
    const promiseOwnerRecords: PromiseOwnerRecord[] = [];
    let promiseOwnerOverflow = false;
    let promiseOwnerValidationFailed = false;
    const registry: SensitiveRuntimeRegistry = {
      roots: [],
      listenerTargets: [],
      shadowRootOverflow: false,
      originalAttachShadow: Element.prototype.attachShadow,
      originalAddEventListener: EventTarget.prototype.addEventListener,
      originalSetTimeout: window.setTimeout,
      originalSetInterval: window.setInterval,
      originalRequestAnimationFrame: window.requestAnimationFrame,
      originalQueueMicrotask: window.queueMicrotask,
      originalPromiseThen: Promise.prototype.then,
      originalPromiseCatch: Promise.prototype.catch,
      originalPromiseFinally: Promise.prototype.finally,
      originalReflectApply: Reflect.apply,
    };
    Object.defineProperties(registry, {
      promiseOwners: {
        configurable: false,
        enumerable: false,
        get: promiseOwnerDebugSnapshot,
      },
      promiseOwnerOverflow: {
        configurable: false,
        enumerable: false,
        get: () => promiseOwnerOverflow,
      },
      promiseOwnerValidationFailed: {
        configurable: false,
        enumerable: false,
        get: () => promiseOwnerValidationFailed,
      },
      validatePromiseOwners: {
        configurable: false,
        enumerable: false,
        value: validatePromiseOwnerRecords,
        writable: false,
      },
    });
    Object.defineProperty(win, input.shadowRootsProperty, {
      configurable: false,
      enumerable: false,
      value: registry,
      writable: false,
    });
    Element.prototype.attachShadow = function attachShadow(init: ShadowRootInit): ShadowRoot {
      const root = registry.originalAttachShadow.call(this, init);
      const state = sensitiveState();
      const active = state === undefined ? undefined : currentSensitiveEpoch(state);
      if (init.mode === "closed" && state !== undefined && active !== undefined) {
        poison(state, active);
      }
      if (!registry.roots.includes(root)) {
        if (registry.roots.length >= input.maxShadowRoots) {
          registry.shadowRootOverflow = true;
          if (state !== undefined && active !== undefined) {
            poison(state, active);
          }
          return root;
        }
        registry.roots.push(root);
      }
      return root;
    };
    EventTarget.prototype.addEventListener = function addEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ): void {
      const isSensitiveInstrumentation = listener !== null &&
        (typeof listener === "function" || typeof listener === "object") &&
        (listener as unknown as Record<string, unknown>).__qualigenceSensitiveInstrumentation === true;
      if ((type === "input" || type === "change") && listener !== null && !isSensitiveInstrumentation) {
        registry.listenerTargets.push({ type, target: this, listener });
      }
      registry.originalAddEventListener.call(this, type, listener, options);
    };

    window.setTimeout = function setTimeout(handler: TimerHandler, timeout?: number, ...args: unknown[]): number {
      const epoch = countSensitiveSchedulerRegistration();
      const wrapped = typeof handler === "function" && epoch !== undefined
        ? wrapSchedulerCallback(handler as (...callbackArgs: unknown[]) => unknown, epoch, true)
        : handler;
      poisonUnwrappedSensitiveSchedulerCallback(epoch, handler);
      return (registry.originalSetTimeout as any).apply(window, [
        wrapped,
        timeout,
        ...args,
      ]) as number;
    } as typeof window.setTimeout;
    window.setInterval = function setInterval(handler: TimerHandler, timeout?: number, ...args: unknown[]): number {
      const epoch = countSensitiveSchedulerRegistration();
      const wrapped = typeof handler === "function" && epoch !== undefined
        ? wrapSchedulerCallback(handler as (...callbackArgs: unknown[]) => unknown, epoch, false)
        : handler;
      poisonUnwrappedSensitiveSchedulerCallback(epoch, handler);
      return (registry.originalSetInterval as any).apply(window, [
        wrapped,
        timeout,
        ...args,
      ]) as number;
    } as typeof window.setInterval;
    window.requestAnimationFrame = function requestAnimationFrame(callback: FrameRequestCallback): number {
      const epoch = countSensitiveSchedulerRegistration();
      return registry.originalRequestAnimationFrame.call(
        window,
        epoch === undefined ? callback : wrapSchedulerCallback(callback, epoch, true),
      );
    };
    window.queueMicrotask = function queueMicrotask(callback: VoidFunction): void {
      const epoch = countSensitiveSchedulerRegistration();
      registry.originalQueueMicrotask.call(
        window,
        epoch === undefined ? callback : wrapSchedulerCallback(callback, epoch, true),
      );
    };
    const internalPromiseThenCalls: InternalPromiseThenCall[] = [];
    const retainedInternalPromiseThenCalls: InternalPromiseThenCall[] = [];

    const instrumentedPromiseThen = function then<TResult1 = unknown, TResult2 = never>(
      this: unknown,
      onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
      "use strict";
      const internalCall = consumeInternalPromiseThenCall(this, onfulfilled, onrejected);
      const epoch = internalCall === undefined
        ? countSensitiveSchedulerRegistration()
        : internalCall.epoch;
      registerPromiseMethodAuthority(this, "then", epoch);
      const wrapHandlers = internalCall?.wrapHandlers ?? true;
      const handlers = epoch === undefined || !wrapHandlers
        ? { onfulfilled, onrejected }
        : wrapPromiseReactionHandlers(onfulfilled, onrejected, epoch);
      try {
        return registry.originalPromiseThen.call(
          this,
          handlers.onfulfilled,
          handlers.onrejected,
        ) as Promise<TResult1 | TResult2>;
      } catch (error) {
        if ("pending" in handlers && handlers.pending !== undefined) {
          settlePendingSchedulerCallback(epoch, handlers.pending);
        }
        throw error;
      }
    };
    Promise.prototype.then = instrumentedPromiseThen;
    Promise.prototype.catch = function promiseCatch<TResult = never>(
      onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
    ): Promise<unknown | TResult> {
      "use strict";
      const epoch = countSensitiveSchedulerRegistration();
      registerPromiseMethodAuthority(this, "catch", epoch);
      return invokePromiseThen(this, undefined, onrejected, epoch, true) as Promise<unknown | TResult>;
    };
    Promise.prototype.finally = function promiseFinally(onfinally?: (() => void) | null): Promise<unknown> {
      "use strict";
      const receiver = this;
      const epoch = countSensitiveSchedulerRegistration();
      registerPromiseMethodAuthority(receiver, "finally", epoch);
      const C = promiseSpeciesConstructor(receiver);
      const finallyHandler = epoch === undefined || typeof onfinally !== "function"
        ? { callback: onfinally }
        : wrapPromiseFinallyHandler(onfinally, epoch);
      const finallyCallback = finallyHandler.callback;
      const onFulfilled = typeof finallyCallback === "function"
        ? (value: unknown) => {
          const result = finallyCallback();
          const promise = promiseResolve(C, result);
          const continuation = invokePromiseThenResult(promise, () => value, undefined, epoch, false);
          retainReturnedPromiseAssimilation(continuation, epoch);
          return continuation.value;
        }
        : finallyCallback;
      const onRejected = typeof finallyCallback === "function"
        ? (reason: unknown) => {
          const result = finallyCallback();
          const promise = promiseResolve(C, result);
          const continuation = invokePromiseThenResult(promise, () => { throw reason; }, undefined, epoch, false);
          retainReturnedPromiseAssimilation(continuation, epoch);
          return continuation.value;
        }
        : finallyCallback;
      try {
        return invokePromiseThen(receiver, onFulfilled, onRejected, epoch, false) as Promise<unknown>;
      } catch (error) {
        if ("pending" in finallyHandler && finallyHandler.pending !== undefined) {
          settlePendingSchedulerCallback(epoch, finallyHandler.pending);
        }
        throw error;
      }
    };

    function withInternalPromiseThenCall<T>(call: InternalPromiseThenCall, operation: () => T): T {
      internalPromiseThenCalls.push(call);
      try {
        return operation();
      } finally {
        const index = internalPromiseThenCalls.lastIndexOf(call);
        if (index !== -1) internalPromiseThenCalls.splice(index, 1);
      }
    }

    function consumeInternalPromiseThenCall(
      receiver: unknown,
      onfulfilled: unknown,
      onrejected: unknown,
    ): InternalPromiseThenCall | undefined {
      const stacked = consumeMatchingInternalPromiseThenCall(internalPromiseThenCalls, receiver, onfulfilled, onrejected);
      if (stacked !== undefined) return stacked;
      return consumeMatchingInternalPromiseThenCall(retainedInternalPromiseThenCalls, receiver, onfulfilled, onrejected);
    }

    function consumeMatchingInternalPromiseThenCall(
      calls: InternalPromiseThenCall[],
      receiver: unknown,
      onfulfilled: unknown,
      onrejected: unknown,
    ): InternalPromiseThenCall | undefined {
      for (let index = calls.length - 1; index >= 0; index -= 1) {
        const call = calls[index]!;
        if (call.consumed || call.receiver !== receiver) continue;
        const fulfilledMatches = call.onfulfilled === undefined || call.onfulfilled === onfulfilled;
        const rejectedMatches = call.onrejected === undefined || call.onrejected === onrejected;
        if (!fulfilledMatches || !rejectedMatches) continue;
        call.consumed = true;
        if (calls === retainedInternalPromiseThenCalls) calls.splice(index, 1);
        return call;
      }
      return undefined;
    }

    function sensitiveState(): SensitiveRuntimeState | undefined {
      return (window as unknown as Record<string, SensitiveRuntimeState | undefined>)[input.evidenceStateProperty];
    }

    function registerPromiseMethodAuthority(
      receiver: unknown,
      method: PromiseMethodName,
      epoch: SensitiveSchedulerEpoch | undefined,
    ): void {
      const state = sensitiveState();
      if (state === undefined || epoch === undefined || !shouldTrackPromiseOwnerAuthority(state) || !isObjectLike(receiver)) {
        return;
      }
      try {
        const owners = traversedMethodOwners(receiver, method);
        for (const owner of owners) registerPromiseOwner(owner, state, epoch);
      } catch {
        poison(state, epoch);
      }
    }

    function shouldTrackPromiseOwnerAuthority(state: SensitiveRuntimeState): boolean {
      // Production sensitive-evidence epochs created by the action executor carry
      // `records`. Counter-only oracle epochs intentionally omit it so Ticket 42
      // native Promise trap/order tests remain side-effect-free.
      return Array.isArray((state as { readonly records?: unknown }).records);
    }

    function traversedMethodOwners(receiver: object, method: PromiseMethodName): object[] {
      const owners: object[] = [];
      const visited = new Set<object>();
      let current: object | null = receiver;
      while (current !== null) {
        if (visited.has(current)) throw new Error("cyclic-prototype-chain");
        visited.add(current);
        owners.push(current);
        if (Object.prototype.hasOwnProperty.call(current, method)) break;
        current = Object.getPrototypeOf(current);
      }
      return owners;
    }

    function registerPromiseOwner(owner: object, state: SensitiveRuntimeState, epoch: SensitiveSchedulerEpoch): void {
      const existingIndex = promiseOwnerRecords.findIndex((record) => record.owner === owner);
      let snapshot: PromiseOwnerRecord;
      try {
        snapshot = snapshotPromiseOwner(owner);
      } catch {
        poison(state, epoch);
        return;
      }
      if (existingIndex !== -1) {
        promiseOwnerRecords[existingIndex] = snapshot;
        return;
      }
      if (promiseOwnerRecords.length >= input.maxPromiseOwners) {
        promiseOwnerOverflow = true;
        poison(state, epoch);
        return;
      }
      promiseOwnerRecords.push(snapshot);
    }

    function snapshotPromiseOwner(owner: object): PromiseOwnerRecord {
      const descriptors = Object.freeze({
        then: Object.freeze(snapshotOwnDescriptor(owner, "then")),
        catch: Object.freeze(snapshotOwnDescriptor(owner, "catch")),
        finally: Object.freeze(snapshotOwnDescriptor(owner, "finally")),
      });
      const resolvedMethodOwners = Object.freeze({
        then: Object.freeze(snapshotResolvedMethodOwner(owner, "then")),
        catch: Object.freeze(snapshotResolvedMethodOwner(owner, "catch")),
        finally: Object.freeze(snapshotResolvedMethodOwner(owner, "finally")),
      });
      return Object.freeze({
        owner,
        prototype: Object.getPrototypeOf(owner),
        descriptors,
        resolvedMethodOwners,
      });
    }

    function promiseOwnerDebugSnapshot(): readonly PromiseOwnerRecord[] {
      const records: PromiseOwnerRecord[] = [];
      for (let index = 0; index < promiseOwnerRecords.length; index += 1) {
        records[index] = clonePromiseOwnerRecord(promiseOwnerRecords[index]!);
      }
      return Object.freeze(records);
    }

    function clonePromiseOwnerRecord(record: PromiseOwnerRecord): PromiseOwnerRecord {
      return Object.freeze({
        owner: record.owner,
        prototype: record.prototype,
        descriptors: Object.freeze({
          then: Object.freeze(cloneDescriptorSnapshot(record.descriptors.then)),
          catch: Object.freeze(cloneDescriptorSnapshot(record.descriptors.catch)),
          finally: Object.freeze(cloneDescriptorSnapshot(record.descriptors.finally)),
        }),
        resolvedMethodOwners: Object.freeze({
          then: Object.freeze(cloneResolvedMethodOwnerSnapshot(record.resolvedMethodOwners.then)),
          catch: Object.freeze(cloneResolvedMethodOwnerSnapshot(record.resolvedMethodOwners.catch)),
          finally: Object.freeze(cloneResolvedMethodOwnerSnapshot(record.resolvedMethodOwners.finally)),
        }),
      });
    }

    function cloneDescriptorSnapshot(snapshot: DescriptorSnapshot): DescriptorSnapshot {
      if (!snapshot.present) return { present: false };
      if (snapshot.kind === "data") {
        return {
          present: true,
          kind: "data",
          configurable: snapshot.configurable,
          enumerable: snapshot.enumerable,
          writable: snapshot.writable,
          value: snapshot.value,
        };
      }
      return {
        present: true,
        kind: "accessor",
        configurable: snapshot.configurable,
        enumerable: snapshot.enumerable,
        get: snapshot.get,
        set: snapshot.set,
      };
    }

    function cloneResolvedMethodOwnerSnapshot(snapshot: ResolvedMethodOwnerSnapshot): ResolvedMethodOwnerSnapshot {
      if (!snapshot.present) return { present: false };
      return { present: true, owner: snapshot.owner };
    }

    function snapshotOwnDescriptor(owner: object, method: PromiseMethodName): DescriptorSnapshot {
      const descriptor = Object.getOwnPropertyDescriptor(owner, method);
      if (descriptor === undefined) return { present: false };
      if ("value" in descriptor || "writable" in descriptor) {
        return {
          present: true,
          kind: "data",
          configurable: descriptor.configurable === true,
          enumerable: descriptor.enumerable === true,
          writable: descriptor.writable === true,
          value: descriptor.value,
        };
      }
      return {
        present: true,
        kind: "accessor",
        configurable: descriptor.configurable === true,
        enumerable: descriptor.enumerable === true,
        get: descriptor.get,
        set: descriptor.set,
      };
    }

    function snapshotResolvedMethodOwner(owner: object, method: PromiseMethodName): ResolvedMethodOwnerSnapshot {
      const visited = new Set<object>();
      let current: object | null = owner;
      while (current !== null) {
        if (visited.has(current)) throw new Error("cyclic-prototype-chain");
        visited.add(current);
        if (Object.prototype.hasOwnProperty.call(current, method)) {
          return { present: true, owner: current };
        }
        current = Object.getPrototypeOf(current);
      }
      return { present: false };
    }

    function validatePromiseOwnerRecords(maxPromiseOwners: number): PromiseOwnerValidationResult {
      if (promiseOwnerOverflow || promiseOwnerValidationFailed) {
        promiseOwnerValidationFailed = true;
        return { status: "failed", reason: "poisoned" };
      }
      if (promiseOwnerRecords.length > maxPromiseOwners) return failPromiseOwnerValidation("overflow-length");
      const seen = new Set<object>();
      try {
        for (let index = 0; index < promiseOwnerRecords.length; index += 1) {
          if (!(index in promiseOwnerRecords)) return failPromiseOwnerValidation("incomplete-enumeration");
          const record = promiseOwnerRecords[index]!;
          if (!isObjectLike(record) || !isObjectLike(record.owner)) return failPromiseOwnerValidation("invalid-record");
          if (seen.has(record.owner)) return failPromiseOwnerValidation("duplicate-owner");
          seen.add(record.owner);
          if (Object.getPrototypeOf(record.owner) !== record.prototype) return failPromiseOwnerValidation("prototype-mismatch");
          for (const method of promiseMethods) {
            if (!sameDescriptorSnapshot(snapshotOwnDescriptor(record.owner, method), record.descriptors[method])) {
              return failPromiseOwnerValidation(`${method}-descriptor-mismatch`);
            }
            if (!sameResolvedMethodOwner(snapshotResolvedMethodOwner(record.owner, method), record.resolvedMethodOwners[method])) {
              return failPromiseOwnerValidation(`${method}-owner-mismatch`);
            }
          }
        }
        if (seen.size !== promiseOwnerRecords.length) return failPromiseOwnerValidation("incomplete-enumeration");
      } catch {
        return failPromiseOwnerValidation("inspection-threw");
      }
      return { status: "ok" };
    }

    function failPromiseOwnerValidation(reason: string): PromiseOwnerValidationResult {
      promiseOwnerValidationFailed = true;
      return { status: "failed", reason };
    }

    function sameDescriptorSnapshot(left: DescriptorSnapshot, right: DescriptorSnapshot): boolean {
      if (left.present !== right.present) return false;
      if (!left.present || !right.present) return true;
      if (left.kind !== right.kind) return false;
      if (left.configurable !== right.configurable || left.enumerable !== right.enumerable) return false;
      if (left.kind === "data") {
        return right.kind === "data" && left.writable === right.writable && left.value === right.value;
      }
      return right.kind === "accessor" && left.get === right.get && left.set === right.set;
    }

    function sameResolvedMethodOwner(left: ResolvedMethodOwnerSnapshot, right: ResolvedMethodOwnerSnapshot): boolean {
      if (left.present !== right.present) return false;
      if (!left.present || !right.present) return true;
      return left.owner === right.owner;
    }

    function invokePromiseThen(
      receiver: unknown,
      onfulfilled: unknown,
      onrejected: unknown,
      epoch: SensitiveSchedulerEpoch | undefined,
      wrapHandlers: boolean,
    ): unknown {
      return invokePromiseThenResult(receiver, onfulfilled, onrejected, epoch, wrapHandlers).value;
    }

    function invokePromiseThenResult(
      receiver: unknown,
      onfulfilled: unknown,
      onrejected: unknown,
      epoch: SensitiveSchedulerEpoch | undefined,
      wrapHandlers: boolean,
    ): { readonly value: unknown; readonly usedDefaultThen: boolean } {
      const then = (receiver as { readonly then?: unknown }).then;
      registerPromiseMethodAuthority(receiver, "then", epoch);
      const usedDefaultThen = isDefaultPromiseThenFunction(then);
      const internalCall = usedDefaultThen
        ? {
          receiver,
          onfulfilled,
          onrejected,
          epoch,
          wrapHandlers,
          consumed: false,
        }
        : undefined;
      const operation = () => callFunction(then, receiver, [onfulfilled, onrejected]);
      const value = internalCall === undefined
        ? operation()
        : withInternalPromiseThenCall(internalCall, operation);
      return { value, usedDefaultThen };
    }

    function retainReturnedPromiseAssimilation(
      continuation: { readonly value: unknown; readonly usedDefaultThen: boolean },
      epoch: SensitiveSchedulerEpoch | undefined,
    ): void {
      if (!continuation.usedDefaultThen || !isObjectLike(continuation.value)) return;
      retainedInternalPromiseThenCalls.push({
        receiver: continuation.value,
        epoch,
        wrapHandlers: false,
        consumed: false,
      });
    }

    function isDefaultPromiseThenFunction(value: unknown): boolean {
      return value === instrumentedPromiseThen || value === registry.originalPromiseThen;
    }

    function callFunction(fn: unknown, thisArg: unknown, args: unknown[]): unknown {
      if (typeof fn !== "function") {
        throw nativeNonCallableThenError(fn);
      }
      return registry.originalReflectApply(fn as (...callArgs: unknown[]) => unknown, thisArg, args);
    }

    function promiseSpeciesConstructor(receiver: unknown): PromiseConstructor {
      if (!isObjectLike(receiver)) {
        throw nativeFinallyReceiverError(receiver);
      }
      const constructorValue = (receiver as { readonly constructor?: unknown }).constructor;
      if (constructorValue === undefined) return Promise;
      if (!isObjectLike(constructorValue)) {
        throw nativePromiseConstructorError(constructorValue);
      }
      const species = (constructorValue as { readonly [Symbol.species]?: unknown })[Symbol.species];
      if (species === undefined || species === null) return Promise;
      if (!isConstructor(species)) {
        throw nativePromiseSpeciesError(species);
      }
      return species as PromiseConstructor;
    }

    function nativeNonCallableThenError(then: unknown): unknown {
      try {
        registry.originalPromiseCatch.call({ then }, undefined);
      } catch (error) {
        return error;
      }
      return new TypeError("Promise method is not callable");
    }

    function nativeFinallyReceiverError(receiver: unknown): unknown {
      try {
        registry.originalPromiseFinally.call(receiver, undefined);
      } catch (error) {
        return error;
      }
      return new TypeError("Promise receiver is not an object");
    }

    function nativePromiseConstructorError(constructorValue: unknown): unknown {
      const probe = new Promise((resolve) => resolve(undefined));
      Object.defineProperty(probe, "constructor", {
        configurable: true,
        value: constructorValue,
      });
      try {
        registry.originalPromiseThen.call(probe, undefined, undefined);
      } catch (error) {
        return error;
      }
      return new TypeError("Promise constructor is not an object");
    }

    function nativePromiseSpeciesError(species: unknown): unknown {
      const probe = new Promise((resolve) => resolve(undefined));
      Object.defineProperty(probe, "constructor", {
        configurable: true,
        value: { [Symbol.species]: species },
      });
      try {
        registry.originalPromiseThen.call(probe, undefined, undefined);
      } catch (error) {
        return error;
      }
      return new TypeError("Promise species is not a constructor");
    }

    function promiseResolve(C: PromiseConstructor, value: unknown): unknown {
      if (isObjectLike(value) && value instanceof Promise && (value as { readonly constructor?: unknown }).constructor === C) {
        return value;
      }
      let resolveCapability: unknown;
      let rejectCapability: unknown;
      let executorCalled = false;
      const promise = new (C as unknown as new (executor: (resolve: unknown, reject: unknown) => void) => unknown)((resolve, reject) => {
        if (executorCalled) {
          throw new TypeError("Promise capability executor was already invoked");
        }
        executorCalled = true;
        resolveCapability = resolve;
        rejectCapability = reject;
      });
      if (typeof resolveCapability !== "function" || typeof rejectCapability !== "function") {
        throw new TypeError("Promise capability functions are not callable");
      }
      callFunction(resolveCapability, undefined, [value]);
      return promise;
    }

    function isConstructor(value: unknown): boolean {
      if (typeof value !== "function") return false;
      try {
        const constructorProbe = new Proxy(value as new () => object, {
          construct() {
            return {};
          },
        });
        new constructorProbe();
        return true;
      } catch {
        return false;
      }
    }

    function countSensitiveSchedulerRegistration(): SensitiveSchedulerEpoch | undefined {
      const state = sensitiveState();
      if (state === undefined) return undefined;
      const epoch = currentSensitiveEpoch(state);
      if (epoch === undefined) return undefined;
      state.schedulerSessionRegistrations = (state.schedulerSessionRegistrations ?? 0) + 1;
      epoch.schedulerRegistrations = (epoch.schedulerRegistrations ?? 0) + 1;
      if (
        epoch.schedulerRegistrations > input.maxSchedulerRegistrationsPerEpoch ||
        state.schedulerSessionRegistrations > input.maxSchedulerRegistrationsPerSession
      ) {
        poison(state, epoch);
        return undefined;
      }
      return epoch;
    }

    function wrapPromiseReactionHandlers<TResult1, TResult2>(
      onfulfilled: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null | undefined,
      onrejected: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null | undefined,
      epoch: SensitiveSchedulerEpoch,
    ): {
      readonly onfulfilled: typeof onfulfilled;
      readonly onrejected: typeof onrejected;
      readonly pending?: PendingSchedulerCallback;
    } {
      if (typeof onfulfilled !== "function" && typeof onrejected !== "function") {
        return { onfulfilled, onrejected };
      }
      const reaction = beginPendingSchedulerCallback(epoch, true, true);
      return {
        onfulfilled: wrapSchedulerCallbackWithPending(
          typeof onfulfilled === "function"
            ? onfulfilled
            : ((value: unknown) => value),
          epoch,
          reaction,
        ) as typeof onfulfilled,
        onrejected: wrapSchedulerCallbackWithPending(
          typeof onrejected === "function"
            ? onrejected
            : ((reason: unknown) => { throw reason; }),
          epoch,
          reaction,
        ) as typeof onrejected,
        pending: reaction,
      };
    }

    function wrapPromiseFinallyHandler<T extends (...args: any[]) => unknown>(
      callback: T,
      epoch: SensitiveSchedulerEpoch,
    ): { readonly callback: T; readonly pending: PendingSchedulerCallback } {
      const pending = beginPendingSchedulerCallback(epoch, true, true);
      return {
        callback: wrapSchedulerCallbackWithPending(callback, epoch, pending),
        pending,
      };
    }

    function wrapSchedulerCallback<T extends (...args: any[]) => unknown>(callback: T, epoch: SensitiveSchedulerEpoch, settles: boolean): T {
      return wrapSchedulerCallbackWithPending(callback, epoch, beginPendingSchedulerCallback(epoch, settles, false));
    }

    function beginPendingSchedulerCallback(epoch: SensitiveSchedulerEpoch, settles: boolean, retainObjectResult: boolean): PendingSchedulerCallback {
      epoch.pendingSchedulerCallbacks = (epoch.pendingSchedulerCallbacks ?? 0) + 1;
      return { settled: false, settles, retainObjectResult, retainedAfterReturn: false };
    }

    function wrapSchedulerCallbackWithPending<T extends (...args: any[]) => unknown>(
      callback: T,
      epoch: SensitiveSchedulerEpoch,
      pending: PendingSchedulerCallback,
    ): T {
      return function sensitiveSchedulerCallback(this: unknown): unknown {
        "use strict";
        const args = Array.prototype.slice.call(arguments) as any[];
        const previous = epoch.inSchedulerCallback === true;
        epoch.inSchedulerCallback = true;
        let callbackResult: unknown;
        let callbackCompleted = false;
        try {
          callbackResult = callback.apply(this, args);
          callbackCompleted = true;
          return callbackResult;
        } finally {
          epoch.inSchedulerCallback = previous;
          if (callbackCompleted && pending.retainObjectResult && isObjectLike(callbackResult)) {
            pending.retainedAfterReturn = true;
            epoch.retainedSchedulerCallbacks = (epoch.retainedSchedulerCallbacks ?? 0) + 1;
          }
          processSchedulerCallbackEpoch(epoch);
          queuePendingSchedulerSettle(epoch, pending);
        }
      } as T;
    }

    function queuePendingSchedulerSettle(epoch: SensitiveSchedulerEpoch, pending: PendingSchedulerCallback): void {
      const settle = () => {
        try {
          processSchedulerCallbackEpoch(epoch);
        } finally {
          settlePendingSchedulerCallback(epoch, pending);
        }
      };
      if (pending.retainedAfterReturn) {
        queueMicrotaskAfterPromiseAssimilation(settle);
        return;
      }
      registry.originalQueueMicrotask.call(window, settle);
    }

    function queueMicrotaskAfterPromiseAssimilation(callback: () => void): void {
      let remainingTurns = 8;
      const step = () => {
        remainingTurns -= 1;
        if (remainingTurns <= 0) {
          callback();
          return;
        }
        registry.originalQueueMicrotask.call(window, step);
      };
      registry.originalQueueMicrotask.call(window, step);
    }

    function settlePendingSchedulerCallback(epoch: SensitiveSchedulerEpoch | undefined, pending: PendingSchedulerCallback): void {
      if (epoch === undefined || !pending.settles || pending.settled) return;
      pending.settled = true;
      if (pending.retainedAfterReturn) {
        epoch.retainedSchedulerCallbacks = Math.max(0, (epoch.retainedSchedulerCallbacks ?? 0) - 1);
        pending.retainedAfterReturn = false;
      }
      epoch.pendingSchedulerCallbacks = Math.max(0, (epoch.pendingSchedulerCallbacks ?? 0) - 1);
    }

    function isObjectLike(value: unknown): value is object {
      return (typeof value === "object" && value !== null) || typeof value === "function";
    }

    function poisonUnwrappedSensitiveSchedulerCallback(epoch: SensitiveSchedulerEpoch | undefined, handler: TimerHandler): void {
      if (epoch === undefined || typeof handler === "function") return;
      const state = sensitiveState();
      if (state !== undefined) poison(state, epoch);
    }

    function currentSensitiveEpoch(state: SensitiveRuntimeState): SensitiveSchedulerEpoch | undefined {
      const active = state.active;
      return active !== undefined && active !== null
        ? active
        : state.retainedSchedulerEpochs?.find((candidate) =>
          candidate.inSchedulerCallback === true || (candidate.retainedSchedulerCallbacks ?? 0) > 0,
        );
    }

    function processSchedulerCallbackEpoch(epoch: SensitiveSchedulerEpoch): void {
      try {
        epoch.processSchedulerCallback?.();
      } catch {
        const state = sensitiveState();
        if (state !== undefined) poison(state, epoch);
      }
    }

    function poison(state: SensitiveRuntimeState, epoch: SensitiveSchedulerEpoch): void {
      state.poisoned = true;
      epoch.poisoned = true;
    }
  }, {
    shadowRootsProperty: SENSITIVE_SHADOW_ROOTS_PROPERTY,
    evidenceStateProperty: SENSITIVE_EVIDENCE_STATE_PROPERTY,
    maxShadowRoots: MAX_SENSITIVE_SHADOW_ROOTS,
    maxSchedulerRegistrationsPerEpoch: MAX_SENSITIVE_SCHEDULER_REGISTRATIONS_PER_EPOCH,
    maxSchedulerRegistrationsPerSession: MAX_SENSITIVE_SCHEDULER_REGISTRATIONS_PER_SESSION,
    maxPromiseOwners: MAX_SENSITIVE_PROMISE_OWNER_REGISTRY_OWNERS,
  });
}

export interface WebSessionOptions {
  readonly url: string;
  readonly expectedOrigin?: string;
  readonly headed: boolean;
  readonly navigationTimeoutMs: number;
  readonly actionTimeoutMs: number;
  readonly allowedOrigins: readonly string[];
  readonly allowedWebQueryKeys?: readonly string[];
}

/**
 * Test seam for injecting a fake browser in unit tests. Product code always
 * uses {@link chromiumLauncher}. This interface intentionally references the
 * Playwright `Browser` type; it is only reachable through the package's
 * internal (test-only) entry point, never through the public product surface.
 */
export interface BrowserLauncher {
  launch(options: { readonly headless: boolean }): Promise<Browser>;
}

export const chromiumLauncher: BrowserLauncher = {
  launch: (options) => chromium.launch({ headless: options.headless }),
};

export function normalizeOrigin(url: string): string {
  return new URL(url).origin;
}

export function isOriginAllowed(
  url: string,
  allowedOrigins: readonly string[],
): boolean {
  let origin: string;
  try {
    origin = normalizeOrigin(url);
  } catch {
    return false;
  }
  return allowedOrigins.includes(origin);
}

type SessionState = "new" | "starting" | "started" | "closing" | "closed";

export interface StoredObservation {
  readonly descriptors: ReadonlyMap<string, LocatorDescriptor>;
  readonly artifacts: readonly CapturedArtifact[];
}

interface RegisteredObservation extends StoredObservation {
  readonly navigationGeneration: number;
}

export class PlaywrightBrowserSession {
  private state: SessionState = "new";
  private startPromise?: Promise<void>;
  private browser: Browser | undefined;
  private context: BrowserContext | undefined;
  private page: Page | undefined;
  private operation: Promise<unknown> = Promise.resolve();
  private navigationGeneration = 0;
  private crossOriginNavigationCount = 0;
  private observationOrdinal = 0;
  private latestGraph: string | undefined;
  private readonly observations = new Map<string, RegisteredObservation>();
  private readonly observationGenerations = new Map<string, number>();
  private readonly resolvedActionGenerations = new WeakMap<object, number>();
  private readonly sensitiveEvidence = new SensitiveEvidenceAuthority();
  private sensitiveDispatchOrdinal = 0;
  private sensitiveEvidenceUnavailable = false;
  private activeSensitiveDispatch: PreparedSensitiveEvidenceRecord | undefined;
  private pendingSensitiveCapture = false;
  private readonly configuredTargetUrl: string;
  private readonly configuredExpectedOrigin: string;

  constructor(
    private readonly options: WebSessionOptions,
    private readonly launcher: BrowserLauncher = chromiumLauncher,
  ) {
    this.configuredTargetUrl = options.url;
    this.configuredExpectedOrigin = options.expectedOrigin ?? options.url;
  }

  get allowedOrigins(): readonly string[] {
    return this.options.allowedOrigins;
  }

  get allowedWebQueryKeys(): readonly string[] {
    return this.options.allowedWebQueryKeys ?? [];
  }

  get actionTimeoutMs(): number {
    return this.options.actionTimeoutMs;
  }

  get navigationTimeoutMs(): number {
    return this.options.navigationTimeoutMs;
  }

  get targetUrl(): string {
    return this.configuredTargetUrl;
  }

  get currentNavigationGeneration(): number {
    return this.navigationGeneration;
  }

  get currentCrossOriginNavigationCount(): number {
    return this.crossOriginNavigationCount;
  }

  isTargetOrigin(url: string): boolean {
    try {
      return normalizeOrigin(url) === normalizeOrigin(this.configuredExpectedOrigin);
    } catch {
      return false;
    }
  }

  assertPageTargetOrigin(
    page: Pick<Page, "url">,
    expectedNavigationGeneration?: number,
  ): string {
    let currentUrl: string;
    try {
      currentUrl = page.url();
    } catch {
      throw new WebTargetError(
        "OriginViolation",
        "The current page origin could not be verified.",
      );
    }
    if (!this.isTargetOrigin(currentUrl)) {
      throw new WebTargetError(
        "OriginViolation",
        "The current page left the configured target origin.",
      );
    }
    if (
      expectedNavigationGeneration !== undefined &&
      this.navigationGeneration !== expectedNavigationGeneration
    ) {
      throw new WebTargetError(
        "OriginViolation",
        "The page navigated while its target origin was being verified.",
      );
    }
    return currentUrl;
  }

  async readOnExpectedOrigin<T>(
    page: Pick<Page, "url">,
    expectedNavigationGeneration: number,
    read: () => Promise<T>,
  ): Promise<T> {
    this.assertPageTargetOrigin(page, expectedNavigationGeneration);
    let value: T;
    try {
      value = await read();
    } catch (error) {
      this.assertPageTargetOrigin(page, expectedNavigationGeneration);
      throw error;
    }
    this.assertPageTargetOrigin(page, expectedNavigationGeneration);
    return value;
  }

  get latestGraphId(): string | undefined {
    return this.latestGraph;
  }

  nextObservationOrdinal(): number {
    this.observationOrdinal += 1;
    return this.observationOrdinal;
  }

  registerObservation(
    graphId: string,
    observation: StoredObservation,
    navigationGeneration = this.navigationGeneration,
  ): void {
    this.assertNavigationGeneration(navigationGeneration);
    this.observations.set(graphId, { ...observation, navigationGeneration });
    this.observationGenerations.set(graphId, navigationGeneration);
    this.latestGraph = graphId;
  }

  registerCapturedObservation(
    page: Pick<Page, "url">,
    graphId: string,
    observation: StoredObservation,
    navigationGeneration: number,
  ): void {
    this.assertPageTargetOrigin(page, navigationGeneration);
    this.registerObservation(graphId, observation, navigationGeneration);
    try {
      this.assertPageTargetOrigin(page, navigationGeneration);
    } catch (error) {
      this.observations.delete(graphId);
      if (this.latestGraph === graphId) this.latestGraph = undefined;
      throw error;
    }
  }

  hasGraph(graphId: string): boolean {
    return this.latestGraph === graphId &&
      this.observations.get(graphId)?.navigationGeneration === this.navigationGeneration;
  }

  descriptorFor(graphId: string, nodeId: string): LocatorDescriptor | undefined {
    const observation = this.requireCurrentObservation(graphId);
    return observation.descriptors.get(nodeId);
  }

  requireCurrentObservationGeneration(graphId: string): number {
    return this.requireCurrentObservation(graphId).navigationGeneration;
  }

  assertObservationGeneration(graphId: string, navigationGeneration: number): void {
    this.assertNavigationGeneration(navigationGeneration);
    const observation = this.requireCurrentObservation(graphId);
    if (observation.navigationGeneration !== navigationGeneration) {
      throw new WebTargetError(
        "OriginViolation",
        "The observation belongs to a different navigation generation.",
      );
    }
  }

  async readForObservation<T>(
    page: Pick<Page, "url">,
    graphId: string,
    navigationGeneration: number,
    read: () => Promise<T>,
  ): Promise<T> {
    this.assertObservationGeneration(graphId, navigationGeneration);
    try {
      const value = await this.readOnExpectedOrigin(page, navigationGeneration, read);
      this.assertObservationGeneration(graphId, navigationGeneration);
      return value;
    } catch (error) {
      this.assertObservationGeneration(graphId, navigationGeneration);
      throw error;
    }
  }

  bindResolvedAction<T extends object>(action: T, navigationGeneration: number): T {
    this.assertNavigationGeneration(navigationGeneration);
    this.resolvedActionGenerations.set(action, navigationGeneration);
    return action;
  }

  requireResolvedActionGeneration(action: object): number {
    const navigationGeneration = this.resolvedActionGenerations.get(action);
    if (navigationGeneration === undefined) {
      throw new WebTargetError(
        "OriginViolation",
        "The resolved action has no navigation-generation authority.",
      );
    }
    this.assertNavigationGeneration(navigationGeneration);
    return navigationGeneration;
  }

  invalidateObservations(): void {
    this.observations.clear();
    this.latestGraph = undefined;
  }

  artifactsFor(graphId: string): readonly CapturedArtifact[] {
    const observation = this.observations.get(graphId);
    if (observation === undefined) {
      throw new WebTargetError(
        "StaleObservation",
        `No observation registered for graph ${graphId}.`,
      );
    }
    this.assertNavigationGeneration(observation.navigationGeneration);
    if (this.page !== undefined) {
      this.assertPageTargetOrigin(this.page, observation.navigationGeneration);
    }
    return observation.artifacts;
  }

  prepareSensitiveEvidenceRecord(input: {
    readonly navigationGeneration: number;
    readonly nodeId: string;
    readonly sourceValue: string;
  }): PreparedSensitiveEvidenceRecord {
    this.assertNavigationGeneration(input.navigationGeneration);
    const dispatchOrdinal = this.nextSensitiveDispatchOrdinal();
    const result = this.sensitiveEvidence.prepare({
      navigationGeneration: input.navigationGeneration,
      dispatchOrdinal,
      nodeId: input.nodeId,
      sourceValue: input.sourceValue,
    });
    if (result.status === "failed" || result.value === undefined) {
      throw sensitiveEvidenceUnavailable();
    }
    return result.value;
  }

  beginSensitiveEvidenceDispatch(prepared: PreparedSensitiveEvidenceRecord): void {
    this.assertNavigationGeneration(prepared.navigationGeneration);
    this.assertSensitiveEvidenceAvailable();
    if (this.activeSensitiveDispatch !== undefined || this.pendingSensitiveCapture) {
      this.markSensitiveEvidenceUnavailable();
      throw sensitiveEvidenceUnavailable();
    }
    this.activeSensitiveDispatch = prepared;
  }

  cancelSensitiveEvidenceDispatch(prepared: PreparedSensitiveEvidenceRecord): void {
    if (this.activeSensitiveDispatch?.markerId === prepared.markerId) {
      this.activeSensitiveDispatch = undefined;
    }
  }

  abandonSensitiveEvidenceDispatch(prepared: PreparedSensitiveEvidenceRecord): void {
    this.cancelSensitiveEvidenceDispatch(prepared);
    this.markSensitiveEvidenceUnavailable();
  }

  completeSensitiveEvidenceRecord(
    prepared: PreparedSensitiveEvidenceRecord,
    observedForms: readonly string[],
  ): void {
    this.assertNavigationGeneration(prepared.navigationGeneration);
    const result = this.sensitiveEvidence.complete(prepared, observedForms);
    this.cancelSensitiveEvidenceDispatch(prepared);
    if (result.status === "failed") {
      this.markSensitiveEvidenceUnavailable();
      return;
    }
    this.pendingSensitiveCapture = true;
  }

  markSensitiveEvidenceUnavailable(): void {
    this.activeSensitiveDispatch = undefined;
    this.pendingSensitiveCapture = false;
    this.sensitiveEvidenceUnavailable = true;
  }

  assertSensitiveEvidenceAvailable(): void {
    if (this.sensitiveEvidenceUnavailable || this.activeSensitiveDispatch !== undefined) {
      throw sensitiveEvidenceUnavailable();
    }
  }

  async revalidateSensitivePromiseOwners(page: Page, navigationGeneration: number): Promise<void> {
    this.assertNavigationGeneration(navigationGeneration);
    this.assertPageTargetOrigin(page, navigationGeneration);
    this.assertSensitiveEvidenceAvailable();
    let result: { readonly status: "ok" | "failed"; readonly reason?: string };
    try {
      result = await page.evaluate(validateSensitivePromiseOwnerRegistryInPage, {
        runtimeRegistryProperty: SENSITIVE_SHADOW_ROOTS_PROPERTY,
        maxPromiseOwners: MAX_SENSITIVE_PROMISE_OWNER_REGISTRY_OWNERS,
      });
    } catch {
      this.markSensitiveEvidenceUnavailable();
      throw sensitiveEvidenceUnavailable();
    }
    this.assertNavigationGeneration(navigationGeneration);
    this.assertPageTargetOrigin(page, navigationGeneration);
    if (result.status !== "ok") {
      this.markSensitiveEvidenceUnavailable();
      throw sensitiveEvidenceUnavailable();
    }
    this.assertSensitiveEvidenceAvailable();
  }

  hasPendingSensitiveEvidenceCapture(): boolean {
    return this.pendingSensitiveCapture;
  }

  completeSensitiveEvidenceCapture(): void {
    this.assertSensitiveEvidenceAvailable();
    this.pendingSensitiveCapture = false;
  }

  redactSensitiveTargetField(
    sensitiveTargetIds: readonly string[] | undefined,
    value: string,
  ): string {
    this.assertSensitiveEvidenceAvailable();
    return this.sensitiveEvidence.redactField(sensitiveTargetIds, value);
  }

  redactSensitiveTitleField(
    sensitiveTargetIds: readonly string[] | undefined,
    value: string,
  ): string {
    this.assertSensitiveEvidenceAvailable();
    const result = this.sensitiveEvidence.redactFieldWithStatus(sensitiveTargetIds, value);
    if (result.status === "unavailable") {
      this.markSensitiveEvidenceUnavailable();
      throw sensitiveEvidenceUnavailable();
    }
    return result.value;
  }

  async start(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.state === "started") {
      return;
    }
    if (this.state === "closed" || this.state === "closing") {
      throw new WebTargetError("SessionClosed", "Session is closed.");
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    this.state = "starting";
    this.startPromise = this.doStart(signal);
    return this.startPromise;
  }

  private async doStart(signal?: AbortSignal): Promise<void> {
    this.validateTarget();
    signal?.throwIfAborted();

    let browser: Browser;
    try {
      browser = await this.launcher.launch({ headless: !this.options.headed });
      this.browser = browser;
      signal?.throwIfAborted();
    } catch (error) {
      await this.disposeResources();
      this.state = "closed";
      if (signal?.aborted) throw signal.reason;
      throw new WebTargetError(
        "BrowserLaunchFailed",
        error instanceof Error ? error.message : String(error),
      );
    }

    const startupCrossOriginNavigationCount = this.crossOriginNavigationCount;
    try {
      const context = await browser.newContext();
      this.context = context;
      signal?.throwIfAborted();
      context.setDefaultTimeout(this.options.actionTimeoutMs);
      context.setDefaultNavigationTimeout(this.options.navigationTimeoutMs);

      const page = await context.newPage();
      await installSensitiveEvidenceRuntime(page);
      this.page = page;
      page.on("framenavigated", (frame) => {
        if (frame !== page.mainFrame()) return;
        this.invalidateObservations();
        this.navigationGeneration += 1;
        try {
          if (!this.isTargetOrigin(frame.url())) this.crossOriginNavigationCount += 1;
        } catch {
          this.crossOriginNavigationCount += 1;
        }
      });
      signal?.throwIfAborted();

      await page.goto(this.configuredTargetUrl, {
        waitUntil: "domcontentloaded",
        timeout: this.options.navigationTimeoutMs,
      });
      this.assertPageTargetOrigin(page);
      if (this.crossOriginNavigationCount !== startupCrossOriginNavigationCount) {
        throw new WebTargetError(
          "OriginViolation",
          "Initial navigation left the configured target origin.",
        );
      }
      signal?.throwIfAborted();
    } catch (error) {
      await this.disposeResources();
      this.state = "closed";
      if (signal?.aborted) throw signal.reason;
      if (this.crossOriginNavigationCount !== startupCrossOriginNavigationCount) {
        throw new WebTargetError(
          "OriginViolation",
          "Initial navigation left the configured target origin.",
        );
      }
      throw this.toNavigationError(error);
    }

    this.state = "started";
  }

  private validateTarget(): void {
    let parsed: URL;
    try {
      parsed = new URL(this.configuredTargetUrl);
    } catch {
      throw new WebTargetError(
        "NavigationFailed",
        `Invalid target URL: ${this.configuredTargetUrl}`,
      );
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new WebTargetError(
        "NavigationFailed",
        `Unsupported scheme: ${parsed.protocol}`,
      );
    }

    if (parsed.username !== "" || parsed.password !== "") {
      throw new WebTargetError(
        "NavigationFailed",
        "Target URL must not embed credentials.",
      );
    }

    let expectedOrigin: string;
    try {
      expectedOrigin = normalizeOrigin(this.configuredExpectedOrigin);
    } catch {
      throw new WebTargetError(
        "OriginViolation",
        "The configured Job target origin is invalid.",
      );
    }
    if (parsed.origin !== expectedOrigin) {
      throw new WebTargetError(
        "OriginViolation",
        "The navigation target does not match the configured Job target origin.",
      );
    }

    if (!this.options.allowedOrigins.includes(expectedOrigin)) {
      throw new WebTargetError(
        "OriginViolation",
        `Target origin ${parsed.origin} is not in the allowlist.`,
      );
    }
  }

  private nextSensitiveDispatchOrdinal(): number {
    this.sensitiveDispatchOrdinal += 1;
    return this.sensitiveDispatchOrdinal;
  }

  private assertNavigationGeneration(expectedNavigationGeneration: number): void {
    if (this.navigationGeneration !== expectedNavigationGeneration) {
      throw new WebTargetError(
        "OriginViolation",
        "The page navigation generation no longer matches the captured authority.",
      );
    }
  }

  private requireCurrentObservation(graphId: string): RegisteredObservation {
    const registeredGeneration = this.observationGenerations.get(graphId);
    if (
      registeredGeneration !== undefined &&
      registeredGeneration !== this.navigationGeneration
    ) {
      throw new WebTargetError(
        "OriginViolation",
        "The observation belongs to a prior navigation generation.",
      );
    }
    const observation = this.observations.get(graphId);
    if (this.latestGraph !== graphId || observation === undefined) {
      throw new WebTargetError(
        "StaleObservation",
        `No current observation is registered for graph ${graphId}.`,
      );
    }
    this.assertNavigationGeneration(observation.navigationGeneration);
    return observation;
  }

  private toNavigationError(error: unknown): WebTargetError {
    if (error instanceof WebTargetError) {
      return error;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (/timeout/i.test(message)) {
      return new WebTargetError("NavigationTimedOut", message);
    }
    return new WebTargetError("NavigationFailed", message);
  }

  /**
   * Serialized access to the live Playwright page. The page never escapes this
   * closure, keeping Playwright objects inside the adapter.
   */
  async withPage<T>(operation: (page: Page) => Promise<T>): Promise<T> {
    const run = this.operation.then(async () => {
      if (this.state !== "started" || !this.page) {
        throw new WebTargetError(
          "SessionClosed",
          "Session is not started or already closed.",
        );
      }
      return operation(this.page);
    });

    this.operation = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async close(): Promise<void> {
    if (this.state === "closed") {
      return;
    }
    if (this.state === "starting" && this.startPromise) {
      const startup = this.startPromise;
      this.state = "closing";
      const firstError = await this.disposeResources();
      void startup.finally(async () => {
        await this.disposeResources();
        this.state = "closed";
      }).catch(() => undefined);
      if (firstError) throw firstError;
      return;
    }

    this.state = "closing";
    const firstError = await this.disposeResources();
    this.state = "closed";

    if (firstError) {
      throw firstError;
    }
  }

  private async disposeResources(): Promise<Error | undefined> {
    let firstError: Error | undefined;
    const record = (error: unknown): void => {
      if (!firstError) {
        firstError = error instanceof Error ? error : new Error(String(error));
      }
    };

    const page = this.page;
    this.page = undefined;
    if (page) {
      await page.close().catch(record);
    }
    const context = this.context;
    this.context = undefined;
    if (context) {
      await context.close().catch(record);
    }
    this.sensitiveEvidence.clear();
    this.sensitiveEvidenceUnavailable = false;
    this.activeSensitiveDispatch = undefined;
    this.pendingSensitiveCapture = false;

    const browser = this.browser;
    this.browser = undefined;
    if (browser) {
      await browser.close().catch(record);
    }
    return firstError;
  }
}

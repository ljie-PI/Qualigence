import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { ExecutionTargetError, type ExecutionTargetErrorStatus } from "@qualigence/runner-kernel";
import type { CapturedArtifact, LocatorDescriptor } from "./types.js";
import {
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

async function installSensitiveEvidenceRuntime(page: Page): Promise<void> {
  if (typeof page.addInitScript !== "function") return;
  await page.addInitScript((input: {
    readonly shadowRootsProperty: string;
    readonly evidenceStateProperty: string;
    readonly maxShadowRoots: number;
    readonly maxSchedulerRegistrationsPerEpoch: number;
    readonly maxSchedulerRegistrationsPerSession: number;
  }) => {
    type SensitiveRuntimeRegistry = {
      readonly roots: ShadowRoot[];
      readonly listenerTargets: { readonly type: string; readonly target: EventTarget; readonly listener: EventListenerOrEventListenerObject }[];
      shadowRootOverflow: boolean;
      readonly originalAttachShadow: typeof Element.prototype.attachShadow;
      readonly originalAddEventListener: typeof EventTarget.prototype.addEventListener;
      readonly originalSetTimeout: typeof window.setTimeout;
      readonly originalSetInterval: typeof window.setInterval;
      readonly originalRequestAnimationFrame: typeof window.requestAnimationFrame;
      readonly originalQueueMicrotask: typeof window.queueMicrotask;
      readonly originalPromiseThen: typeof Promise.prototype.then;
      readonly originalPromiseCatch: typeof Promise.prototype.catch;
      readonly originalPromiseFinally: typeof Promise.prototype.finally;
    };
    type SensitiveSchedulerEpoch = {
      schedulerRegistrations?: number;
      inSchedulerCallback?: boolean;
      poisoned?: boolean;
      processSchedulerCallback?: () => void;
    };
    type SensitiveRuntimeState = {
      active?: SensitiveSchedulerEpoch | null;
      poisoned?: boolean;
      schedulerSessionRegistrations?: number;
    };
    const win = window as unknown as Record<string, SensitiveRuntimeRegistry | undefined>;
    if (win[input.shadowRootsProperty] !== undefined) return;
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
    };
    Object.defineProperty(win, input.shadowRootsProperty, {
      configurable: false,
      enumerable: false,
      value: registry,
      writable: false,
    });
    Element.prototype.attachShadow = function attachShadow(init: ShadowRootInit): ShadowRoot {
      const root = registry.originalAttachShadow.call(this, init);
      const state = sensitiveState();
      const active = state?.active;
      if (init.mode === "closed" && state !== undefined && active !== undefined && active !== null) {
        poison(state, active);
      }
      if (!registry.roots.includes(root)) {
        if (registry.roots.length >= input.maxShadowRoots) {
          registry.shadowRootOverflow = true;
          if (state !== undefined && active !== undefined && active !== null) {
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
      return (registry.originalSetTimeout as any).apply(window, [
        typeof handler === "function" && epoch !== undefined ? wrapSchedulerCallback(handler as (...callbackArgs: unknown[]) => unknown, epoch) : handler,
        timeout,
        ...args,
      ]) as number;
    } as typeof window.setTimeout;
    window.setInterval = function setInterval(handler: TimerHandler, timeout?: number, ...args: unknown[]): number {
      const epoch = countSensitiveSchedulerRegistration();
      return (registry.originalSetInterval as any).apply(window, [
        typeof handler === "function" && epoch !== undefined ? wrapSchedulerCallback(handler as (...callbackArgs: unknown[]) => unknown, epoch) : handler,
        timeout,
        ...args,
      ]) as number;
    } as typeof window.setInterval;
    window.requestAnimationFrame = function requestAnimationFrame(callback: FrameRequestCallback): number {
      const epoch = countSensitiveSchedulerRegistration();
      return registry.originalRequestAnimationFrame.call(
        window,
        epoch === undefined ? callback : wrapSchedulerCallback(callback, epoch),
      );
    };
    window.queueMicrotask = function queueMicrotask(callback: VoidFunction): void {
      const epoch = countSensitiveSchedulerRegistration();
      registry.originalQueueMicrotask.call(
        window,
        epoch === undefined ? callback : wrapSchedulerCallback(callback, epoch),
      );
    };
    Promise.prototype.then = function then<TResult1 = unknown, TResult2 = never>(
      onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
      const fulfilledEpoch = typeof onfulfilled === "function" ? countSensitiveSchedulerRegistration() : undefined;
      const rejectedEpoch = typeof onrejected === "function" ? countSensitiveSchedulerRegistration() : undefined;
      return registry.originalPromiseThen.call(
        this,
        fulfilledEpoch === undefined || typeof onfulfilled !== "function" ? onfulfilled : wrapSchedulerCallback(onfulfilled, fulfilledEpoch),
        rejectedEpoch === undefined || typeof onrejected !== "function" ? onrejected : wrapSchedulerCallback(onrejected, rejectedEpoch),
      ) as Promise<TResult1 | TResult2>;
    };
    Promise.prototype.catch = function promiseCatch<TResult = never>(
      onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
    ): Promise<unknown | TResult> {
      const epoch = typeof onrejected === "function" ? countSensitiveSchedulerRegistration() : undefined;
      return registry.originalPromiseCatch.call(
        this,
        epoch === undefined || typeof onrejected !== "function" ? onrejected : wrapSchedulerCallback(onrejected, epoch),
      ) as Promise<unknown | TResult>;
    };
    Promise.prototype.finally = function promiseFinally(onfinally?: (() => void) | null): Promise<unknown> {
      const epoch = typeof onfinally === "function" ? countSensitiveSchedulerRegistration() : undefined;
      return registry.originalPromiseFinally.call(
        this,
        epoch === undefined || typeof onfinally !== "function" ? onfinally : wrapSchedulerCallback(onfinally, epoch),
      ) as Promise<unknown>;
    };

    function sensitiveState(): SensitiveRuntimeState | undefined {
      return (window as unknown as Record<string, SensitiveRuntimeState | undefined>)[input.evidenceStateProperty];
    }

    function countSensitiveSchedulerRegistration(): SensitiveSchedulerEpoch | undefined {
      const state = sensitiveState();
      const epoch = state?.active;
      if (state === undefined || epoch === undefined || epoch === null) return undefined;
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

    function wrapSchedulerCallback<T extends (...args: any[]) => unknown>(callback: T, epoch: SensitiveSchedulerEpoch): T {
      return function sensitiveSchedulerCallback(this: unknown, ...args: any[]): unknown {
        const previous = epoch.inSchedulerCallback === true;
        epoch.inSchedulerCallback = true;
        try {
          return callback.apply(this, args);
        } finally {
          processSchedulerCallbackEpoch(epoch);
          registry.originalQueueMicrotask.call(window, () => {
            try {
              processSchedulerCallbackEpoch(epoch);
            } finally {
              epoch.inSchedulerCallback = previous;
            }
          });
        }
      } as T;
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

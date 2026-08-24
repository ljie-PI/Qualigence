import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { ExecutionTargetError, type ExecutionTargetErrorStatus } from "@qualigence/runner-kernel";
import type { CapturedArtifact, LocatorDescriptor } from "./types.js";
import {
  SensitiveEvidenceAuthority,
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

export interface WebSessionOptions {
  readonly url: string;
  readonly expectedOrigin?: string;
  readonly headed: boolean;
  readonly navigationTimeoutMs: number;
  readonly actionTimeoutMs: number;
  readonly allowedOrigins: readonly string[];
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

  completeSensitiveEvidenceRecord(
    prepared: PreparedSensitiveEvidenceRecord,
    observedForms: readonly string[],
  ): void {
    this.assertNavigationGeneration(prepared.navigationGeneration);
    const result = this.sensitiveEvidence.complete(prepared, observedForms);
    if (result.status === "failed") {
      this.markSensitiveEvidenceUnavailable();
    }
  }

  markSensitiveEvidenceUnavailable(): void {
    this.sensitiveEvidenceUnavailable = true;
  }

  assertSensitiveEvidenceAvailable(): void {
    if (this.sensitiveEvidenceUnavailable) {
      throw sensitiveEvidenceUnavailable();
    }
  }

  redactSensitiveTargetField(
    sensitiveTargetIds: readonly string[] | undefined,
    value: string,
  ): string {
    this.assertSensitiveEvidenceAvailable();
    return this.sensitiveEvidence.redactField(sensitiveTargetIds, value);
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

    const browser = this.browser;
    this.browser = undefined;
    if (browser) {
      await browser.close().catch(record);
    }
    return firstError;
  }
}

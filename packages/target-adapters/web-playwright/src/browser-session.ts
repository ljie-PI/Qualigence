import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { ExecutionTargetError, type ExecutionTargetErrorStatus } from "@qualigence/runner-kernel";
import type { CapturedArtifact, LocatorDescriptor } from "./types.js";

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

export interface WebSessionOptions {
  readonly url: string;
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

export class PlaywrightBrowserSession {
  private state: SessionState = "new";
  private startPromise?: Promise<void>;
  private browser: Browser | undefined;
  private context: BrowserContext | undefined;
  private page: Page | undefined;
  private operation: Promise<unknown> = Promise.resolve();
  private observationOrdinal = 0;
  private latestGraph: string | undefined;
  private readonly observations = new Map<string, StoredObservation>();
  private readonly sensitiveValues = new Set<string>();

  constructor(
    private readonly options: WebSessionOptions,
    private readonly launcher: BrowserLauncher = chromiumLauncher,
  ) {}

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
    return this.options.url;
  }

  isTargetOrigin(url: string): boolean {
    try {
      return normalizeOrigin(url) === normalizeOrigin(this.options.url);
    } catch {
      return false;
    }
  }

  get latestGraphId(): string | undefined {
    return this.latestGraph;
  }

  nextObservationOrdinal(): number {
    this.observationOrdinal += 1;
    return this.observationOrdinal;
  }

  registerObservation(graphId: string, observation: StoredObservation): void {
    this.observations.set(graphId, observation);
    this.latestGraph = graphId;
  }

  hasGraph(graphId: string): boolean {
    return this.latestGraph === graphId && this.observations.has(graphId);
  }

  descriptorFor(graphId: string, nodeId: string): LocatorDescriptor | undefined {
    if (this.latestGraph !== graphId) return undefined;
    return this.observations.get(graphId)?.descriptors.get(nodeId);
  }

  invalidateObservations(): void {
    this.observations.clear();
    this.latestGraph = undefined;
  }

  artifactsFor(graphId: string): readonly CapturedArtifact[] {
    const observation = this.observations.get(graphId);
    if (!observation) {
      throw new WebTargetError(
        "StaleObservation",
        `No observation registered for graph ${graphId}.`,
      );
    }
    return observation.artifacts;
  }

  registerSensitiveValue(value: string): void {
    if (value !== "") this.sensitiveValues.add(value);
  }

  redactSensitiveText(value: string): string {
    let redacted = value;
    for (const sensitive of [...this.sensitiveValues].sort((left, right) => right.length - left.length)) {
      redacted = redacted.replaceAll(sensitive, "[redacted]");
    }
    return redacted;
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

    try {
      const context = await browser.newContext();
      this.context = context;
      signal?.throwIfAborted();
      context.setDefaultTimeout(this.options.actionTimeoutMs);
      context.setDefaultNavigationTimeout(this.options.navigationTimeoutMs);

      const page = await context.newPage();
      this.page = page;
      signal?.throwIfAborted();

      await page.goto(this.options.url, {
        waitUntil: "domcontentloaded",
        timeout: this.options.navigationTimeoutMs,
      });
      signal?.throwIfAborted();
    } catch (error) {
      await this.disposeResources();
      this.state = "closed";
      if (signal?.aborted) throw signal.reason;
      throw this.toNavigationError(error);
    }

    this.state = "started";
  }

  private validateTarget(): void {
    let parsed: URL;
    try {
      parsed = new URL(this.options.url);
    } catch {
      throw new WebTargetError(
        "NavigationFailed",
        `Invalid target URL: ${this.options.url}`,
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

    if (!this.options.allowedOrigins.includes(parsed.origin)) {
      throw new WebTargetError(
        "OriginViolation",
        `Target origin ${parsed.origin} is not in the allowlist.`,
      );
    }
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
    const browser = this.browser;
    this.browser = undefined;
    if (browser) {
      await browser.close().catch(record);
    }
    return firstError;
  }
}

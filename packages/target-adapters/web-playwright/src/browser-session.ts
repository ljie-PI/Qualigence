import {
  chromium,
  type Browser,
  type BrowserContext,
  type ElementHandle,
  type Locator,
  type Page,
} from "playwright";
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
  | "SensitiveTargetUnproven"
  | "UnsupportedAction"
  | "ConcurrentSessionOperation"
  | "SessionClosed";

export class WebTargetError extends Error {
  constructor(
    readonly code: WebTargetErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "WebTargetError";
  }
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

export interface PrivateActionTarget {
  readonly token: string;
  readonly handle: ElementHandle<Element>;
}

export interface SensitiveActionTarget extends PrivateActionTarget {
  readonly nodeId: string;
}

export const PRIVATE_TARGET_ATTRIBUTE = "data-qualigence-private-target";
export const MAXIMUM_SENSITIVE_ACTION_TARGETS = 32;

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
  private readonly sensitiveActionTargets = new Map<string, SensitiveActionTarget>();
  private readonly privateActionTargets = new Map<string, PrivateActionTarget>();
  private privateTargetOrdinal = 0;

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
    return this.observations.has(graphId);
  }

  descriptorFor(graphId: string, nodeId: string): LocatorDescriptor | undefined {
    return this.observations.get(graphId)?.descriptors.get(nodeId);
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

  async establishPrivateActionTarget(
    graphId: string,
    nodeId: string,
    locator: Locator,
  ): Promise<void> {
    const handle = await locator.elementHandle();
    if (handle === null) {
      throw new WebTargetError("TargetNotFound", "The resolved target has no stable DOM identity.");
    }
    this.privateTargetOrdinal += 1;
    const token = `target-${this.privateTargetOrdinal}`;
    await handle.evaluate((element, identity) => {
      element.setAttribute(identity.attribute, identity.token);
    }, { attribute: PRIVATE_TARGET_ATTRIBUTE, token });
    this.privateActionTargets.set(`${graphId}\0${nodeId}`, { token, handle });
  }

  privateActionTargetFor(graphId: string, nodeId: string): PrivateActionTarget | undefined {
    return this.privateActionTargets.get(`${graphId}\0${nodeId}`);
  }

  registerSensitiveActionTarget(graphId: string, nodeId: string): void {
    const target = this.privateActionTargetFor(graphId, nodeId);
    if (target === undefined) {
      throw new WebTargetError(
        "SensitiveTargetUnproven",
        "The sensitive action target has no resolution-bound identity.",
      );
    }
    if (
      !this.sensitiveActionTargets.has(target.token) &&
      this.sensitiveActionTargets.size >= MAXIMUM_SENSITIVE_ACTION_TARGETS
    ) {
      throw new WebTargetError(
        "SensitiveTargetUnproven",
        "The sensitive action target limit was exceeded.",
      );
    }
    this.sensitiveActionTargets.set(target.token, { ...target, nodeId });
  }

  sensitiveTargets(): readonly SensitiveActionTarget[] {
    return [...this.sensitiveActionTargets.values()];
  }

  advanceSensitiveTargets(graphId: string, nodeIds: readonly string[]): void {
    const targets = this.sensitiveTargets();
    if (targets.length !== nodeIds.length) {
      throw new WebTargetError(
        "SensitiveTargetUnproven",
        "The sensitive target observation mapping is incomplete.",
      );
    }
    for (const [index, target] of targets.entries()) {
      const advanced = { ...target, nodeId: nodeIds[index]! };
      this.sensitiveActionTargets.set(target.token, advanced);
      this.privateActionTargets.set(
        `${graphId}\0${advanced.nodeId}`,
        advanced,
      );
    }
  }

  redactSensitiveText(value: string): string {
    let redacted = value;
    for (const sensitive of [...this.sensitiveValues].sort((left, right) => right.length - left.length)) {
      redacted = redacted.replaceAll(sensitive, "[REDACTED]");
    }
    return redacted;
  }

  async start(): Promise<void> {
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
    this.startPromise = this.doStart();
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    this.validateTarget();

    let browser: Browser;
    try {
      browser = await this.launcher.launch({ headless: !this.options.headed });
    } catch (error) {
      this.state = "closed";
      throw new WebTargetError(
        "BrowserLaunchFailed",
        error instanceof Error ? error.message : String(error),
      );
    }

    this.browser = browser;
    try {
      const context = await browser.newContext();
      context.setDefaultTimeout(this.options.actionTimeoutMs);
      context.setDefaultNavigationTimeout(this.options.navigationTimeoutMs);
      this.context = context;

      const page = await context.newPage();
      this.page = page;

      await page.goto(this.options.url, {
        waitUntil: "domcontentloaded",
        timeout: this.options.navigationTimeoutMs,
      });
    } catch (error) {
      await this.disposeResources();
      this.state = "closed";
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
      await this.startPromise.catch(() => undefined);
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

    if (this.page) {
      await this.page.close().catch(record);
      this.page = undefined;
    }
    if (this.context) {
      await this.context.close().catch(record);
      this.context = undefined;
    }
    if (this.browser) {
      await this.browser.close().catch(record);
      this.browser = undefined;
    }
    this.sensitiveValues.clear();
    this.sensitiveActionTargets.clear();
    const targets = new Map(
      [...this.privateActionTargets.values()].map((target) => [target.token, target]),
    );
    for (const target of targets.values()) {
      await target.handle.evaluate((element, attribute) => {
        element.removeAttribute(attribute);
      }, PRIVATE_TARGET_ATTRIBUTE).catch(() => undefined);
      await target.handle.dispose().catch(() => undefined);
    }
    this.privateActionTargets.clear();
    return firstError;
  }
}

import {
  chromium,
  type Browser,
  type BrowserContext,
  type ElementHandle,
  type JSHandle,
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
  | "SensitiveEvidenceUnproven"
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
  readonly locator: Locator;
  readonly handle: ElementHandle<Element>;
  markerInstalled: boolean;
}

export interface SensitiveActionTarget extends PrivateActionTarget {
  readonly nodeId: string | undefined;
}

export const PRIVATE_TARGET_ATTRIBUTE = "data-qualigence-private-target";
export const MAXIMUM_SENSITIVE_ACTION_TARGETS = 32;
const MAXIMUM_SENSITIVE_ACTION_MUTATIONS = 128;
const MAXIMUM_SENSITIVE_ACTION_CANDIDATES = 512;
const MAXIMUM_SENSITIVE_ACTION_SETTLE_MS = 250;
const SENSITIVE_ACTION_CANDIDATE_SELECTOR =
  "button, a[href], input, textarea, select, [role], [data-qualigence-observe]";
const SENSITIVE_ACTION_ATTRIBUTES = [
  "aria-label",
  "aria-labelledby",
  "placeholder",
  "title",
  "alt",
  "value",
] as const;

interface SensitiveActionPropertySnapshot {
  readonly inputValue: string | null;
  readonly selectValue: string | null;
  readonly selectedOptionText: string | null;
  readonly textContent: string | null;
  readonly attributes: readonly (string | null)[];
}

interface SensitiveActionCandidateSnapshot {
  readonly element: Element;
  readonly properties: SensitiveActionPropertySnapshot;
}

interface SensitiveActionMutationTracker {
  readonly target: Element;
  readonly candidates: readonly SensitiveActionCandidateSnapshot[];
  readonly records: MutationRecord[];
  readonly observer: MutationObserver;
  overflow: boolean;
  observerError: boolean;
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
  private readonly sensitiveActionTargets = new Map<string, SensitiveActionTarget>();
  private readonly privateActionTargets = new Map<string, PrivateActionTarget>();
  private privateTargetOrdinal = 0;
  private sensitiveEvidenceUnproven = false;

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
    this.assertSensitiveEvidenceProven();
    const observation = this.observations.get(graphId);
    if (!observation) {
      throw new WebTargetError(
        "StaleObservation",
        `No observation registered for graph ${graphId}.`,
      );
    }
    return observation.artifacts;
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
    this.privateActionTargets.set(`${graphId}\0${nodeId}`, {
      token,
      locator,
      handle,
      markerInstalled: false,
    });
  }

  privateActionTargetFor(graphId: string, nodeId: string): PrivateActionTarget | undefined {
    return this.privateActionTargets.get(`${graphId}\0${nodeId}`);
  }

  async registerSensitiveActionTarget(graphId: string, nodeId: string): Promise<void> {
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
    if (!target.markerInstalled) {
      const locatedHandle = await target.locator.elementHandle();
      const exactTarget = locatedHandle !== null && await target.handle.evaluate(
        (element, located) => element === located,
        locatedHandle,
      );
      if (locatedHandle !== null && locatedHandle !== target.handle) {
        await locatedHandle.dispose();
      }
      if (!exactTarget) {
        throw new WebTargetError(
          "SensitiveTargetUnproven",
          "The sensitive action target no longer has its resolution-bound identity.",
        );
      }
      const registered = { ...target, nodeId };
      this.sensitiveActionTargets.set(target.token, registered);
      try {
        target.markerInstalled = true;
        registered.markerInstalled = true;
        const markerInstalled = await target.handle.evaluate((element, identity) => {
          element.setAttribute(identity.attribute, identity.token);
          return element.getAttribute(identity.attribute) === identity.token;
        }, { attribute: PRIVATE_TARGET_ATTRIBUTE, token: target.token });
        if (!markerInstalled) {
          throw new WebTargetError(
            "SensitiveTargetUnproven",
            "The sensitive action target could not install its private marker.",
          );
        }
      } catch (error) {
        this.sensitiveActionTargets.delete(target.token);
        await target.handle.evaluate((element, identity) => {
          if (element.getAttribute(identity.attribute) === identity.token) {
            element.removeAttribute(identity.attribute);
          }
        }, { attribute: PRIVATE_TARGET_ATTRIBUTE, token: target.token }).catch(() => undefined);
        target.markerInstalled = false;
        registered.markerInstalled = false;
        throw error;
      }
    } else if (!(await target.handle.evaluate((element, identity) =>
      element.getAttribute(identity.attribute) === identity.token,
    { attribute: PRIVATE_TARGET_ATTRIBUTE, token: target.token }))) {
      throw new WebTargetError(
        "SensitiveTargetUnproven",
        "The sensitive action target lost its private marker.",
      );
    }
    const registered = { ...target, nodeId, markerInstalled: true };
    this.privateActionTargets.set(`${graphId}\0${nodeId}`, registered);
    this.sensitiveActionTargets.set(target.token, registered);
  }

  sensitiveTargets(): readonly SensitiveActionTarget[] {
    this.assertSensitiveEvidenceProven();
    return [...this.sensitiveActionTargets.values()];
  }

  sensitiveEvidenceFailure(message: string): WebTargetError {
    this.sensitiveEvidenceUnproven = true;
    return new WebTargetError("SensitiveEvidenceUnproven", message);
  }

  hasSensitiveAction(): boolean {
    return this.sensitiveActionTargets.size > 0;
  }

  private assertSensitiveEvidenceProven(): void {
    if (this.sensitiveEvidenceUnproven) {
      throw new WebTargetError(
        "SensitiveEvidenceUnproven",
        "Sensitive evidence cannot be proven for this session.",
      );
    }
  }

  async beginSensitiveActionTracking(
    target: ElementHandle<Element>,
  ): Promise<JSHandle<SensitiveActionMutationTracker>> {
    try {
      return await target.evaluateHandle((element, limits) => {
        if (!element.isConnected) {
          throw new Error("target-disconnected");
        }
        const elements = Array.from(
          element.ownerDocument.querySelectorAll(limits.candidateSelector),
        );
        if (elements.length > limits.maximumCandidates) {
          throw new Error("candidate-overflow");
        }
        const snapshot = (candidate: Element): SensitiveActionPropertySnapshot => {
          const selectedOption = candidate instanceof HTMLSelectElement
            ? candidate.selectedOptions.item(0)
            : null;
          return {
            inputValue: candidate instanceof HTMLInputElement ||
                candidate instanceof HTMLTextAreaElement
              ? candidate.value
              : null,
            selectValue: candidate instanceof HTMLSelectElement ? candidate.value : null,
            selectedOptionText: selectedOption?.text ?? null,
            textContent: candidate.textContent,
            attributes: limits.attributes.map((name) => candidate.getAttribute(name)),
          };
        };
        const records: MutationRecord[] = [];
        const tracker = {
          target: element,
          candidates: elements.map((candidate) => ({
            element: candidate,
            properties: snapshot(candidate),
          })),
          records,
          overflow: false,
          observerError: false,
        } as Omit<SensitiveActionMutationTracker, "observer"> & {
          observer?: MutationObserver;
        };
        const observer = new MutationObserver((mutations) => {
          try {
            if (records.length + mutations.length > limits.maximumMutations) {
              tracker.overflow = true;
              return;
            }
            records.push(...mutations);
          } catch {
            tracker.observerError = true;
          }
        });
        tracker.observer = observer;
        observer.observe(element.ownerDocument, {
          attributes: true,
          characterData: true,
          childList: true,
          subtree: true,
        });
        return tracker as SensitiveActionMutationTracker;
      }, {
        maximumCandidates: MAXIMUM_SENSITIVE_ACTION_CANDIDATES,
        candidateSelector: SENSITIVE_ACTION_CANDIDATE_SELECTOR,
        attributes: SENSITIVE_ACTION_ATTRIBUTES,
        maximumMutations: MAXIMUM_SENSITIVE_ACTION_MUTATIONS,
      });
    } catch {
      throw this.sensitiveEvidenceFailure(
        "Sensitive action provenance tracking could not be installed.",
      );
    }
  }

  async finishSensitiveActionTracking(
    tracker: JSHandle<SensitiveActionMutationTracker>,
    target: ElementHandle<Element>,
    browserForms: readonly string[],
    remainingActionTimeoutMs: number,
  ): Promise<void> {
    const settleMs = Math.min(
      MAXIMUM_SENSITIVE_ACTION_SETTLE_MS,
      Math.max(0, remainingActionTimeoutMs),
    );
    let cleanupFailed = false;
    try {
      if (settleMs > 0) {
        await this.page?.waitForTimeout(settleMs);
      }
      const result = await tracker.evaluateHandle((state, evidence) => {
        const fail = (reason: string) => ({ reason, elements: [] as Element[] });
        try {
          const pending = state.observer.takeRecords();
          state.observer.disconnect();
          if (state.records.length + pending.length > evidence.maximumMutations) {
            state.overflow = true;
          } else {
            state.records.push(...pending);
          }
          if (state.observerError) return fail("observer-error");
          if (state.overflow) return fail("mutation-overflow");
          if (state.target !== evidence.target || !state.target.isConnected) {
            return fail("target-replaced");
          }

          const currentCandidates = Array.from(
            state.target.ownerDocument.querySelectorAll(evidence.candidateSelector),
          );
          if (currentCandidates.length > evidence.maximumCandidates) {
            return fail("candidate-overflow");
          }
          if (currentCandidates.length !== state.candidates.length ||
              currentCandidates.some((candidate) =>
                !state.candidates.some((before) => before.element === candidate))) {
            return fail("candidate-ambiguity");
          }

          const forms = [...new Set(evidence.forms.filter((form) => form !== ""))];
          const containsSensitiveForm = (value: string | null): boolean =>
            value !== null && forms.some((form) => value.includes(form));
          const elements: Element[] = [];
          const add = (element: Element | null): boolean => {
            if (element === null || !element.isConnected ||
                element.ownerDocument !== state.target.ownerDocument) {
              return false;
            }
            if (!elements.includes(element)) elements.push(element);
            return true;
          };
          const snapshot = (candidate: Element): SensitiveActionPropertySnapshot => {
            const selectedOption = candidate instanceof HTMLSelectElement
              ? candidate.selectedOptions.item(0)
              : null;
            return {
              inputValue: candidate instanceof HTMLInputElement ||
                  candidate instanceof HTMLTextAreaElement
                ? candidate.value
                : null,
              selectValue: candidate instanceof HTMLSelectElement ? candidate.value : null,
              selectedOptionText: selectedOption?.text ?? null,
              textContent: candidate.textContent,
              attributes: evidence.attributes.map((name) => candidate.getAttribute(name)),
            };
          };

          for (const mutation of state.records) {
            if (mutation.type === "attributes") {
              if (!(mutation.target instanceof Element) || mutation.attributeName === null) {
                return fail("unprovable-attribute-target");
              }
              if (containsSensitiveForm(mutation.target.getAttribute(mutation.attributeName)) &&
                  !add(mutation.target)) {
                return fail("disconnected-attribute-target");
              }
              continue;
            }
            if (mutation.type === "characterData") {
              if (!(mutation.target instanceof CharacterData)) {
                return fail("unprovable-text-target");
              }
              if (containsSensitiveForm(mutation.target.data) &&
                  !add(mutation.target.parentElement)) {
                return fail("disconnected-text-target");
              }
              continue;
            }
            if (mutation.type !== "childList") {
              return fail("unknown-mutation-type");
            }

            for (const node of mutation.addedNodes) {
              if (node instanceof CharacterData && containsSensitiveForm(node.data)) {
                if (!add(node.parentElement)) return fail("disconnected-added-text");
              } else if (node instanceof Element && containsSensitiveForm(node.textContent)) {
                if (!add(node)) return fail("disconnected-added-element");
              }
            }
          }

          for (const candidate of state.candidates) {
            const after = snapshot(candidate.element);
            const beforeValues = [
              candidate.properties.inputValue,
              candidate.properties.selectValue,
              candidate.properties.selectedOptionText,
              candidate.properties.textContent,
              ...candidate.properties.attributes,
            ];
            const afterValues = [
              after.inputValue,
              after.selectValue,
              after.selectedOptionText,
              after.textContent,
              ...after.attributes,
            ];
            if (afterValues.some((value, index) =>
              value !== beforeValues[index] && containsSensitiveForm(value)) &&
                !add(candidate.element)) {
              return fail("disconnected-property-target");
            }
          }
          return { reason: undefined, elements };
        } catch {
          try {
            state.observer.disconnect();
          } catch {
            // The stable failure below prevents any evidence capture.
          }
          return fail("observer-evaluation-error");
        }
      }, {
        target,
        forms: browserForms,
        maximumMutations: MAXIMUM_SENSITIVE_ACTION_MUTATIONS,
        maximumCandidates: MAXIMUM_SENSITIVE_ACTION_CANDIDATES,
        candidateSelector: SENSITIVE_ACTION_CANDIDATE_SELECTOR,
        attributes: SENSITIVE_ACTION_ATTRIBUTES,
      });
      try {
        const summary = await result.evaluate((value) => ({
          reason: value.reason,
          count: value.elements.length,
        }));
        if (summary.reason !== undefined) {
          throw new Error(summary.reason);
        }
        const elements = await result.getProperty("elements");
        try {
          const properties = await elements.getProperties();
          const handles: ElementHandle<Element>[] = [];
          for (let index = 0; index < summary.count; index += 1) {
            const property = properties.get(String(index));
            const element = property?.asElement();
            if (element === null || element === undefined) {
              throw new Error("unprovable-reflected-element");
            }
            handles.push(element);
          }
          await this.retainSensitiveElements(handles);
        } finally {
          await elements.dispose();
        }
      } finally {
        await result.dispose();
      }
    } catch {
      throw this.sensitiveEvidenceFailure(
        "Sensitive action provenance could not be bounded and proven.",
      );
    } finally {
      await tracker.evaluate((state) => state.observer.disconnect()).catch(() => {
        this.sensitiveEvidenceUnproven = true;
        cleanupFailed = true;
      });
      await tracker.dispose().catch(() => {
        this.sensitiveEvidenceUnproven = true;
        cleanupFailed = true;
      });
    }
    if (cleanupFailed) {
      throw this.sensitiveEvidenceFailure(
        "Sensitive action provenance tracking could not be removed.",
      );
    }
  }

  private async retainSensitiveElements(handles: readonly ElementHandle<Element>[]): Promise<void> {
    if (this.page === undefined) {
      throw new Error("page-unavailable");
    }
    const unique: ElementHandle<Element>[] = [];
    for (const handle of handles) {
      let retained = false;
      for (const target of this.sensitiveActionTargets.values()) {
        if (await handle.evaluate((element, existing) => element === existing, target.handle)) {
          retained = true;
          break;
        }
      }
      if (retained) {
        await handle.dispose();
      } else {
        let duplicate = false;
        for (const candidate of unique) {
          if (await handle.evaluate((element, existing) => element === existing, candidate)) {
            duplicate = true;
            break;
          }
        }
        if (duplicate) {
          await handle.dispose();
        } else {
          unique.push(handle);
        }
      }
    }
    if (this.sensitiveActionTargets.size + unique.length > MAXIMUM_SENSITIVE_ACTION_TARGETS) {
      await Promise.all(unique.map((handle) => handle.dispose().catch(() => undefined)));
      throw new Error("sensitive-target-overflow");
    }

    const registered: SensitiveActionTarget[] = [];
    try {
      for (const handle of unique) {
        this.privateTargetOrdinal += 1;
        const token = `target-${this.privateTargetOrdinal}`;
        const markerInstalled = await handle.evaluate((element, identity) => {
          element.setAttribute(identity.attribute, identity.token);
          return element.isConnected && element.getAttribute(identity.attribute) === identity.token;
        }, { attribute: PRIVATE_TARGET_ATTRIBUTE, token });
        if (!markerInstalled) throw new Error("reflected-marker-unproven");
        const target: SensitiveActionTarget = {
          token,
          locator: this.page.locator(`[${PRIVATE_TARGET_ATTRIBUTE}="${token}"]`),
          handle,
          markerInstalled: true,
          nodeId: undefined,
        };
        this.sensitiveActionTargets.set(token, target);
        registered.push(target);
      }
    } catch (error) {
      for (const target of registered) {
        this.sensitiveActionTargets.delete(target.token);
        await target.handle.evaluate((element, identity) => {
          if (element.getAttribute(identity.attribute) === identity.token) {
            element.removeAttribute(identity.attribute);
          }
        }, { attribute: PRIVATE_TARGET_ATTRIBUTE, token: target.token }).catch(() => undefined);
      }
      await Promise.all(unique.map((handle) => handle.dispose().catch(() => undefined)));
      throw error;
    }
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

    const targets = new Map([
      ...[...this.privateActionTargets.values()].map((target) => [target.token, target] as const),
      ...[...this.sensitiveActionTargets.values()].map((target) => [target.token, target] as const),
    ]);
    if (this.page) {
      for (const target of targets.values()) {
        if (target.markerInstalled) {
          await target.handle.evaluate((element, identity) => {
            if (element.getAttribute(identity.attribute) === identity.token) {
              element.removeAttribute(identity.attribute);
            }
          }, { attribute: PRIVATE_TARGET_ATTRIBUTE, token: target.token }).catch(() => undefined);
        }
      }
      await this.page.close().catch(record);
      this.page = undefined;
    }
    for (const target of targets.values()) {
      await target.handle.dispose().catch(() => undefined);
    }
    if (this.context) {
      await this.context.close().catch(record);
      this.context = undefined;
    }
    if (this.browser) {
      await this.browser.close().catch(record);
      this.browser = undefined;
    }
    this.sensitiveActionTargets.clear();
    this.privateActionTargets.clear();
    this.sensitiveEvidenceUnproven = false;
    return firstError;
  }
}

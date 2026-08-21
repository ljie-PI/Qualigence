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
export const MAXIMUM_OBSERVATION_CANDIDATES = 512;
export const MAXIMUM_OBSERVATION_NODE_BYTES = 64 * 1024;
export const MAXIMUM_OBSERVATION_SNAPSHOT_BYTES = 2 * 1024 * 1024;
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

interface SensitiveActionMutationRecord {
  readonly record: MutationRecord;
  readonly causal: boolean;
}

interface SensitiveActionMutationTracker {
  readonly target: Element;
  readonly forms: readonly string[];
  candidates: readonly SensitiveActionCandidateSnapshot[];
  readonly records: SensitiveActionMutationRecord[];
  readonly causalElements: Element[];
  readonly observer: MutationObserver;
  readonly restore: () => boolean;
  readonly metadata: SensitivePageMetadataAuthority;
  ambiguousEvent: boolean;
  preparedElements: readonly Element[] | undefined;
  overflow: boolean;
  observerError: boolean;
}

interface SensitivePageMetadataSnapshot {
  readonly href: string;
  readonly pathname: string;
  readonly decodedPathname: string;
  readonly query: readonly { readonly key: string; readonly value: string }[];
  readonly hash: string;
  readonly decodedHash: string;
  readonly title: string;
}

interface SensitivePageMetadataAuthority {
  readonly hrefs: string[];
  readonly pathnames: string[];
  readonly queryKeys: string[];
  readonly queryValues: string[];
  readonly hashes: string[];
  readonly titles: string[];
  unprovenUrl: boolean;
}

interface SensitivePageRedaction {
  pathname: boolean;
  readonly queryKeys: number[];
  readonly queryValues: number[];
  hash: boolean;
  title: boolean;
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
  private readonly sensitiveActionTrackers: JSHandle<SensitiveActionMutationTracker>[] = [];

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
    kind: "input" | "select",
    value: string,
  ): Promise<void> {
    if (this.sensitiveActionTrackers.length >= MAXIMUM_SENSITIVE_ACTION_TARGETS) {
      throw this.sensitiveEvidenceFailure(
        "The sensitive action tracker limit was exceeded.",
      );
    }
    try {
      if (value.length > MAXIMUM_OBSERVATION_NODE_BYTES) {
        throw new Error("source-form-length-overflow");
      }
      if (new TextEncoder().encode(value).byteLength > MAXIMUM_OBSERVATION_NODE_BYTES) {
        throw new Error("source-form-byte-overflow");
      }
      const normalizedForms = await this.normalizeSensitiveValue(target, kind, value);
      const forms = [...new Set([value, ...normalizedForms].filter((form) => form !== ""))];
      const tracker = await target.evaluateHandle((element, input) => {
        const limits = input.limits;
        if (!element.isConnected) {
          throw new Error("target-disconnected");
        }
        const byteLength = (text: string): number => {
          if (text.length > limits.maximumNodeBytes) throw new Error("node-length-overflow");
          return new TextEncoder().encode(text).byteLength;
        };
        const boundedText = (candidate: Element): string => {
          const walker = candidate.ownerDocument.createTreeWalker(
            candidate,
            NodeFilter.SHOW_TEXT,
          );
          const chunks: string[] = [];
          let bytes = 0;
          for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
            const value = node.nodeValue ?? "";
            bytes += byteLength(value);
            if (bytes > limits.maximumNodeBytes) throw new Error("node-byte-overflow");
            chunks.push(value);
          }
          return chunks.join("");
        };
        const snapshot = (candidate: Element): {
          readonly properties: SensitiveActionPropertySnapshot;
          readonly bytes: number;
        } => {
          const selectedOption = candidate instanceof HTMLSelectElement
            ? candidate.selectedOptions.item(0)
            : null;
          const properties: SensitiveActionPropertySnapshot = {
            inputValue: candidate instanceof HTMLInputElement ||
                candidate instanceof HTMLTextAreaElement
              ? candidate.value
              : null,
            selectValue: candidate instanceof HTMLSelectElement ? candidate.value : null,
            selectedOptionText: selectedOption?.text ?? null,
            textContent: boundedText(candidate),
            attributes: limits.attributes.map((name) => candidate.getAttribute(name)),
          };
          let bytes = 0;
          for (const property of [
            properties.inputValue,
            properties.selectValue,
            properties.selectedOptionText,
            properties.textContent,
            ...properties.attributes,
          ]) {
            if (property === null) continue;
            const propertyBytes = byteLength(property);
            if (propertyBytes > limits.maximumNodeBytes) throw new Error("node-byte-overflow");
            bytes += propertyBytes;
            if (bytes > limits.maximumNodeBytes) throw new Error("node-byte-overflow");
          }
          return { properties, bytes };
        };

        const forms = input.forms;

        const boundedCandidates = (): readonly Element[] => {
          const found: Element[] = [];
          const walker = element.ownerDocument.createTreeWalker(
            element.ownerDocument,
            NodeFilter.SHOW_ELEMENT,
            {
              acceptNode(node) {
                return node instanceof Element && node.matches(limits.candidateSelector)
                  ? NodeFilter.FILTER_ACCEPT
                  : NodeFilter.FILTER_SKIP;
              },
            },
          );
          for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
            if (!(node instanceof Element)) throw new Error("candidate-unprovable");
            found.push(node);
            if (found.length > limits.maximumCandidates) throw new Error("candidate-overflow");
          }
          return found;
        };
        const candidateNodes = boundedCandidates();
        const candidates: SensitiveActionCandidateSnapshot[] = [];
        let snapshotBytes = 0;
        for (let index = 0; index < candidateNodes.length; index += 1) {
          const candidate = candidateNodes[index];
          if (candidate === undefined) throw new Error("candidate-unprovable");
          const captured = snapshot(candidate);
          snapshotBytes += captured.bytes;
          if (snapshotBytes > limits.maximumSnapshotBytes) throw new Error("snapshot-byte-overflow");
          candidates.push({ element: candidate, properties: captured.properties });
        }

        const records: SensitiveActionMutationRecord[] = [];
        const causalElements: Element[] = [];
        const tracker = {
          target: element,
          forms,
          candidates,
          records,
          causalElements,
          metadata: {
            hrefs: [],
            pathnames: [],
            queryKeys: [],
            queryValues: [],
            hashes: [],
            titles: [],
            unprovenUrl: false,
          },
          ambiguousEvent: false,
          overflow: false,
          observerError: false,
          preparedElements: undefined,
        } as Omit<SensitiveActionMutationTracker, "observer" | "restore"> & {
          observer?: MutationObserver;
          restore?: () => boolean;
        };
        const appendRecords = (mutations: readonly MutationRecord[], causal: boolean): void => {
          try {
            if (records.length + mutations.length > limits.maximumMutations) {
              tracker.overflow = true;
              return;
            }
            for (const record of mutations) {
              if (record.addedNodes.length > limits.maximumCandidates ||
                  record.removedNodes.length > limits.maximumCandidates) {
                tracker.overflow = true;
                return;
              }
              records.push({ record, causal });
            }
          } catch {
            tracker.observerError = true;
          }
        };
        const observer = new MutationObserver((mutations) => {
          appendRecords(mutations, false);
        });
        tracker.observer = observer;
        observer.observe(element.ownerDocument, {
          attributes: true,
          characterData: true,
          childList: true,
          subtree: true,
        });

        const values = (properties: SensitiveActionPropertySnapshot): readonly (string | null)[] => [
          properties.inputValue,
          properties.selectValue,
          properties.selectedOptionText,
          properties.textContent,
          ...properties.attributes,
        ];
        const containsForm = (property: string | null): boolean =>
          property !== null && forms.some((form) => property.includes(form));
        const capture = (): readonly SensitiveActionCandidateSnapshot[] => {
          const nodes = boundedCandidates();
          const captured: SensitiveActionCandidateSnapshot[] = [];
          let bytes = 0;
          for (let index = 0; index < nodes.length; index += 1) {
            const candidate = nodes[index];
            if (candidate === undefined) throw new Error("candidate-unprovable");
            const item = snapshot(candidate);
            bytes += item.bytes;
            if (bytes > limits.maximumSnapshotBytes) throw new Error("snapshot-byte-overflow");
            captured.push({ element: candidate, properties: item.properties });
          }
          return captured;
        };
        const finishCausalScope = (before: readonly SensitiveActionCandidateSnapshot[]): void => {
          try {
            appendRecords(observer.takeRecords(), true);
            const after = capture();
            const totalCandidates = before.length + after.filter((candidate) =>
              !before.some((prior) => prior.element === candidate.element)).length;
            if (totalCandidates > limits.maximumCandidates) {
              tracker.overflow = true;
              return;
            }
            for (const candidate of after) {
              const prior = before.find((item) => item.element === candidate.element);
              const priorValues = prior === undefined ? [] : values(prior.properties);
              if (values(candidate.properties).some((property, index) =>
                property !== priorValues[index] && containsForm(property)) &&
                  !causalElements.includes(candidate.element)) {
                if (causalElements.length >= limits.maximumTargets) {
                  tracker.overflow = true;
                  return;
                }
                causalElements.push(candidate.element);
              }
            }
          } catch {
            tracker.observerError = true;
          }
        };

        const eventType = input.kind === "select" ? "change" : "input";
        let dispatchSnapshot: readonly SensitiveActionCandidateSnapshot[] | undefined;
        let inCausalScope = false;
        const originalSetTimeout = window.setTimeout;
        const originalQueueMicrotask = window.queueMicrotask;
        const metadataSnapshot = (): SensitivePageMetadataSnapshot => ({
          href: location.href,
          pathname: location.pathname,
          decodedPathname: (() => {
            try { return decodeURIComponent(location.pathname); } catch { return location.pathname; }
          })(),
          query: [...new URLSearchParams(location.search).entries()].map(([key, value]) => ({ key, value })),
          hash: location.hash,
          decodedHash: (() => {
            try { return decodeURIComponent(location.hash); } catch { return location.hash; }
          })(),
          title: document.title,
        });
        const containsSensitiveForm = (text: string): boolean =>
          forms.some((form) => text.includes(form));
        const rememberMetadata = (
          before: SensitivePageMetadataSnapshot,
          after: SensitivePageMetadataSnapshot,
        ): void => {
          const remember = (values: string[], value: string): void => {
            if (!values.includes(value)) values.push(value);
          };
          if (before.href !== after.href && containsSensitiveForm(after.href)) {
            remember(tracker.metadata.hrefs, after.href);
          }
          if (before.pathname !== after.pathname &&
              (containsSensitiveForm(after.pathname) || containsSensitiveForm(after.decodedPathname))) {
            remember(tracker.metadata.pathnames, after.pathname);
          }
          for (let index = 0; index < after.query.length; index += 1) {
            const current = after.query[index];
            const prior = before.query[index];
            if (current === undefined) continue;
            if (current.key !== prior?.key && containsSensitiveForm(current.key)) {
              remember(tracker.metadata.queryKeys, current.key);
            }
            if (current.value !== prior?.value && containsSensitiveForm(current.value)) {
              remember(tracker.metadata.queryValues, current.value);
            }
          }
          if (before.hash !== after.hash &&
              (containsSensitiveForm(after.hash) || containsSensitiveForm(after.decodedHash))) {
            remember(tracker.metadata.hashes, after.hash);
          }
          if (before.title !== after.title && containsSensitiveForm(after.title)) {
            remember(tracker.metadata.titles, after.title);
          }
        };
        let dispatchMetadata: SensitivePageMetadataSnapshot | undefined;
        let dispatchTarget: EventTarget | null = null;
        const beginDispatch = (event: Event): void => {
          try {
            dispatchSnapshot = capture();
            dispatchMetadata = metadataSnapshot();
            dispatchTarget = event.target;
            inCausalScope = event.target === element;
          } catch {
            tracker.observerError = true;
          }
        };
        const endDispatch = (): void => {
          if (dispatchSnapshot === undefined) return;
          const before = dispatchSnapshot;
          const beforeMetadata = dispatchMetadata;
          const authorized = dispatchTarget === element;
          const completedTarget = dispatchTarget;
          dispatchSnapshot = undefined;
          dispatchMetadata = undefined;
          dispatchTarget = null;
          inCausalScope = false;
          if (authorized) {
            finishCausalScope(before);
            if (beforeMetadata !== undefined) rememberMetadata(beforeMetadata, metadataSnapshot());
          } else {
            try {
              const after = capture();
              const eventCandidate = completedTarget instanceof Element
                ? after.find((candidate) => candidate.element === completedTarget)
                : undefined;
              const changedToForm = after.some((candidate) => {
                const prior = before.find((item) => item.element === candidate.element);
                const priorValues = prior === undefined ? [] : values(prior.properties);
                return values(candidate.properties).some((property, index) =>
                  property !== priorValues[index] && containsForm(property));
              });
              if (changedToForm || (eventCandidate !== undefined &&
                  values(eventCandidate.properties).some(containsForm))) {
                tracker.ambiguousEvent = true;
              }
            } catch {
              tracker.observerError = true;
            }
          }
        };
        window.addEventListener(eventType, beginDispatch, true);
        window.addEventListener(eventType, endDispatch, false);

        let callbackDepth = 0;
        const runCausal = (callback: () => void): void => {
          let before: readonly SensitiveActionCandidateSnapshot[];
          try {
            before = capture();
          } catch {
            tracker.observerError = true;
            callback();
            return;
          }
          callbackDepth += 1;
          const beforeMetadata = metadataSnapshot();
          try {
            callback();
          } finally {
            callbackDepth -= 1;
            finishCausalScope(before);
            rememberMetadata(beforeMetadata, metadataSnapshot());
          }
        };
        const wrappedSetTimeout = ((
          handler: TimerHandler,
          timeout?: number,
          ...args: unknown[]
        ): number => {
          if (typeof handler !== "function") {
            tracker.observerError = true;
            return Number(originalSetTimeout.call(window, () => undefined, timeout));
          }
          if (!inCausalScope && callbackDepth === 0) {
            return Number(originalSetTimeout.call(window, () => handler(...args), timeout));
          }
          return Number(originalSetTimeout.call(window, () => {
            runCausal(() => handler(...args));
          }, timeout));
        }) as typeof window.setTimeout;
        const wrappedQueueMicrotask = (callback: VoidFunction): void => {
          if (!inCausalScope && callbackDepth === 0) {
            originalQueueMicrotask.call(window, callback);
          } else {
            originalQueueMicrotask.call(window, () => runCausal(callback));
          }
        };
        window.setTimeout = wrappedSetTimeout;
        window.queueMicrotask = wrappedQueueMicrotask;
        const originalReplaceState = history.replaceState;
        const originalPushState = history.pushState;
        const wrapHistory = (original: History["replaceState"]): History["replaceState"] =>
          function (data: unknown, unused: string, url?: string | URL | null): void {
            const causal = inCausalScope || callbackDepth > 0;
            const before = metadataSnapshot();
            original.call(history, data, unused, url);
            const after = metadataSnapshot();
            if (causal) rememberMetadata(before, after);
            else if (containsSensitiveForm(after.href)) tracker.metadata.unprovenUrl = true;
          };
        const wrappedReplaceState = wrapHistory(originalReplaceState);
        const wrappedPushState = wrapHistory(originalPushState);
        history.replaceState = wrappedReplaceState;
        history.pushState = wrappedPushState;
        tracker.restore = (): boolean => {
          window.removeEventListener(eventType, beginDispatch, true);
          window.removeEventListener(eventType, endDispatch, false);
          const intact = window.setTimeout === wrappedSetTimeout &&
            window.queueMicrotask === wrappedQueueMicrotask &&
            history.replaceState === wrappedReplaceState &&
            history.pushState === wrappedPushState;
          if (window.setTimeout === wrappedSetTimeout) window.setTimeout = originalSetTimeout;
          if (window.queueMicrotask === wrappedQueueMicrotask) {
            window.queueMicrotask = originalQueueMicrotask;
          }
          if (history.replaceState === wrappedReplaceState) history.replaceState = originalReplaceState;
          if (history.pushState === wrappedPushState) history.pushState = originalPushState;
          observer.disconnect();
          return intact;
        };
        return tracker as SensitiveActionMutationTracker;
      }, {
        kind,
        forms,
        limits: {
          maximumCandidates: MAXIMUM_SENSITIVE_ACTION_CANDIDATES,
          maximumMutations: MAXIMUM_SENSITIVE_ACTION_MUTATIONS,
          maximumTargets: MAXIMUM_SENSITIVE_ACTION_TARGETS,
          maximumNodeBytes: MAXIMUM_OBSERVATION_NODE_BYTES,
          maximumSnapshotBytes: MAXIMUM_OBSERVATION_SNAPSHOT_BYTES,
          candidateSelector: SENSITIVE_ACTION_CANDIDATE_SELECTOR,
          attributes: SENSITIVE_ACTION_ATTRIBUTES,
        },
      });
      this.sensitiveActionTrackers.push(tracker);
    } catch (error) {
      throw this.sensitiveEvidenceFailure(
        `The browser-normalized sensitive value and bounded tracker could not be proven: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async normalizeSensitiveValue(
    target: ElementHandle<Element>,
    kind: "input" | "select",
    value: string,
  ): Promise<readonly string[]> {
    if (this.context === undefined) throw new Error("browser-context-unavailable");
    const control = await target.evaluate((element, input) => {
      if (input.actionKind === "select" && element instanceof HTMLSelectElement) {
        if (element.options.length > input.maximumOptions) {
          throw new Error("normalization-option-overflow");
        }
        const options: { readonly value: string; readonly label: string; readonly text: string }[] = [];
        let totalChars = 0;
        for (let index = 0; index < element.options.length; index += 1) {
          const option = element.options.item(index);
          if (option === null) throw new Error("normalization-option-unprovable");
          const valueLength = option.value.length;
          const labelLength = option.label.length;
          const textLength = (option.textContent ?? "").length;
          for (const length of [valueLength, labelLength, textLength]) {
            if (length > input.maximumCharsPerValue) {
              throw new Error("normalization-option-length-overflow");
            }
            totalChars += length;
            if (totalChars > input.maximumTotalChars) {
              throw new Error("normalization-option-total-overflow");
            }
          }
          options.push({
            value: option.value.slice(0, input.maximumCharsPerValue),
            label: option.label.slice(0, input.maximumCharsPerValue),
            text: (option.textContent ?? "").slice(0, input.maximumCharsPerValue),
          });
        }
        return { tag: "select" as const, options };
      }
      if (input.actionKind === "input" && element instanceof HTMLInputElement) {
        return { tag: "input" as const, type: element.type };
      }
      if (input.actionKind === "input" && element instanceof HTMLTextAreaElement) {
        return { tag: "textarea" as const };
      }
      throw new Error("normalization-target-unprovable");
    }, {
      actionKind: kind,
      maximumOptions: MAXIMUM_SENSITIVE_ACTION_CANDIDATES,
      maximumCharsPerValue: MAXIMUM_OBSERVATION_NODE_BYTES,
      maximumTotalChars: MAXIMUM_OBSERVATION_SNAPSHOT_BYTES,
    });
    const normalizationPage = await this.context.newPage();
    try {
      await normalizationPage.setContent("<!doctype html><html><body></body></html>");
      const handle = await normalizationPage.evaluateHandle((descriptor) => {
        let element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
        if (descriptor.tag === "select") {
          element = document.createElement("select");
          for (const source of descriptor.options) {
            const option = document.createElement("option");
            option.value = source.value;
            option.label = source.label;
            option.textContent = source.text;
            element.append(option);
          }
        } else if (descriptor.tag === "textarea") {
          element = document.createElement("textarea");
        } else {
          element = document.createElement("input");
          element.type = descriptor.type;
        }
        document.body.append(element);
        return element;
      }, control);
      const element = handle.asElement();
      if (element === null) throw new Error("normalization-control-unprovable");
      try {
        if (kind === "select") await element.selectOption(value);
        else await element.fill(value);
        const normalized = await normalizationPage.evaluate((input): string[] => {
          const candidate = input.candidate;
          const actionKind = input.actionKind;
          if (actionKind === "select" && candidate instanceof HTMLSelectElement) {
            const selected = candidate.selectedOptions.item(0);
            if (selected === null) throw new Error("normalized-selection-unprovable");
            const forms = [selected.value, selected.label, selected.textContent ?? ""];
            let totalChars = 0;
            for (const form of forms) {
              if (form.length > input.maximumCharsPerValue) {
                throw new Error("normalized-form-length-overflow");
              }
              totalChars += form.length;
              if (totalChars > input.maximumTotalChars) {
                throw new Error("normalized-form-total-overflow");
              }
            }
            return forms.map((form) => form.slice(0, input.maximumCharsPerValue));
          }
          if (actionKind === "input" &&
              (candidate instanceof HTMLInputElement || candidate instanceof HTMLTextAreaElement)) {
            if (candidate.value.length > input.maximumCharsPerValue) {
              throw new Error("normalized-form-length-overflow");
            }
            return [candidate.value.slice(0, input.maximumCharsPerValue)];
          }
          throw new Error("normalized-value-unprovable");
        }, {
          candidate: element,
          actionKind: kind,
          maximumCharsPerValue: MAXIMUM_OBSERVATION_NODE_BYTES,
          maximumTotalChars: MAXIMUM_OBSERVATION_SNAPSHOT_BYTES,
        });
        const forms = [...new Set(normalized.filter((form) => form !== ""))];
        let bytes = 0;
        for (const form of forms) {
          if (form.length > MAXIMUM_OBSERVATION_NODE_BYTES) {
            throw new Error("normalized-form-length-overflow");
          }
          const formBytes = new TextEncoder().encode(form).byteLength;
          if (formBytes > MAXIMUM_OBSERVATION_NODE_BYTES) {
            throw new Error("normalized-form-overflow");
          }
          bytes += formBytes;
        }
        if (bytes > MAXIMUM_OBSERVATION_SNAPSHOT_BYTES) {
          throw new Error("normalized-form-overflow");
        }
        return forms;
      } finally {
        await element.dispose();
      }
    } finally {
      await normalizationPage.close();
    }
  }

  async prepareSensitiveEvidenceCapture(): Promise<void> {
    for (const tracker of this.sensitiveActionTrackers) {
      const handles = await this.reconcileSensitiveActionTracking(tracker, false);
      try {
        await this.retainSensitiveElements(handles);
      } catch {
        throw this.sensitiveEvidenceFailure("Sensitive reflected targets could not be retained.");
      }
    }
  }

  async completeSensitiveEvidenceCapture(): Promise<void> {
    for (const tracker of this.sensitiveActionTrackers) {
      await this.reconcileSensitiveActionTracking(tracker, true);
    }
  }

  async failIfSensitiveTrackingOverflowed(): Promise<void> {
    for (const tracker of this.sensitiveActionTrackers) {
      const invalid = await tracker.evaluate((state) =>
        state.overflow || state.observerError || state.ambiguousEvent).catch(() => true);
      if (invalid) {
        throw this.sensitiveEvidenceFailure(
          "Sensitive action provenance tracking exceeded its bounds.",
        );
      }
    }
  }

  async abandonSensitiveActionTracking(): Promise<void> {
    for (const tracker of this.sensitiveActionTrackers.splice(0)) {
      await this.disposeSensitiveActionTracker(tracker, true);
    }
  }

  async redactSensitivePageMetadata(
    href: string,
    title: string,
  ): Promise<{ readonly url: string; readonly title: string }> {
    if (this.sensitiveActionTrackers.length === 0) return { url: href, title };
    const parsed = new URL(href);
    const query = [...parsed.searchParams.entries()];
    let decodedPathname = parsed.pathname;
    let decodedHash = parsed.hash;
    try { decodedPathname = decodeURIComponent(parsed.pathname); } catch { /* fail below if sensitive */ }
    try { decodedHash = decodeURIComponent(parsed.hash); } catch { /* fail below if sensitive */ }
    const redaction: SensitivePageRedaction = {
      pathname: false,
      queryKeys: [],
      queryValues: [],
      hash: false,
      title: false,
    };
    let sensitiveOccurrence = false;
    for (const tracker of this.sensitiveActionTrackers) {
      const result = await tracker.evaluate((state, current) => {
        const contains = (value: string): boolean =>
          state.forms.some((form) => value.includes(form));
        const authorized = (values: readonly string[], value: string): boolean => values.includes(value);
        const pathnameSensitive = contains(current.pathname) || contains(current.decodedPathname);
        const hashSensitive = contains(current.hash) || contains(current.decodedHash);
        const titleSensitive = contains(current.title);
        const queryKeyIndexes: number[] = [];
        const queryValueIndexes: number[] = [];
        let occurrence = pathnameSensitive || hashSensitive || titleSensitive || contains(current.href);
        let unproven = state.metadata.unprovenUrl;
        if (pathnameSensitive) unproven ||= !authorized(state.metadata.pathnames, current.pathname);
        if (hashSensitive) unproven ||= !authorized(state.metadata.hashes, current.hash);
        if (titleSensitive) unproven ||= !authorized(state.metadata.titles, current.title);
        for (let index = 0; index < current.query.length; index += 1) {
          const item = current.query[index];
          if (item === undefined) continue;
          if (contains(item.key)) {
            occurrence = true;
            queryKeyIndexes.push(index);
            unproven ||= !authorized(state.metadata.queryKeys, item.key);
          }
          if (contains(item.value)) {
            occurrence = true;
            queryValueIndexes.push(index);
            unproven ||= !authorized(state.metadata.queryValues, item.value);
          }
        }
        const knownField = pathnameSensitive || hashSensitive || titleSensitive ||
          queryKeyIndexes.length > 0 || queryValueIndexes.length > 0;
        if (contains(current.href) && !knownField) unproven = true;
        return {
          occurrence,
          unproven,
          pathname: pathnameSensitive,
          hash: hashSensitive,
          title: titleSensitive,
          queryKeyIndexes,
          queryValueIndexes,
        };
      }, {
        href,
        pathname: parsed.pathname,
        decodedPathname,
        query: query.map(([key, value]) => ({ key, value })),
        hash: parsed.hash,
        decodedHash,
        title,
      }).catch(() => ({
        occurrence: true,
        unproven: true,
        pathname: false,
        hash: false,
        title: false,
        queryKeyIndexes: [] as number[],
        queryValueIndexes: [] as number[],
      }));
      sensitiveOccurrence ||= result.occurrence;
      if (result.unproven) {
        throw this.sensitiveEvidenceFailure("Sensitive page URL or title provenance is unproven.");
      }
      redaction.pathname ||= result.pathname;
      redaction.hash ||= result.hash;
      redaction.title ||= result.title;
      for (const index of result.queryKeyIndexes) {
        if (!redaction.queryKeys.includes(index)) redaction.queryKeys.push(index);
      }
      for (const index of result.queryValueIndexes) {
        if (!redaction.queryValues.includes(index)) redaction.queryValues.push(index);
      }
    }
    if (!sensitiveOccurrence) return { url: href, title };
    if (redaction.pathname) parsed.pathname = "/[REDACTED]";
    if (redaction.hash) parsed.hash = "[REDACTED]";
    if (redaction.queryKeys.length > 0 || redaction.queryValues.length > 0) {
      parsed.search = "";
      for (const [index, [key, value]] of query.entries()) {
        parsed.searchParams.append(
          redaction.queryKeys.includes(index) ? "[REDACTED]" : key,
          redaction.queryValues.includes(index) ? "[REDACTED]" : value,
        );
      }
    }
    return { url: parsed.href, title: redaction.title ? "[REDACTED]" : title };
  }

  private async reconcileSensitiveActionTracking(
    tracker: JSHandle<SensitiveActionMutationTracker>,
    final: boolean,
  ): Promise<readonly ElementHandle<Element>[]> {
    let result: JSHandle<{ readonly reason: string | undefined; readonly elements: readonly Element[] }> |
      undefined;
    try {
      result = await tracker.evaluateHandle((state, limits) => {
        const fail = (reason: string) => ({ reason, elements: [] as Element[] });
        try {
          const byteLength = (text: string): number => {
            if (text.length > limits.maximumNodeBytes) throw new Error("node-length-overflow");
            return new TextEncoder().encode(text).byteLength;
          };
          const boundedText = (candidate: Element): string => {
            const walker = candidate.ownerDocument.createTreeWalker(
              candidate,
              NodeFilter.SHOW_TEXT,
            );
            const chunks: string[] = [];
            let bytes = 0;
            for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
              const value = node.nodeValue ?? "";
              bytes += byteLength(value);
              if (bytes > limits.maximumNodeBytes) throw new Error("node-byte-overflow");
              chunks.push(value);
            }
            return chunks.join("");
          };
          const pending = state.observer.takeRecords();
          if (state.records.length + pending.length > limits.maximumMutations) {
            state.overflow = true;
          } else {
            for (const record of pending) state.records.push({ record, causal: false });
          }
          if (state.observerError) return fail("observer-error");
          if (state.overflow) return fail("tracker-overflow");
          if (state.ambiguousEvent) return fail("event-target-causality-ambiguous");
          if (!state.target.isConnected) return fail("target-replaced");

          const snapshot = (candidate: Element): {
            readonly properties: SensitiveActionPropertySnapshot;
            readonly bytes: number;
          } => {
            const selectedOption = candidate instanceof HTMLSelectElement
              ? candidate.selectedOptions.item(0)
              : null;
            const properties: SensitiveActionPropertySnapshot = {
              inputValue: candidate instanceof HTMLInputElement ||
                  candidate instanceof HTMLTextAreaElement ? candidate.value : null,
              selectValue: candidate instanceof HTMLSelectElement ? candidate.value : null,
              selectedOptionText: selectedOption?.text ?? null,
              textContent: boundedText(candidate),
              attributes: limits.attributes.map((name) => candidate.getAttribute(name)),
            };
            let bytes = 0;
            for (const property of [
              properties.inputValue,
              properties.selectValue,
              properties.selectedOptionText,
              properties.textContent,
              ...properties.attributes,
            ]) {
              if (property === null) continue;
              const propertyBytes = byteLength(property);
              if (propertyBytes > limits.maximumNodeBytes) throw new Error("node-byte-overflow");
              bytes += propertyBytes;
              if (bytes > limits.maximumNodeBytes) throw new Error("node-byte-overflow");
            }
            return { properties, bytes };
          };
          const values = (properties: SensitiveActionPropertySnapshot): readonly (string | null)[] => [
            properties.inputValue,
            properties.selectValue,
            properties.selectedOptionText,
            properties.textContent,
            ...properties.attributes,
          ];
          const containsForm = (property: string | null): boolean =>
            property !== null && state.forms.some((form) => property.includes(form));
          const nodes: Element[] = [];
          const walker = state.target.ownerDocument.createTreeWalker(
            state.target.ownerDocument,
            NodeFilter.SHOW_ELEMENT,
            {
              acceptNode(node) {
                return node instanceof Element && node.matches(limits.candidateSelector)
                  ? NodeFilter.FILTER_ACCEPT
                  : NodeFilter.FILTER_SKIP;
              },
            },
          );
          for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
            if (!(node instanceof Element)) return fail("candidate-unprovable");
            nodes.push(node);
            if (nodes.length > limits.maximumCandidates) return fail("candidate-overflow");
          }
          const current: SensitiveActionCandidateSnapshot[] = [];
          let snapshotBytes = 0;
          for (let index = 0; index < nodes.length; index += 1) {
            const candidate = nodes[index];
            if (candidate === undefined) return fail("candidate-unprovable");
            const captured = snapshot(candidate);
            snapshotBytes += captured.bytes;
            if (snapshotBytes > limits.maximumSnapshotBytes) return fail("snapshot-byte-overflow");
            current.push({ element: candidate, properties: captured.properties });
          }
          const totalCandidates = state.candidates.length + current.filter((candidate) =>
            !state.candidates.some((before) => before.element === candidate.element)).length;
          if (totalCandidates > limits.maximumCandidates) return fail("total-candidate-overflow");

          const elements: Element[] = [];
          const causallyChanged = (candidate: Element): boolean =>
            candidate === state.target || state.causalElements.includes(candidate) ||
            candidate.hasAttribute(limits.privateTargetAttribute);
          const add = (candidate: Element | null): boolean => {
            if (candidate === null || !candidate.isConnected ||
                candidate.ownerDocument !== state.target.ownerDocument) return false;
            if (!elements.includes(candidate)) elements.push(candidate);
            return elements.length <= limits.maximumTargets;
          };
          for (const candidate of current) {
            const before = state.candidates.find((item) => item.element === candidate.element);
            const beforeValues = before === undefined ? [] : values(before.properties);
            const changedToForm = values(candidate.properties).some((property, index) =>
              property !== beforeValues[index] && containsForm(property));
            if (!changedToForm) continue;
            if (!causallyChanged(candidate.element)) {
              return fail("same-form-causality-ambiguous");
            }
            if (!add(candidate.element)) return fail("sensitive-target-overflow");
          }

          let inspectedBytes = snapshotBytes;
          const inspect = (
            property: string | null,
            candidate: Element | null,
            causal: boolean,
            kind: MutationRecord["type"],
          ): string | undefined => {
            if (property === null) return undefined;
            const bytes = byteLength(property);
            if (bytes > limits.maximumNodeBytes) return "node-byte-overflow";
            inspectedBytes += bytes;
            if (inspectedBytes > limits.maximumSnapshotBytes) return "snapshot-byte-overflow";
            if (!containsForm(property)) return undefined;
            if (candidate instanceof HTMLTitleElement) return undefined;
            if (kind === "childList" && candidate !== null && causallyChanged(candidate)) {
              return add(candidate) ? undefined : "sensitive-target-overflow";
            }
            if (candidate === null || !causallyChanged(candidate) ||
                (!causal && !candidate.hasAttribute(limits.privateTargetAttribute))) {
              return "same-form-causality-ambiguous";
            }
            return add(candidate) ? undefined : "sensitive-target-overflow";
          };
          for (const tracked of state.records) {
            const mutation = tracked.record;
            if (mutation.type === "attributes") {
              if (!(mutation.target instanceof Element) || mutation.attributeName === null) {
                return fail("attribute-target-unprovable");
              }
              const reason = inspect(
                mutation.target.getAttribute(mutation.attributeName),
                mutation.target,
                tracked.causal,
                mutation.type,
              );
              if (reason !== undefined) return fail(reason);
            } else if (mutation.type === "characterData") {
              if (!(mutation.target instanceof CharacterData)) return fail("text-target-unprovable");
              const reason = inspect(
                mutation.target.data,
                mutation.target.parentElement,
                tracked.causal,
                mutation.type,
              );
              if (reason !== undefined) return fail(reason);
            } else if (mutation.type === "childList") {
              if (mutation.addedNodes.length > limits.maximumCandidates ||
                  mutation.removedNodes.length > limits.maximumCandidates) {
                return fail("mutation-node-overflow");
              }
              for (const node of mutation.addedNodes) {
                const candidate = node instanceof Element ? node : node.parentElement;
                const text = node instanceof Element
                  ? boundedText(node)
                  : node.nodeValue;
                const reason = inspect(text, candidate, tracked.causal, mutation.type);
                if (reason !== undefined) return fail(reason);
              }
            } else {
              return fail("mutation-type-unprovable");
            }
          }

          if (limits.final) {
            if (state.preparedElements === undefined ||
                state.preparedElements.length !== elements.length ||
                state.preparedElements.some((candidate) => !elements.includes(candidate))) {
              return fail("capture-changed-during-evidence");
            }
            state.candidates = current;
            state.records.length = 0;
            state.preparedElements = undefined;
          } else {
            state.preparedElements = [...elements];
          }
          return { reason: undefined, elements };
        } catch {
          return fail("tracker-evaluation-error");
        }
      }, {
        final,
        maximumMutations: MAXIMUM_SENSITIVE_ACTION_MUTATIONS,
        maximumCandidates: MAXIMUM_SENSITIVE_ACTION_CANDIDATES,
        maximumTargets: MAXIMUM_SENSITIVE_ACTION_TARGETS,
        maximumNodeBytes: MAXIMUM_OBSERVATION_NODE_BYTES,
        maximumSnapshotBytes: MAXIMUM_OBSERVATION_SNAPSHOT_BYTES,
        candidateSelector: SENSITIVE_ACTION_CANDIDATE_SELECTOR,
        attributes: SENSITIVE_ACTION_ATTRIBUTES,
        privateTargetAttribute: PRIVATE_TARGET_ATTRIBUTE,
      });
      const summary = await result.evaluate((value) => ({
        reason: value.reason,
        count: value.elements.length,
      }));
      if (summary.reason !== undefined) throw new Error(summary.reason);
      if (final) return [];
      const elements = await result.getProperty("elements");
      try {
        const properties = await elements.getProperties();
        const handles: ElementHandle<Element>[] = [];
        for (let index = 0; index < summary.count; index += 1) {
          const handle = properties.get(String(index))?.asElement();
          if (handle === null || handle === undefined) throw new Error("element-unprovable");
          handles.push(handle);
        }
        return handles;
      } finally {
        await elements.dispose();
      }
    } catch (error) {
      throw this.sensitiveEvidenceFailure(
        `Sensitive action provenance could not be bounded and proven: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      await result?.dispose().catch(() => { this.sensitiveEvidenceUnproven = true; });
    }
  }

  private async disposeSensitiveActionTracker(
    tracker: JSHandle<SensitiveActionMutationTracker>,
    suppressFailure = false,
  ): Promise<void> {
    let failed = false;
    try {
      if (!(await tracker.evaluate((state) => state.restore()))) failed = true;
    } catch {
      failed = true;
    }
    await tracker.dispose().catch(() => { failed = true; });
    if (failed && !suppressFailure) {
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
      await this.abandonSensitiveActionTracking().catch(record);
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

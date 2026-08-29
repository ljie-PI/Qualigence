import type {
  ActionExecutor,
  ActionOutcome,
  AnyResolvedAction,
  ResolvedAction,
} from "@qualigence/runner-kernel";
import type { CDPSession, Locator, Page } from "playwright";
import { ExecutionPermit, isDesktopAction } from "@qualigence/runner-kernel";
import {
  PlaywrightBrowserSession,
  WebTargetError,
} from "./browser-session.js";
import { locatorFor } from "./action-locator.js";
import { isActionToken } from "./action-token.js";
import type { LocatorDescriptor } from "./types.js";
import {
  MAX_REFLECTED_MUTATION_RECORDS,
  MAX_REFLECTED_NODES,
  MAX_REFLECTED_REGIONS,
  MAX_SENSITIVE_SHADOW_ROOTS,
  SENSITIVE_EVIDENCE_STATE_PROPERTY,
  SENSITIVE_MASK_ID_ATTRIBUTE,
  SENSITIVE_SHADOW_ROOTS_PROPERTY,
  SENSITIVE_TARGET_IDS_PROPERTY,
  type PreparedSensitiveEvidenceRecord,
  type SensitiveMaskSnapshotEntry,
} from "./sensitive-evidence-authority.js";

export interface ActionValueProvider {
  resolve(valueRef: string): Promise<string>;
}

export class PlaywrightActionExecutor implements ActionExecutor {
  constructor(
    private readonly session: PlaywrightBrowserSession,
    private readonly valueProvider?: ActionValueProvider,
  ) {}

  execute(
    action: ResolvedAction,
    permit: ExecutionPermit,
    signal?: AbortSignal,
  ): Promise<ActionOutcome>;
  execute(
    action: AnyResolvedAction,
    permit: ExecutionPermit,
    signal?: AbortSignal,
  ): Promise<ActionOutcome>;
  async execute(
    action: AnyResolvedAction,
    permit: ExecutionPermit,
    signal?: AbortSignal,
  ): Promise<ActionOutcome> {
    signal?.throwIfAborted();
    if (!(permit instanceof ExecutionPermit)) {
      throw new WebTargetError(
        "ConcurrentSessionOperation",
        "A valid ExecutionPermit is required to execute an action.",
      );
    }

    // The Playwright executor only drives Web targets; a Desktop/UIA action must
    // never be executed here (it is brokered through the Companion instead).
    if (isDesktopAction(action)) {
      return { status: "failed", errorCode: "UnsupportedTargetKind" };
    }

    let navigationGeneration: number;
    try {
      navigationGeneration = this.session.requireResolvedActionGeneration(action);
    } catch {
      return { status: "failed", errorCode: "OriginViolation" };
    }

    if (action.kind === "navigate") {
      if (!isSafeTargetUrl(action.url, this.session)) {
        return { status: "failed", errorCode: "OriginViolation" };
      }
      this.session.invalidateObservations();
      return this.session.withPage(async (page) => {
        signal?.throwIfAborted();
        const generationFailure = navigationGenerationFailure(
          page,
          this.session,
          navigationGeneration,
        );
        if (generationFailure !== undefined) return generationFailure;
        if (!isSafeTargetUrl(action.url, this.session)) {
          return { status: "failed", errorCode: "OriginViolation" };
        }
        const originFailure = targetOriginFailure(page, this.session);
        if (originFailure !== undefined) return originFailure;
        try {
          const dispatchGenerationFailure = navigationGenerationFailure(
            page,
            this.session,
            navigationGeneration,
          );
          if (dispatchGenerationFailure !== undefined) return dispatchGenerationFailure;
          permit.assertAuthorizedForDispatch(signal, () => dispatchSnapshot(this.session));
          await page.goto(action.url, {
            waitUntil: "domcontentloaded",
            timeout: this.session.navigationTimeoutMs,
          });
        } catch (error) {
          if (permit.dispatchStarted) {
            return { status: "failed", errorCode: "ActionOutcomeUnknown" };
          }
          throw error;
        }
        return hasKnownActionOutcome(page, this.session, permit)
          ? { status: "ok" }
          : { status: "failed", errorCode: "ActionOutcomeUnknown" };
      });
    }
    if (action.kind === "scroll" && action.target === undefined) {
      return this.session.withPage(async (page) => {
        signal?.throwIfAborted();
        const guardFailure = this.guardPageAction(
          page,
          action.graphId,
          navigationGeneration,
        );
        if (guardFailure !== undefined) return guardFailure;
        this.session.invalidateObservations();
        const distance = action.amount === "page" ? 1 : 0.25;
        try {
          const dispatchGenerationFailure = navigationGenerationFailure(
            page,
            this.session,
            navigationGeneration,
          );
          if (dispatchGenerationFailure !== undefined) return dispatchGenerationFailure;
          permit.assertAuthorizedForDispatch(signal, () => dispatchSnapshot(this.session));
          await page.evaluate(
            ({ direction, distance }) => {
              const horizontal = direction === "left" || direction === "right";
              const sign = direction === "up" || direction === "left" ? -1 : 1;
              window.scrollBy({
                left: horizontal ? window.innerWidth * distance * sign : 0,
                top: horizontal ? 0 : window.innerHeight * distance * sign,
                behavior: "instant",
              });
            },
            { direction: action.direction, distance },
          );
        } catch (error) {
          if (permit.dispatchStarted) {
            return { status: "failed", errorCode: "ActionOutcomeUnknown" };
          }
          throw error;
        }
        return hasKnownActionOutcome(page, this.session, permit)
          ? { status: "ok" }
          : { status: "failed", errorCode: "ActionOutcomeUnknown" };
      });
    }
    const actionTarget = action.target;
    if (actionTarget === undefined) {
      return { status: "failed", errorCode: "UnsupportedAction" };
    }

    if (
      !isActionToken(actionTarget.selector, action.graphId, actionTarget.nodeId)
    ) {
      return { status: "failed", errorCode: "UnknownObservationNode" };
    }

    let descriptor: LocatorDescriptor | undefined;
    try {
      this.session.assertObservationGeneration(action.graphId, navigationGeneration);
      descriptor = this.session.descriptorFor(action.graphId, actionTarget.nodeId);
    } catch (error) {
      return {
        status: "failed",
        errorCode: error instanceof WebTargetError && error.code === "OriginViolation"
          ? "OriginViolation"
          : "StaleObservation",
      };
    }
    if (!descriptor) {
      return { status: "failed", errorCode: "StaleObservation" };
    }

    return this.session.withPage(async (page): Promise<ActionOutcome> => {
      signal?.throwIfAborted();
      const originFailure = navigationGenerationFailure(
        page,
        this.session,
        navigationGeneration,
      );
      if (originFailure !== undefined) return originFailure;
      const locator = locatorFor(page, descriptor);
      const readForObservation = <T>(read: () => Promise<T>): Promise<T> =>
        this.session.readForObservation(
          page,
          action.graphId,
          navigationGeneration,
          read,
        );

      let count: number;
      let visible: boolean;
      let enabled: boolean;
      let href: string | null;
      try {
        count = await readForObservation(() => locator.count());
        visible = count === 1 && await readForObservation(() => locator.isVisible());
        enabled = visible && await readForObservation(() => locator.isEnabled());
        href = enabled
          ? await readForObservation(() => locator.getAttribute("href"))
          : null;
      } catch (error) {
        if (error instanceof WebTargetError && error.code === "OriginViolation") {
          return { status: "failed", errorCode: "OriginViolation" };
        }
        const readOriginFailure = navigationGenerationFailure(
          page,
          this.session,
          navigationGeneration,
        );
        if (readOriginFailure !== undefined) return readOriginFailure;
        signal?.throwIfAborted();
        return { status: "failed", errorCode: "ActionFailed" };
      }
      const preflightOriginFailure = navigationGenerationFailure(
        page,
        this.session,
        navigationGeneration,
      );
      if (preflightOriginFailure !== undefined) return preflightOriginFailure;
      if (count === 0) {
        return { status: "failed", errorCode: "TargetNotFound" };
      }
      if (count > 1) {
        return { status: "failed", errorCode: "AmbiguousTarget" };
      }
      if (!visible) {
        return { status: "failed", errorCode: "TargetNotVisible" };
      }
      if (!enabled) {
        return { status: "failed", errorCode: "TargetDisabled" };
      }

      if (href !== null) {
        let destination: string | undefined;
        try {
          destination = new URL(
            href,
            this.session.assertPageTargetOrigin(page, navigationGeneration),
          ).href;
        } catch {
          destination = undefined;
        }
        if (destination === undefined || !isSafeTargetUrl(destination, this.session)) {
          return { status: "failed", errorCode: "OriginViolation" };
        }
      }

      try {
        if (action.kind === "input" || action.kind === "select") {
          if (this.valueProvider === undefined) {
            return { status: "failed", errorCode: "ActionValueUnavailable" };
          }
          const valuePreflightFailure = navigationGenerationFailure(
            page,
            this.session,
            navigationGeneration,
          );
          if (valuePreflightFailure !== undefined) return valuePreflightFailure;
          let value: string;
          try {
            value = await this.valueProvider.resolve(action.valueRef);
          } catch {
            const valueGenerationFailure = navigationGenerationFailure(
              page,
              this.session,
              navigationGeneration,
            );
            if (valueGenerationFailure !== undefined) return valueGenerationFailure;
            return { status: "failed", errorCode: "ActionValueUnavailable" };
          }
          const valueGenerationFailure = navigationGenerationFailure(
            page,
            this.session,
            navigationGeneration,
          );
          if (valueGenerationFailure !== undefined) return valueGenerationFailure;
          signal?.throwIfAborted();
          const guardFailure = this.guardElementAction(
            page,
            action.graphId,
            actionTarget.nodeId,
            descriptor,
            navigationGeneration,
          );
          if (guardFailure !== undefined) return guardFailure;
          const sensitiveEvidence = this.session.prepareSensitiveEvidenceRecord({
            navigationGeneration,
            nodeId: actionTarget.nodeId,
            sourceValue: value,
          });
          this.session.beginSensitiveEvidenceDispatch(sensitiveEvidence);
          if (action.kind === "input") {
            const dispatchGenerationFailure = navigationGenerationFailure(
              page,
              this.session,
              navigationGeneration,
            );
            if (dispatchGenerationFailure !== undefined) {
              this.session.cancelSensitiveEvidenceDispatch(sensitiveEvidence);
              return dispatchGenerationFailure;
            }
            try {
              const startedEpoch = await beginPageSensitiveActionEpoch(locator, sensitiveEvidence, "input", value);
              if (startedEpoch?.status === "failed") {
                await endPageSensitiveActionEpoch(
                  locator,
                  sensitiveEvidence,
                  "input",
                  false,
                ).catch(() => undefined);
                this.session.abandonSensitiveEvidenceDispatch(sensitiveEvidence);
                throw new WebTargetError(
                  "SensitiveEvidenceUnavailable",
                  "Sensitive target evidence could not be proven.",
                );
              }
              this.session.invalidateObservations();
              let epochResult: PageSensitiveEpochResult | undefined;
              try {
                permit.assertAuthorizedForDispatch(signal, () => dispatchSnapshot(this.session));
                await locator.fill(value, { timeout: this.session.actionTimeoutMs });
                await settleSensitiveSchedulerCallbacks(page);
              } finally {
                epochResult = await endPageSensitiveActionEpoch(
                  locator,
                  sensitiveEvidence,
                  "input",
                  permit.dispatchStarted,
                );
              }
              if (epochResult?.status === "failed") {
                this.session.abandonSensitiveEvidenceDispatch(sensitiveEvidence);
              } else {
                await this.completeInputSensitiveEvidence(page, locator, sensitiveEvidence, epochResult?.maskIds ?? []);
              }
            } catch (error) {
              if (permit.dispatchStarted) {
                this.session.abandonSensitiveEvidenceDispatch(sensitiveEvidence);
              } else {
                this.session.cancelSensitiveEvidenceDispatch(sensitiveEvidence);
              }
              throw error;
            }
          } else {
            const dispatchGenerationFailure = navigationGenerationFailure(
              page,
              this.session,
              navigationGeneration,
            );
            if (dispatchGenerationFailure !== undefined) {
              this.session.cancelSensitiveEvidenceDispatch(sensitiveEvidence);
              return dispatchGenerationFailure;
            }
            try {
              const startedEpoch = await beginPageSensitiveActionEpoch(locator, sensitiveEvidence, "select", value);
              if (startedEpoch?.status === "failed") {
                await endPageSensitiveActionEpoch(
                  locator,
                  sensitiveEvidence,
                  "select",
                  false,
                ).catch(() => undefined);
                this.session.abandonSensitiveEvidenceDispatch(sensitiveEvidence);
                throw new WebTargetError(
                  "SensitiveEvidenceUnavailable",
                  "Sensitive target evidence could not be proven.",
                );
              }
              this.session.invalidateObservations();
              let epochResult: PageSensitiveEpochResult | undefined;
              try {
                permit.assertAuthorizedForDispatch(signal, () => dispatchSnapshot(this.session));
                await locator.selectOption(value, { timeout: this.session.actionTimeoutMs });
                await settleSensitiveSchedulerCallbacks(page);
              } finally {
                epochResult = await endPageSensitiveActionEpoch(
                  locator,
                  sensitiveEvidence,
                  "select",
                  permit.dispatchStarted,
                );
              }
              if (epochResult?.status === "failed") {
                this.session.abandonSensitiveEvidenceDispatch(sensitiveEvidence);
              } else {
                await this.completeSelectSensitiveEvidence(page, locator, sensitiveEvidence, epochResult?.maskIds ?? []);
              }
            } catch (error) {
              if (permit.dispatchStarted) {
                this.session.abandonSensitiveEvidenceDispatch(sensitiveEvidence);
              } else {
                this.session.cancelSensitiveEvidenceDispatch(sensitiveEvidence);
              }
              throw error;
            }
          }
        } else if (action.kind === "click") {
          const guardFailure = this.guardElementAction(
            page,
            action.graphId,
            actionTarget.nodeId,
            descriptor,
            navigationGeneration,
          );
          if (guardFailure !== undefined) return guardFailure;
          this.session.invalidateObservations();
          const dispatchGenerationFailure = navigationGenerationFailure(
            page,
            this.session,
            navigationGeneration,
          );
          if (dispatchGenerationFailure !== undefined) return dispatchGenerationFailure;
          permit.assertAuthorizedForDispatch(signal, () => dispatchSnapshot(this.session));
          await locator.click({ timeout: this.session.actionTimeoutMs });
        } else if (action.kind === "scroll") {
          const guardFailure = this.guardElementAction(
            page,
            action.graphId,
            actionTarget.nodeId,
            descriptor,
            navigationGeneration,
          );
          if (guardFailure !== undefined) return guardFailure;
          this.session.invalidateObservations();
          const distance = action.amount === "page" ? 1 : 0.25;
          const dispatchGenerationFailure = navigationGenerationFailure(
            page,
            this.session,
            navigationGeneration,
          );
          if (dispatchGenerationFailure !== undefined) return dispatchGenerationFailure;
          permit.assertAuthorizedForDispatch(signal, () => dispatchSnapshot(this.session));
          await locator.evaluate((element, options) => {
            element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
            const horizontal = options.direction === "left" || options.direction === "right";
            const sign = options.direction === "up" || options.direction === "left" ? -1 : 1;
            window.scrollBy({
              left: horizontal ? window.innerWidth * options.distance * sign : 0,
              top: horizontal ? 0 : window.innerHeight * options.distance * sign,
              behavior: "instant",
            });
          }, {
            direction: action.direction,
            distance,
          });
        } else {
          return { status: "failed", errorCode: "UnsupportedAction" };
        }
      } catch (error) {
        if (permit.dispatchStarted) {
          return { status: "failed", errorCode: "ActionOutcomeUnknown" };
        }
        throw error;
      }

      return hasKnownActionOutcome(page, this.session, permit)
        ? { status: "ok" }
        : { status: "failed", errorCode: "ActionOutcomeUnknown" };
    });
  }

  private async completeInputSensitiveEvidence(
    page: Page,
    locator: Locator,
    prepared: PreparedSensitiveEvidenceRecord,
    maskIds: readonly string[],
  ): Promise<void> {
    try {
      await markSensitiveTarget(locator, prepared.markerId);
      const observed = await readInputSensitiveForms(locator);
      if (!observed.sensitiveTargetIds.includes(prepared.markerId)) {
        this.session.markSensitiveEvidenceUnavailable();
        return;
      }
      const maskSnapshot = await collectSensitiveMaskSnapshot(page, prepared.markerId, maskIds);
      this.session.completeSensitiveEvidenceRecord(prepared, sensitiveInputForms(observed.value), maskSnapshot);
    } catch {
      this.session.markSensitiveEvidenceUnavailable();
    }
  }

  private async completeSelectSensitiveEvidence(
    page: Page,
    locator: Locator,
    prepared: PreparedSensitiveEvidenceRecord,
    maskIds: readonly string[],
  ): Promise<void> {
    try {
      await markSensitiveTarget(locator, prepared.markerId);
      const observed = await readSelectSensitiveForms(locator);
      if (!observed.sensitiveTargetIds.includes(prepared.markerId)) {
        this.session.markSensitiveEvidenceUnavailable();
        return;
      }
      const maskSnapshot = await collectSensitiveMaskSnapshot(page, prepared.markerId, maskIds);
      this.session.completeSensitiveEvidenceRecord(prepared, [
        observed.value,
        observed.selectedOptionValue,
        observed.selectedOptionText,
      ], maskSnapshot);
    } catch {
      this.session.markSensitiveEvidenceUnavailable();
    }
  }

  private guardPageAction(
    page: { url(): string },
    graphId: string,
    navigationGeneration: number,
  ): ActionOutcome | undefined {
    const originFailure = navigationGenerationFailure(
      page,
      this.session,
      navigationGeneration,
    );
    if (originFailure !== undefined) return originFailure;
    try {
      this.session.assertObservationGeneration(graphId, navigationGeneration);
    } catch (error) {
      return {
        status: "failed",
        errorCode: error instanceof WebTargetError && error.code === "OriginViolation"
          ? "OriginViolation"
          : "StaleObservation",
      };
    }
    return undefined;
  }

  private guardElementAction(
    page: { url(): string },
    graphId: string,
    nodeId: string,
    descriptor: LocatorDescriptor,
    navigationGeneration: number,
  ): ActionOutcome | undefined {
    const pageFailure = this.guardPageAction(page, graphId, navigationGeneration);
    if (pageFailure !== undefined) return pageFailure;
    if (this.session.descriptorFor(graphId, nodeId) !== descriptor) {
      return { status: "failed", errorCode: "StaleObservation" };
    }
    return undefined;
  }
}

function isSafeTargetUrl(url: string, session: PlaywrightBrowserSession): boolean {
  try {
    const parsed = new URL(url);
    return parsed.username === "" && parsed.password === "" && session.isTargetOrigin(parsed.href);
  } catch {
    return false;
  }
}

function targetOriginFailure(
  page: { url(): string },
  session: PlaywrightBrowserSession,
): ActionOutcome | undefined {
  try {
    session.assertPageTargetOrigin(page);
    return undefined;
  } catch {
    return { status: "failed", errorCode: "OriginViolation" };
  }
}

function hasTargetOrigin(
  page: { url(): string },
  session: PlaywrightBrowserSession,
): boolean {
  return targetOriginFailure(page, session) === undefined;
}

function dispatchSnapshot(session: PlaywrightBrowserSession): {
  readonly crossOriginNavigationCount: number;
} {
  return { crossOriginNavigationCount: session.currentCrossOriginNavigationCount };
}

function hasKnownActionOutcome(
  page: { url(): string },
  session: PlaywrightBrowserSession,
  permit: ExecutionPermit,
): boolean {
  return hasTargetOrigin(page, session) &&
    permit.dispatchSnapshot?.crossOriginNavigationCount ===
      session.currentCrossOriginNavigationCount;
}

function navigationGenerationFailure(
  page: { url(): string },
  session: PlaywrightBrowserSession,
  navigationGeneration: number,
): ActionOutcome | undefined {
  try {
    session.assertPageTargetOrigin(page, navigationGeneration);
    return undefined;
  } catch {
    return { status: "failed", errorCode: "OriginViolation" };
  }
}

type PageSensitiveEpochResult =
  | { readonly status: "ok"; readonly maskIds?: readonly string[] }
  | { readonly status: "failed" };

async function collectSensitiveMaskSnapshot(
  page: Page,
  markerId: string,
  maskIds: readonly string[],
): Promise<readonly SensitiveMaskSnapshotEntry[]> {
  if (maskIds.length === 0 || maskIds.length > MAX_REFLECTED_REGIONS) {
    throw new Error("Sensitive mask snapshot is unavailable.");
  }
  if (maskIds.some((maskId) => !/^[A-Za-z0-9_-]+$/.test(maskId))) {
    throw new Error("Sensitive mask snapshot is invalid.");
  }
  let cdp: CDPSession | undefined;
  try {
    cdp = await page.context().newCDPSession(page);
    await cdp.send("DOM.enable");
    await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    const entries: SensitiveMaskSnapshotEntry[] = [];
    const seenMaskIds = new Set<string>();
    const _forOfItems1 = maskIds;
    for (let _forOfIndex1 = 0; _forOfIndex1 < _forOfItems1.length; _forOfIndex1 += 1) {
      const maskId = _forOfItems1[_forOfIndex1]!;
      if (seenMaskIds.has(maskId)) throw new Error("Sensitive mask snapshot is incomplete.");
      seenMaskIds.add(maskId);
      const nodeId = await uniqueCdpNodeIdForMask(cdp, maskId);
      // A classified element may legitimately be hidden until the observer's
      // pre-screenshot revalidation. Backend identity is authoritative here;
      // renderability is checked by the CDP geometry pass immediately before
      // the screenshot, where one full recapture remains available for a race.
      const described = await cdp.send("DOM.describeNode", { nodeId }) as {
        readonly node?: { readonly backendNodeId?: number };
      };
      const backendNodeId = described.node?.backendNodeId;
      if (typeof backendNodeId !== "number" || !Number.isSafeInteger(backendNodeId)) {
        throw new Error("Sensitive mask backend node is unavailable.");
      }
      entries[entries.length] = { markerId, maskId, backendNodeId };
    }
    if (entries.length !== maskIds.length) {
      throw new Error("Sensitive mask snapshot is incomplete.");
    }
    return entries;
  } finally {
    await cdp?.detach().catch(() => undefined);
  }
}

async function uniqueCdpNodeIdForMask(cdp: CDPSession, maskId: string): Promise<number> {
  const search = await cdp.send("DOM.performSearch", {
    query: `[${SENSITIVE_MASK_ID_ATTRIBUTE}="${maskId}"]`,
    includeUserAgentShadowDOM: true,
  }) as { readonly searchId?: string; readonly resultCount?: number };
  const searchId = search.searchId;
  const resultCount = search.resultCount;
  if (typeof searchId !== "string") {
    throw new Error("Sensitive mask node is unavailable.");
  }
  try {
    if (resultCount !== 1) {
      throw new Error("Sensitive mask node is unavailable.");
    }
    const results = await cdp.send("DOM.getSearchResults", {
      searchId,
      fromIndex: 0,
      toIndex: 1,
    }) as { readonly nodeIds?: readonly number[] };
    const nodeId = results.nodeIds?.[0];
    if (typeof nodeId !== "number" || !Number.isSafeInteger(nodeId)) {
      throw new Error("Sensitive mask node is unavailable.");
    }
    return nodeId;
  } finally {
    await cdp.send("DOM.discardSearchResults", { searchId }).catch(() => undefined);
  }
}

async function settleSensitiveSchedulerCallbacks(page: { waitForTimeout?: (timeout: number) => Promise<unknown> }): Promise<void> {
  await page.waitForTimeout?.(25);
}

async function beginPageSensitiveActionEpoch(
  locator: Locator,
  prepared: PreparedSensitiveEvidenceRecord,
  kind: "input" | "select",
  sourceValue: string,
): Promise<PageSensitiveEpochResult> {
  return locator.evaluate((element, input): PageSensitiveEpochResult => {
    type BrowserSensitiveState = {
      active?: BrowserSensitiveEpoch | null;
      records: BrowserSensitiveRecord[];
      poisoned: boolean;
      nextNodeOrdinal: number;
      nextMaskOrdinal: number;
      schedulerSessionRegistrations: number;
      retainedSchedulerEpochs?: BrowserSensitiveEpoch[];
    };
    type BrowserSensitiveEpoch = {
      markerId: string;
      forms: string[];
      mutationOrdinal: number;
      deferredRecords: MutationRecord[];
      classifiedNodes: string[];
      classifiedRegions: string[];
      classifiedElements: Element[];
      baseline: WeakMap<Element, readonly string[]>;
      shadowBaseline: WeakMap<Node, readonly string[]>;
      observer: MutationObserver;
      processSchedulerCallback?: () => void;
      targetCaptureListener: EventListener;
      documentBubbleListener: EventListener;
      hasDelegatedListener: boolean;
      inTargetDispatch: boolean;
      inSchedulerCallback: boolean;
      schedulerRegistrations: number;
      poisoned: boolean;
    };
    type BrowserSensitiveRecord = {
      markerId: string;
      forms: string[];
      baseline: WeakMap<Element, readonly string[]>;
      shadowBaseline: WeakMap<Node, readonly string[]>;
      classifiedNodes: string[];
      classifiedRegions: string[];
      classifiedElements: Element[];
      classifiedMaskIds?: string[];
      schedulerRegistrations: number;
      poisoned: boolean;
      observer?: MutationObserver;
    };
    type NativeDomAuthority = {
      readonly arrayFrom: typeof Array.from;
      readonly arrayIsArray: typeof Array.isArray;
      readonly htmlCollectionItem: (index: number) => Element | null;
      readonly htmlCollectionLengthGet: (() => number) | undefined;
      readonly htmlOptionsCollectionItem: (index: number) => HTMLOptionElement | null;
      readonly htmlOptionsCollectionLengthGet: (() => number) | undefined;
      readonly nodeListItem: (index: number) => Node | null;
      readonly nodeListLengthGet: (() => number) | undefined;
      readonly objectDefineProperty: typeof Object.defineProperty;
      readonly reflectApply: typeof Reflect.apply;
      readonly stringIncludes: typeof String.prototype.includes;
      readonly stringNormalize: typeof String.prototype.normalize;
      readonly stringReplace: typeof String.prototype.replace;
      readonly stringToLowerCase: typeof String.prototype.toLowerCase;
      readonly stringTrim: typeof String.prototype.trim;
      readonly weakMap: WeakMapConstructor;
      readonly weakMapGet: typeof WeakMap.prototype.get;
      readonly weakMapSet: typeof WeakMap.prototype.set;
      readonly documentQuerySelectorAll: typeof Document.prototype.querySelectorAll;
      readonly documentFragmentQuerySelectorAll: typeof DocumentFragment.prototype.querySelectorAll;
      readonly elementGetAttribute: typeof Element.prototype.getAttribute;
      readonly elementHasAttribute: typeof Element.prototype.hasAttribute;
      readonly elementQuerySelectorAll: typeof Element.prototype.querySelectorAll;
      readonly elementSetAttribute: typeof Element.prototype.setAttribute;
      readonly elementShadowRootGet: (() => ShadowRoot | null) | undefined;
      readonly elementTagNameGet: (() => string) | undefined;
      readonly htmlInputElementPlaceholderGet: (() => string) | undefined;
      readonly htmlInputElementValueGet: (() => string) | undefined;
      readonly htmlOptionElementLabelGet: (() => string) | undefined;
      readonly htmlOptionElementTextGet: (() => string) | undefined;
      readonly htmlOptionElementValueGet: (() => string) | undefined;
      readonly htmlSelectElementOptionsGet: (() => HTMLOptionsCollection) | undefined;
      readonly htmlSelectElementSelectedOptionsGet: (() => HTMLCollectionOf<HTMLOptionElement>) | undefined;
      readonly htmlSelectElementValueGet: (() => string) | undefined;
      readonly htmlTextAreaElementPlaceholderGet: (() => string) | undefined;
      readonly htmlTextAreaElementValueGet: (() => string) | undefined;
      readonly nodeChildNodesGet: (() => NodeListOf<ChildNode>) | undefined;
      readonly nodeContains: typeof Node.prototype.contains;
      readonly nodeGetRootNode: typeof Node.prototype.getRootNode;
      readonly nodeParentElementGet: (() => HTMLElement | null) | undefined;
      readonly nodeTextContentGet: (() => string | null) | undefined;
      readonly characterDataDataGet: (() => string) | undefined;
      readonly shadowRootHostGet: (() => Element) | undefined;
      readonly shadowRootModeGet: (() => ShadowRootMode) | undefined;
    };

    const win = element.ownerDocument.defaultView;
    if (win === null) return { status: "failed" };
    const maybeDom = nativeDomAuthority();
    if (maybeDom === undefined) return { status: "failed" };
    const dom: NativeDomAuthority = maybeDom;
    const stateHost = win as unknown as Record<string, BrowserSensitiveState | undefined>;
    const existing = stateHost[input.stateProperty];
    const state: BrowserSensitiveState = existing ?? {
      active: null,
      records: [],
      poisoned: false,
      nextNodeOrdinal: 0,
      nextMaskOrdinal: 0,
      schedulerSessionRegistrations: 0,
    };
    state.schedulerSessionRegistrations ??= 0;
    if (existing === undefined) {
      dom.reflectApply(dom.objectDefineProperty, Object, [stateHost, input.stateProperty, {
        configurable: false,
        enumerable: false,
        value: state,
        writable: false,
      }]);
    } else if (existing !== state) {
      return { status: "failed" };
    }
    if (state.active !== null && state.active !== undefined) {
      state.poisoned = true;
      return { status: "failed" };
    }
    if (shadowRootAuthorityUnavailable()) {
      return { status: "failed" };
    }

    const forms = reflectedCandidateForms(element, input.kind, input.sourceValue);
    const baseline = baselineSensitiveForms(element.ownerDocument, forms);
    const shadowBaseline = baselineShadowSensitiveForms(forms);
    let epoch: BrowserSensitiveEpoch | undefined;
    const observer = new MutationObserver((records) => {
      const active = state.active === epoch
        ? epoch
        : epoch?.inSchedulerCallback === true
          ? epoch
          : undefined;
      if (active === undefined) return;
      if (active.inTargetDispatch) {
        appendArray(active.deferredRecords, records);
        return;
      }
      processMutationRecords(active, records, active.inSchedulerCallback === true);
    });
    const noteTargetDispatch = (): void => {
      const active = state.active;
      if (active === null || active === undefined) return;
      active.inTargetDispatch = true;
    };
    const finishTargetDispatch = (): void => {
      const active = state.active;
      if (active === null || active === undefined) return;
      const allowClassification = canClassifyCurrentDispatch(active);
      processCurrentSensitiveMatches(active, allowClassification);
      if (!active.poisoned) {
        const records = cloneArray(active.deferredRecords);
        appendArray(records, active.observer.takeRecords());
        active.deferredRecords = [];
        processMutationRecords(active, records, allowClassification);
      }
      active.inTargetDispatch = false;
    };
    markInstrumentationListener(noteTargetDispatch);
    markInstrumentationListener(finishTargetDispatch);
    const activeEpoch: BrowserSensitiveEpoch = {
      markerId: input.markerId,
      forms,
      mutationOrdinal: 0,
      deferredRecords: [],
      classifiedNodes: [],
      classifiedRegions: [],
      classifiedElements: [],
      baseline,
      shadowBaseline,
      observer,
      targetCaptureListener: noteTargetDispatch,
      documentBubbleListener: finishTargetDispatch,
      hasDelegatedListener: hasDelegatedListener(input.kind),
      inTargetDispatch: false,
      inSchedulerCallback: false,
      schedulerRegistrations: 0,
      poisoned: false,
    };
    activeEpoch.processSchedulerCallback = () => {
      if (shadowRootOverflow()) {
        poison(activeEpoch);
        return;
      }
      processCurrentSensitiveMatches(activeEpoch, true);
      if (activeEpoch.poisoned) return;
      const records = cloneArray(activeEpoch.deferredRecords);
      appendArray(records, activeEpoch.observer.takeRecords());
      activeEpoch.deferredRecords = [];
      processMutationRecords(activeEpoch, records, true);
    };
    epoch = activeEpoch;
    state.active = activeEpoch;
    classifyElement(element, activeEpoch);
    observeSensitiveMutations(observer, element.ownerDocument);
    // A pre-existing discovery overflow poisons evidence, not the native
    // action. Its known bounded root snapshot remains observable so the page
    // keeps normal callback/observer behavior.
    const observedShadowRoots = shadowRoots();
    for (let index = 0; index < observedShadowRoots.length; index += 1) {
      observeSensitiveMutations(observer, observedShadowRoots[index]!);
    }
    element.addEventListener("input", activeEpoch.targetCaptureListener, true);
    element.addEventListener("change", activeEpoch.targetCaptureListener, true);
    element.ownerDocument.addEventListener("input", activeEpoch.documentBubbleListener, false);
    element.ownerDocument.addEventListener("change", activeEpoch.documentBubbleListener, false);
    return { status: "ok" };

    function observeSensitiveMutations(observerToUse: MutationObserver, target: Node): void {
      try {
        observerToUse.observe(target, {
          attributes: true,
          characterData: true,
          childList: true,
          subtree: true,
        });
      } catch {
        state.poisoned = true;
      }
    }

    function nativeDomAuthority(): NativeDomAuthority | undefined {
      const registry = (win as unknown as Record<string, { readonly nativeDom?: NativeDomAuthority } | undefined>)[input.runtimeRegistryProperty];
      const candidate = registry?.nativeDom;
      if (candidate === undefined) return undefined;
      const required = [
        candidate.arrayFrom,
        candidate.arrayIsArray,
        candidate.htmlCollectionItem,
        candidate.htmlCollectionLengthGet,
        candidate.htmlOptionsCollectionItem,
        candidate.htmlOptionsCollectionLengthGet,
        candidate.nodeListItem,
        candidate.nodeListLengthGet,
        candidate.objectDefineProperty,
        candidate.reflectApply,
        candidate.stringIncludes,
        candidate.stringNormalize,
        candidate.stringReplace,
        candidate.stringToLowerCase,
        candidate.stringTrim,
        candidate.weakMap,
        candidate.weakMapGet,
        candidate.weakMapSet,
        candidate.documentQuerySelectorAll,
        candidate.documentFragmentQuerySelectorAll,
        candidate.elementGetAttribute,
        candidate.elementHasAttribute,
        candidate.elementQuerySelectorAll,
        candidate.elementSetAttribute,
        candidate.elementShadowRootGet,
        candidate.elementTagNameGet,
        candidate.htmlInputElementPlaceholderGet,
        candidate.htmlInputElementValueGet,
        candidate.htmlOptionElementLabelGet,
        candidate.htmlOptionElementTextGet,
        candidate.htmlOptionElementValueGet,
        candidate.htmlSelectElementOptionsGet,
        candidate.htmlSelectElementSelectedOptionsGet,
        candidate.htmlSelectElementValueGet,
        candidate.htmlTextAreaElementPlaceholderGet,
        candidate.htmlTextAreaElementValueGet,
        candidate.nodeChildNodesGet,
        candidate.nodeContains,
        candidate.nodeGetRootNode,
        candidate.nodeParentElementGet,
        candidate.nodeTextContentGet,
        candidate.characterDataDataGet,
        candidate.shadowRootHostGet,
        candidate.shadowRootModeGet,
      ];
      for (let index = 0; index < required.length; index += 1) {
        if (typeof required[index] !== "function") return undefined;
      }
      return candidate;
    }

    function apply<T>(fn: (...args: never[]) => T, receiver: unknown, args: readonly unknown[] = []): T {
      return dom.reflectApply(fn, receiver, args as never[]) as T;
    }

    function stringIncludes(value: string, search: string): boolean {
      return apply(dom.stringIncludes as (...args: never[]) => boolean, value, [search]);
    }

    function stringNormalize(value: string, form: string): string {
      return apply(dom.stringNormalize as (...args: never[]) => string, value, [form]);
    }

    function stringToLowerCase(value: string): string {
      return apply(dom.stringToLowerCase as (...args: never[]) => string, value);
    }

    function stringTrim(value: string): string {
      return apply(dom.stringTrim as (...args: never[]) => string, value);
    }

    function assertCollectionLength(length: unknown): number {
      if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
        throw new Error("Untrusted DOM collection length.");
      }
      return length;
    }

    function nodeListToArray<T extends Node>(items: NodeList): T[] {
      const length = assertCollectionLength(apply(dom.nodeListLengthGet!, items));
      const result: T[] = [];
      for (let index = 0; index < length; index += 1) {
        const item = apply(dom.nodeListItem, items, [index]);
        if (item === null) throw new Error("Untrusted NodeList item.");
        result[index] = item as T;
      }
      return result;
    }

    function htmlCollectionToArray<T extends Element>(items: HTMLCollectionOf<T>): T[] {
      const length = assertCollectionLength(apply(dom.htmlCollectionLengthGet!, items));
      const result: T[] = [];
      for (let index = 0; index < length; index += 1) {
        const item = apply(dom.htmlCollectionItem, items, [index]);
        if (item === null) throw new Error("Untrusted HTMLCollection item.");
        result[index] = item as T;
      }
      return result;
    }

    function htmlOptionsCollectionToArray(items: HTMLOptionsCollection): HTMLOptionElement[] {
      const length = assertCollectionLength(apply(dom.htmlOptionsCollectionLengthGet!, items));
      const result: HTMLOptionElement[] = [];
      for (let index = 0; index < length; index += 1) {
        const item = apply(dom.htmlOptionsCollectionItem, items, [index]);
        if (item === null) throw new Error("Untrusted HTMLOptionsCollection item.");
        result[index] = item;
      }
      return result;
    }

    function createWeakMap<K extends object, V>(): WeakMap<K, V> {
      return new dom.weakMap<K, V>();
    }

    function weakMapGet<K extends object, V>(map: WeakMap<K, V>, key: K): V | undefined {
      return apply(dom.weakMapGet as (...args: never[]) => V | undefined, map, [key]);
    }

    function weakMapSet<K extends object, V>(map: WeakMap<K, V>, key: K, value: V): void {
      apply(dom.weakMapSet as (...args: never[]) => WeakMap<K, V>, map, [key, value]);
    }

    function queryDocument(selector: string): Element[] {
      return nodeListToArray(apply(dom.documentQuerySelectorAll, element.ownerDocument, [selector]));
    }

    function queryRoot(root: ShadowRoot, selector: string): Element[] {
      return nodeListToArray(apply(dom.documentFragmentQuerySelectorAll, root, [selector]));
    }

    function queryDescendants(candidate: Element): Element[] {
      return nodeListToArray(apply(dom.elementQuerySelectorAll, candidate, ["*"]));
    }

    function getAttribute(candidate: Element, name: string): string | null {
      return apply(dom.elementGetAttribute, candidate, [name]);
    }

    function hasAttribute(candidate: Element, name: string): boolean {
      return apply(dom.elementHasAttribute, candidate, [name]);
    }

    function setAttribute(candidate: Element, name: string, value: string): void {
      apply(dom.elementSetAttribute, candidate, [name, value]);
    }

    function tagName(candidate: Element): string {
      return stringToLowerCase(apply(dom.elementTagNameGet!, candidate));
    }

    function childNodes(node: Node): ChildNode[] {
      return nodeListToArray(apply(dom.nodeChildNodesGet!, node));
    }

    function textContent(node: Node): string {
      return apply(dom.nodeTextContentGet!, node) ?? "";
    }

    function textData(node: Text): string {
      return apply(dom.characterDataDataGet!, node);
    }

    function getRootNode(node: Node): Node {
      return apply(dom.nodeGetRootNode, node);
    }

    function parentElement(node: Node): Element | null {
      return apply(dom.nodeParentElementGet!, node);
    }

    function contains(parent: Node, child: Node): boolean {
      return apply(dom.nodeContains, parent, [child]);
    }

    function shadowRoot(candidate: Element): ShadowRoot | null {
      return apply(dom.elementShadowRootGet!, candidate);
    }

    function shadowRootMode(root: ShadowRoot): ShadowRootMode {
      return apply(dom.shadowRootModeGet!, root);
    }

    function shadowRootHost(root: ShadowRoot): Element {
      return apply(dom.shadowRootHostGet!, root);
    }

    function inputValue(candidate: Element): string {
      return apply(dom.htmlInputElementValueGet!, candidate);
    }

    function inputPlaceholder(candidate: Element): string {
      return apply(dom.htmlInputElementPlaceholderGet!, candidate);
    }

    function textareaValue(candidate: Element): string {
      return apply(dom.htmlTextAreaElementValueGet!, candidate);
    }

    function textareaPlaceholder(candidate: Element): string {
      return apply(dom.htmlTextAreaElementPlaceholderGet!, candidate);
    }

    function selectValue(candidate: Element): string {
      return apply(dom.htmlSelectElementValueGet!, candidate);
    }

    function selectOptions(candidate: Element): HTMLOptionElement[] {
      return htmlOptionsCollectionToArray(apply(dom.htmlSelectElementOptionsGet!, candidate));
    }

    function selectedOptions(candidate: Element): HTMLOptionElement[] {
      return htmlCollectionToArray(apply(dom.htmlSelectElementSelectedOptionsGet!, candidate));
    }

    function firstSelectedOption(candidate: Element): HTMLOptionElement | undefined {
      const selected = apply(dom.htmlSelectElementSelectedOptionsGet!, candidate);
      const length = assertCollectionLength(apply(dom.htmlCollectionLengthGet!, selected));
      if (length < 1) return undefined;
      return (apply(dom.htmlCollectionItem, selected, [0]) as HTMLOptionElement | null) ?? undefined;
    }

    function optionValue(option: HTMLOptionElement): string {
      return apply(dom.htmlOptionElementValueGet!, option);
    }

    function optionText(option: HTMLOptionElement): string {
      return apply(dom.htmlOptionElementTextGet!, option);
    }

    function optionLabel(option: HTMLOptionElement): string {
      return apply(dom.htmlOptionElementLabelGet!, option);
    }

    function isElementNode(node: Node): node is Element {
      return node.nodeType === 1;
    }

    function isShadowRootNode(node: unknown): node is ShadowRoot {
      return typeof (node as { readonly nodeType?: unknown }).nodeType === "number" &&
        (node as { readonly nodeType: number }).nodeType === 11 &&
        "host" in (node as object);
    }

    function isTextNode(node: Node): node is Text {
      return node.nodeType === 3;
    }

    function arrayHasString(values: readonly string[], candidate: string): boolean {
      const _forOfItems2 = values;
      for (let _forOfIndex2 = 0; _forOfIndex2 < _forOfItems2.length; _forOfIndex2 += 1) {
        const value = _forOfItems2[_forOfIndex2]!;
        if (value === candidate) return true;
      }
      return false;
    }

    function arrayHasIdentity<T>(values: readonly T[], candidate: T): boolean {
      const _forOfItems3 = values;
      for (let _forOfIndex3 = 0; _forOfIndex3 < _forOfItems3.length; _forOfIndex3 += 1) {
        const value = _forOfItems3[_forOfIndex3]!;
        if (value === candidate) return true;
      }
      return false;
    }

    function pushUniqueNonEmpty(values: string[], candidate: string): void {
      if (candidate !== "" && !arrayHasString(values, candidate)) values[values.length] = candidate;
    }

    function appendArray<T>(target: T[], items: readonly T[]): void {
      for (let index = 0; index < items.length; index += 1) {
        target[target.length] = items[index]!;
      }
    }

    function cloneArray<T>(items: readonly T[]): T[] {
      const result: T[] = [];
      appendArray(result, items);
      return result;
    }

    function baselineContainsAll(baseline: readonly string[] | undefined, matches: readonly string[]): boolean {
      if (baseline === undefined) return false;
      const _forOfItems4 = matches;
      for (let _forOfIndex4 = 0; _forOfIndex4 < _forOfItems4.length; _forOfIndex4 += 1) {
        const value = _forOfItems4[_forOfIndex4]!;
        if (!arrayHasString(baseline, value)) return false;
      }
      return true;
    }

    function reflectedCandidateForms(target: Element, actionKind: "input" | "select", source: string): string[] {
      const values: string[] = [];
      pushUniqueNonEmpty(values, source);
      if (actionKind === "input") {
        const browserValue = normalizeBrowserLineBreaks(source);
        pushUniqueNonEmpty(values, browserValue);
        pushUniqueNonEmpty(values, normalizeVisibleSensitiveForm(browserValue));
      }
      if (actionKind === "select" && tagName(target) === "select") {
        const _forOfItems5 = selectOptions(target);
        for (let _forOfIndex5 = 0; _forOfIndex5 < _forOfItems5.length; _forOfIndex5 += 1) {
          const option = _forOfItems5[_forOfIndex5]!;
          if (optionValue(option) === source || optionText(option) === source || optionLabel(option) === source) {
            pushUniqueNonEmpty(values, optionValue(option));
            pushUniqueNonEmpty(values, optionText(option));
            pushUniqueNonEmpty(values, optionLabel(option));
          }
        }
      }
      return values;
    }
    function baselineSensitiveForms(document: Document, formsToMatch: readonly string[]): WeakMap<Element, readonly string[]> {
      const result = createWeakMap<Element, readonly string[]>();
      void document;
      const _forOfItems6 = observableElements();
      for (let _forOfIndex6 = 0; _forOfIndex6 < _forOfItems6.length; _forOfIndex6 += 1) {
        const candidate = _forOfItems6[_forOfIndex6]!;
        const matches: string[] = [];
        const _forOfItems7 = sensitiveValues(candidate);
        for (let _forOfIndex7 = 0; _forOfIndex7 < _forOfItems7.length; _forOfIndex7 += 1) {
          const value = _forOfItems7[_forOfIndex7]!;
          const _forOfItems8 = formsToMatch;
          for (let _forOfIndex8 = 0; _forOfIndex8 < _forOfItems8.length; _forOfIndex8 += 1) {
            const form = _forOfItems8[_forOfIndex8]!;
            if (carriesForm(value, form)) pushUniqueNonEmpty(matches, value);
          }
        }
        if (matches.length > 0) weakMapSet(result, candidate, matches);
      }
      return result;
    }

    function baselineShadowSensitiveForms(formsToMatch: readonly string[]): WeakMap<Node, readonly string[]> {
      const result = createWeakMap<Node, readonly string[]>();
      const _forOfItems9 = shadowRoots();
      for (let _forOfIndex9 = 0; _forOfIndex9 < _forOfItems9.length; _forOfIndex9 += 1) {
        const root = _forOfItems9[_forOfIndex9]!;
        rememberSensitiveBaseline(result, root, shadowRootValues(root), formsToMatch);
        const _forOfItems10 = queryRoot(root, "*");
        for (let _forOfIndex10 = 0; _forOfIndex10 < _forOfItems10.length; _forOfIndex10 += 1) {
          const candidate = _forOfItems10[_forOfIndex10]!;
          rememberSensitiveBaseline(result, candidate, sensitiveValues(candidate), formsToMatch);
        }
      }
      return result;
    }

    function rememberSensitiveBaseline(
      result: WeakMap<Node, readonly string[]>,
      node: Node,
      values: readonly string[],
      formsToMatch: readonly string[],
    ): void {
      const matches: string[] = [];
      const _forOfItems11 = values;
      for (let _forOfIndex11 = 0; _forOfIndex11 < _forOfItems11.length; _forOfIndex11 += 1) {
        const value = _forOfItems11[_forOfIndex11]!;
        const _forOfItems12 = formsToMatch;
        for (let _forOfIndex12 = 0; _forOfIndex12 < _forOfItems12.length; _forOfIndex12 += 1) {
          const form = _forOfItems12[_forOfIndex12]!;
          if (carriesForm(value, form)) pushUniqueNonEmpty(matches, value);
        }
      }
      if (matches.length > 0) weakMapSet(result, node, matches);
    }

    function sensitiveMatches(candidate: Element, formsToMatch: readonly string[]): string[] {
      const matches: string[] = [];
      const _forOfItems13 = sensitiveValues(candidate);
      for (let _forOfIndex13 = 0; _forOfIndex13 < _forOfItems13.length; _forOfIndex13 += 1) {
        const value = _forOfItems13[_forOfIndex13]!;
        const _forOfItems14 = formsToMatch;
        for (let _forOfIndex14 = 0; _forOfIndex14 < _forOfItems14.length; _forOfIndex14 += 1) {
          const form = _forOfItems14[_forOfIndex14]!;
          if (carriesForm(value, form)) {
            matches[matches.length] = value;
            break;
          }
        }
      }
      return matches;
    }

    function canClassifyCurrentDispatch(epochToUpdate: BrowserSensitiveEpoch): boolean {
      epochToUpdate.hasDelegatedListener = epochToUpdate.hasDelegatedListener || hasDelegatedListener(input.kind);
      return epochToUpdate.inTargetDispatch && !epochToUpdate.hasDelegatedListener;
    }

    function hasDelegatedListener(eventType: "input" | "select"): boolean {
      const _forOfItems15 = sensitiveEventTypes(eventType);
      for (let _forOfIndex15 = 0; _forOfIndex15 < _forOfItems15.length; _forOfIndex15 += 1) {
        const listenerType = _forOfItems15[_forOfIndex15]!;
        if (hasDelegatedEventListener(listenerType) ||
          hasDelegatedEventHandlerProperty(listenerType)) {
          return true;
        }
      }
      return false;
    }

    function sensitiveEventTypes(eventType: "input" | "select"): readonly ("input" | "change")[] {
      return eventType === "select" ? ["input", "change"] : ["input"];
    }

    function hasDelegatedEventListener(listenerType: "input" | "change"): boolean {
      const registry = (win as unknown as Record<string, unknown>)[input.runtimeRegistryProperty] as {
        readonly listenerTargets?: readonly {
          readonly type?: unknown;
          readonly target?: unknown;
          readonly listener?: unknown;
        }[];
      } | undefined;
      const _forOfItems16 = registry?.listenerTargets ?? [];
      for (let _forOfIndex16 = 0; _forOfIndex16 < _forOfItems16.length; _forOfIndex16 += 1) {
        const entry = _forOfItems16[_forOfIndex16]!;
        if (entry.type !== listenerType) continue;
        if (isInstrumentationListener(entry.listener)) continue;
        if (isDelegatedEventTarget(entry.target)) return true;
      }
      return false;
    }

    function hasDelegatedEventHandlerProperty(listenerType: "input" | "change"): boolean {
      const handlerName = `on${listenerType}`;
      const _forOfItems17 = delegatedEventPathTargets();
      for (let _forOfIndex17 = 0; _forOfIndex17 < _forOfItems17.length; _forOfIndex17 += 1) {
        const target = _forOfItems17[_forOfIndex17]!;
        if (isEventElement(target) && hasAttribute(target, handlerName)) return true;

      }
      return false;
    }


    function markInstrumentationListener(listener: EventListener): void {
      apply(dom.objectDefineProperty, Object, [listener, "__qualigenceSensitiveInstrumentation", {
        configurable: false,
        enumerable: false,
        value: true,
        writable: false,
      }]);
    }

    function isInstrumentationListener(listener: unknown): boolean {
      return listener !== null &&
        (typeof listener === "function" || typeof listener === "object") &&
        (listener as Record<string, unknown>).__qualigenceSensitiveInstrumentation === true;
    }


    function delegatedEventPathTargets(): EventTarget[] {
      const targets: EventTarget[] = [];
      for (let current = parentElement(element); current !== null; current = parentElement(current)) {
        targets[targets.length] = current;
      }
      targets[targets.length] = element.ownerDocument;
      if (win !== null) targets[targets.length] = win;
      return targets;
    }

    function isDelegatedEventTarget(target: unknown): boolean {
      if (target === element) return false;
      if (target === win || target === element.ownerDocument) return true;
      return isNodeLike(target) && contains(target, element);
    }

    function processCurrentSensitiveMatches(
      epochToUpdate: BrowserSensitiveEpoch,
      allowClassification: boolean,
    ): void {
      if (shadowRootOverflow()) {
        poison(epochToUpdate);
        return;
      }
      const _forOfItems18 = observableElements();
      for (let _forOfIndex18 = 0; _forOfIndex18 < _forOfItems18.length; _forOfIndex18 += 1) {
        const candidate = _forOfItems18[_forOfIndex18]!;
        const matches = sensitiveMatches(candidate, epochToUpdate.forms);
        if (matches.length === 0) continue;
        if (isMarkedSensitive(candidate, epochToUpdate.markerId)) continue;
        if (baselineContainsAll(weakMapGet(epochToUpdate.baseline, candidate), matches)) {
          continue;
        }
        if (!allowClassification) {
          poison(epochToUpdate);
          return;
        }
        classifyElement(candidate, epochToUpdate);
        if (epochToUpdate.poisoned) return;
      }
      const _forOfItems19 = shadowRoots();
      for (let _forOfIndex19 = 0; _forOfIndex19 < _forOfItems19.length; _forOfIndex19 += 1) {
        const root = _forOfItems19[_forOfIndex19]!;
        const _forOfItems20 = shadowRootValues(root);
        for (let _forOfIndex20 = 0; _forOfIndex20 < _forOfItems20.length; _forOfIndex20 += 1) {
          const value = _forOfItems20[_forOfIndex20]!;
          if (!carriesForm(value, epochToUpdate.forms) || shadowBaselineAllows(root, epochToUpdate, value)) {
            continue;
          }
          if (shadowRootMode(root) === "open" && allowClassification) {
            classifyElement(shadowRootHost(root), epochToUpdate);
            if (epochToUpdate.poisoned) return;
            continue;
          }
          poison(epochToUpdate);
          return;
        }
        if (shadowRootMode(root) !== "closed") continue;
        const _forOfItems21 = queryRoot(root, "*");
        for (let _forOfIndex21 = 0; _forOfIndex21 < _forOfItems21.length; _forOfIndex21 += 1) {
          const candidate = _forOfItems21[_forOfIndex21]!;
          const _forOfItems22 = sensitiveValues(candidate);
          for (let _forOfIndex22 = 0; _forOfIndex22 < _forOfItems22.length; _forOfIndex22 += 1) {
            const value = _forOfItems22[_forOfIndex22]!;
            if (carriesForm(value, epochToUpdate.forms) && !shadowBaselineAllows(candidate, epochToUpdate, value)) {
              poison(epochToUpdate);
              return;
            }
          }
        }
      }
    }

    function processMutationRecords(
      epochToUpdate: BrowserSensitiveEpoch,
      records: readonly MutationRecord[],
      allowClassification: boolean,
    ): void {
      const applicationRecords: MutationRecord[] = [];
      const _forOfItems23 = records;
      for (let _forOfIndex23 = 0; _forOfIndex23 < _forOfItems23.length; _forOfIndex23 += 1) {
        const record = _forOfItems23[_forOfIndex23]!;
        if (record.type !== "attributes" || record.attributeName !== input.maskAttribute) {
          applicationRecords[applicationRecords.length] = record;
        }
      }
      epochToUpdate.mutationOrdinal += applicationRecords.length;
      if (epochToUpdate.mutationOrdinal > input.maxMutationRecords) {
        poison(epochToUpdate);
        return;
      }
      const _forOfItems24 = applicationRecords;
      for (let _forOfIndex24 = 0; _forOfIndex24 < _forOfItems24.length; _forOfIndex24 += 1) {
        const record = _forOfItems24[_forOfIndex24]!;
        if (touchesUnprovableShadowRoot(record)) {
          poison(epochToUpdate);
          return;
        }
        const _forOfItems25 = mutationCandidateElements(record);
        for (let _forOfIndex25 = 0; _forOfIndex25 < _forOfItems25.length; _forOfIndex25 += 1) {
          const candidate = _forOfItems25[_forOfIndex25]!;
          const matches = sensitiveMatches(candidate, epochToUpdate.forms);
          if (matches.length === 0) continue;
          if (isMarkedSensitive(candidate, epochToUpdate.markerId)) continue;
          if (baselineContainsAll(weakMapGet(epochToUpdate.baseline, candidate), matches)) {
            continue;
          }
          if (!allowClassification) {
            poison(epochToUpdate);
            return;
          }
          classifyElement(candidate, epochToUpdate);
        }
      }
    }

    function touchesUnprovableShadowRoot(record: MutationRecord): boolean {
      const touchedNodes: Node[] = [record.target];
      appendArray(touchedNodes, nodeListToArray(record.addedNodes));
      const _forOfItems26 = touchedNodes;
      for (let _forOfIndex26 = 0; _forOfIndex26 < _forOfItems26.length; _forOfIndex26 += 1) {
        const node = _forOfItems26[_forOfIndex26]!;
        const root = isShadowRootNode(node) ? node : getRootNode(node);
        if (isShadowRootNode(root) && shadowRootMode(root) !== "open") return true;
      }
      return false;
    }

    function mutationCandidateElements(record: MutationRecord): Element[] {
      const candidates: Element[] = [];
      addNode(record.target, candidates);
      if (record.type === "childList") {
        const _forOfItems27 = nodeListToArray(record.addedNodes);
        for (let _forOfIndex27 = 0; _forOfIndex27 < _forOfItems27.length; _forOfIndex27 += 1) {
          const node = _forOfItems27[_forOfIndex27]!;
          addNode(node, candidates);
        }
      }
      return candidates;
    }

    function addNode(node: Node, candidates: Element[]): void {
      if (isElementNode(node)) {
        candidates[candidates.length] = node;
        appendArray(candidates, queryDescendants(node));
        appendArray(candidates, observedAncestors(node));
        return;
      }
      const parent = parentElementAcrossShadow(node);
      if (parent !== null) {
        candidates[candidates.length] = parent;
        appendArray(candidates, observedAncestors(parent));
      }
    }

    function classifyElement(candidate: Element, epochToUpdate: BrowserSensitiveEpoch): void {
      classifySingleElement(candidate, epochToUpdate);
      if (epochToUpdate.poisoned) return;
      const _forOfItems28 = observedAncestors(candidate);
      for (let _forOfIndex28 = 0; _forOfIndex28 < _forOfItems28.length; _forOfIndex28 += 1) {
        const ancestor = _forOfItems28[_forOfIndex28]!;
        classifySingleElement(ancestor, epochToUpdate);
        if (epochToUpdate.poisoned) return;
      }
    }

    function classifySingleElement(candidate: Element, epochToUpdate: BrowserSensitiveEpoch): void {
      const root = getRootNode(candidate);
      if (root !== candidate.ownerDocument && (!isShadowRootNode(root) || shadowRootMode(root) !== "open")) {
        poison(epochToUpdate);
        return;
      }
      const nodeKey = `${input.markerId}:${nodeIdentity(candidate)}`;
      if (!arrayHasString(epochToUpdate.classifiedNodes, nodeKey)) {
        epochToUpdate.classifiedNodes[epochToUpdate.classifiedNodes.length] = nodeKey;
        if (epochToUpdate.classifiedNodes.length > input.maxClassifiedNodes) {
          poison(epochToUpdate);
          return;
        }
      }
      const regionKey = nodeKey;
      if (isMaskableElement(candidate) && !arrayHasString(epochToUpdate.classifiedRegions, regionKey)) {
        epochToUpdate.classifiedRegions[epochToUpdate.classifiedRegions.length] = regionKey;
        epochToUpdate.classifiedElements[epochToUpdate.classifiedElements.length] = candidate;
        if (epochToUpdate.classifiedRegions.length > input.maxMaskRegions) {
          poison(epochToUpdate);
          return;
        }
      }
      markSensitiveElement(candidate, epochToUpdate.markerId);
    }

    function observedAncestors(candidate: Element): Element[] {
      const result: Element[] = [];
      for (let current = parentElementAcrossShadow(candidate); current !== null; current = parentElementAcrossShadow(current)) {
        if (isObservationCandidate(current)) result[result.length] = current;
      }
      return result;
    }

    function parentElementAcrossShadow(node: Node): Element | null {
      const directParent = parentElement(node);
      if (directParent !== null) return directParent;
      const root = getRootNode(node);
      return isShadowRootNode(root) && shadowRootMode(root) === "open" ? shadowRootHost(root) : null;
    }

    function observableElements(): Element[] {
      const elements = queryDocument("*");
      const _forOfItems29 = shadowRoots();
      for (let _forOfIndex29 = 0; _forOfIndex29 < _forOfItems29.length; _forOfIndex29 += 1) {
        const root = _forOfItems29[_forOfIndex29]!;
        if (shadowRootMode(root) === "open") appendArray(elements, queryRoot(root, "*"));
      }
      return elements;
    }

    function isObservationCandidate(candidate: Element): boolean {
      const tag = tagName(candidate);
      return tag === "button" ||
        (tag === "a" && hasAttribute(candidate, "href")) ||
        tag === "input" ||
        tag === "textarea" ||
        tag === "select" ||
        hasAttribute(candidate, "role") ||
        hasAttribute(candidate, "data-qualigence-observe");
    }

    function isMaskableElement(candidate: Element): boolean {
      const tag = tagName(candidate);
      return tag !== "head" && tag !== "title" && tag !== "meta" && tag !== "script" && tag !== "style";
    }

    function nodeIdentity(candidate: Element): string {
      const host = candidate as unknown as Element & Record<string, unknown>;
      const existingId = host.__qualigenceSensitiveNodeIdentity;
      if (typeof existingId === "string") return existingId;
      state.nextNodeOrdinal += 1;
      const nodeId = `qn-${state.nextNodeOrdinal}`;
      apply(dom.objectDefineProperty, Object, [host, "__qualigenceSensitiveNodeIdentity", {
        configurable: false,
        enumerable: false,
        value: nodeId,
        writable: false,
      }]);
      return nodeId;
    }

    function markSensitiveElement(candidate: Element, markerId: string): void {
      const host = candidate as unknown as Element & Record<string, unknown>;
      const current = host[input.targetIdsProperty];
      if (dom.arrayIsArray(current)) {
        if (!arrayHasString(current, markerId)) current[current.length] = markerId;
      } else {
        // This is a temporary pre-dispatch marker. It is deliberately
        // removable if permit authorization or cancellation prevents dispatch;
        // successful completion hardens it before host authority is recorded.
        apply(dom.objectDefineProperty, Object, [host, input.targetIdsProperty, {
          configurable: true,
          enumerable: false,
          value: [markerId],
          writable: true,
        }]);
      }
      if (!hasAttribute(candidate, input.maskAttribute)) {
        state.nextMaskOrdinal += 1;
        setAttribute(candidate, input.maskAttribute, `qm-${state.nextMaskOrdinal}`);
      }
    }

    function isMarkedSensitive(candidate: Element, markerId: string): boolean {
      const ids = (candidate as unknown as Element & Record<string, unknown>)[input.targetIdsProperty];
      return dom.arrayIsArray(ids) && arrayHasString(ids, markerId);
    }

    function fieldValue(candidate: Element): string {
      const tag = tagName(candidate);
      if (tag === "input") return inputValue(candidate);
      if (tag === "textarea") return textareaValue(candidate);
      if (tag === "select") return selectValue(candidate);
      return "";
    }

    function fieldPlaceholder(candidate: Element): string {
      const tag = tagName(candidate);
      if (tag === "input") return inputPlaceholder(candidate);
      if (tag === "textarea") return textareaPlaceholder(candidate);
      return "";
    }

    function isEventElement(target: unknown): target is Element {
      return typeof (target as { readonly nodeType?: unknown }).nodeType === "number" &&
        (target as unknown as { readonly nodeType: number }).nodeType === 1;
    }

    function isNodeLike(target: unknown): target is Node {
      return typeof (target as { readonly nodeType?: unknown }).nodeType === "number";
    }

    function sensitiveValues(candidate: Element): readonly string[] {
      const values: string[] = [];
      const text = directText(candidate);
      if (text !== "") values[values.length] = text;
      const observedText = isObservationCandidate(candidate) ? textContent(candidate) : "";
      if (observedText !== "" && observedText !== text) values[values.length] = observedText;
      const tag = tagName(candidate);
      if (tag === "input" || tag === "textarea") {
        if (fieldValue(candidate) !== "") values[values.length] = fieldValue(candidate);
        if (fieldPlaceholder(candidate) !== "") values[values.length] = fieldPlaceholder(candidate);
      }
      if (tag === "select") {
        if (fieldValue(candidate) !== "") values[values.length] = fieldValue(candidate);
        const selectedOption = firstSelectedOption(candidate);
        const selectedText = selectedOption === undefined ? "" : optionText(selectedOption);
        if (selectedText !== "") values[values.length] = selectedText;
      }
      const _forOfItems30 = ["role", "aria-label", "title", "value"] as const;
      for (let _forOfIndex30 = 0; _forOfIndex30 < _forOfItems30.length; _forOfIndex30 += 1) {
        const attribute = _forOfItems30[_forOfIndex30]!;
        const attributeValue = getAttribute(candidate, attribute);
        if (attributeValue !== null && attributeValue !== "") values[values.length] = attributeValue;
      }
      return values;
    }

    function directText(candidate: Element): string {
      let text = "";
      const _forOfItems31 = childNodes(candidate);
      for (let _forOfIndex31 = 0; _forOfIndex31 < _forOfItems31.length; _forOfIndex31 += 1) {
        const node = _forOfItems31[_forOfIndex31]!;
        if (isTextNode(node)) text += textData(node);
      }
      return text;
    }

    function shadowRootValues(root: ShadowRoot): readonly string[] {
      const values: string[] = [];
      let direct = "";
      const _forOfItems32 = childNodes(root);
      for (let _forOfIndex32 = 0; _forOfIndex32 < _forOfItems32.length; _forOfIndex32 += 1) {
        const node = _forOfItems32[_forOfIndex32]!;
        if (isTextNode(node)) direct += textData(node);
      }
      if (direct !== "") values[values.length] = direct;
      const fullText = textContent(root);
      if (fullText !== "" && fullText !== direct) values[values.length] = fullText;
      return values;
    }

    function shadowRoots(): ShadowRoot[] {
      const roots: ShadowRoot[] = [];
      const pending: ShadowRoot[] = [];
      const registry = (win as unknown as Record<string, unknown>)[input.runtimeRegistryProperty] as {
        readonly roots?: readonly unknown[];
        shadowRootOverflow?: boolean;
      } | undefined;
      const noteOverflow = (): void => {
        // The init-script closure may already have recorded this overflow.
        // Rewriting its guarded diagnostic would falsely look like page-side
        // authority tampering while the native action is being set up.
        if (registry?.shadowRootOverflow !== true && registry !== undefined) {
          registry.shadowRootOverflow = true;
        }
        state.poisoned = true;
      };
      const addRoot = (root: ShadowRoot): boolean => {
        if (arrayHasIdentity(roots, root)) return true;
        if (pending.length >= input.maxShadowRoots) {
          noteOverflow();
          return false;
        }
        roots[roots.length] = root;
        pending[pending.length] = root;
        return true;
      };
      const _forOfItems33 = registry?.roots ?? [];
      for (let _forOfIndex33 = 0; _forOfIndex33 < _forOfItems33.length; _forOfIndex33 += 1) {
        const root = _forOfItems33[_forOfIndex33]!;
        if (isShadowRootNode(root) && !addRoot(root)) return pending;
      }
      const _forOfItems34 = queryDocument("*");
      for (let _forOfIndex34 = 0; _forOfIndex34 < _forOfItems34.length; _forOfIndex34 += 1) {
        const candidate = _forOfItems34[_forOfIndex34]!;
        const candidateShadowRoot = shadowRoot(candidate);
        if (candidateShadowRoot !== null && !addRoot(candidateShadowRoot)) return pending;
      }
      for (let index = 0; index < pending.length; index += 1) {
        const root = pending[index]!;
        const _forOfItems35 = queryRoot(root, "*");
        for (let _forOfIndex35 = 0; _forOfIndex35 < _forOfItems35.length; _forOfIndex35 += 1) {
          const candidate = _forOfItems35[_forOfIndex35]!;
          const nestedShadowRoot = shadowRoot(candidate);
          if (nestedShadowRoot !== null && !addRoot(nestedShadowRoot)) return pending;
        }
      }
      return pending;
    }

    function normalizeVisibleSensitiveForm(value: string): string {
      return stringTrim(collapseWhitespace(stringNormalize(value, "NFC")));
    }

    function normalizeBrowserLineBreaks(value: string): string {
      let result = "";
      for (let index = 0; index < value.length; index += 1) {
        const character = value[index] ?? "";
        if (character === "\r") {
          if (value[index + 1] === "\n") index += 1;
          result += "\n";
        } else {
          result += character;
        }
      }
      return result;
    }

    function collapseWhitespace(value: string): string {
      let result = "";
      let pendingSpace = false;
      for (let index = 0; index < value.length; index += 1) {
        const character = value[index] ?? "";
        if (isWhitespaceCharacter(character)) {
          pendingSpace = true;
        } else {
          if (pendingSpace && result !== "") result += " ";
          result += character;
          pendingSpace = false;
        }
      }
      return result;
    }

    function safeMaskIdPart(value: string): string {
      let result = "";
      for (let index = 0; index < value.length; index += 1) {
        const character = value[index] ?? "";
        result += isAsciiMaskIdCharacter(character) ? character : "_";
      }
      return result;
    }

    function isAsciiMaskIdCharacter(character: string): boolean {
      return (character >= "A" && character <= "Z") ||
        (character >= "a" && character <= "z") ||
        (character >= "0" && character <= "9") ||
        character === "_" || character === "-";
    }

    function isWhitespaceCharacter(character: string): boolean {
      return character === " " || character === "\t" || character === "\n" || character === "\r" || character === "\f" || character === "\v" ||
        character === "\u00a0" || character === "\u1680" || character === "\u180e" || character === "\u2000" || character === "\u2001" ||
        character === "\u2002" || character === "\u2003" || character === "\u2004" || character === "\u2005" || character === "\u2006" ||
        character === "\u2007" || character === "\u2008" || character === "\u2009" || character === "\u200a" || character === "\u2028" ||
        character === "\u2029" || character === "\u202f" || character === "\u205f" || character === "\u3000" || character === "\ufeff";
    }

    function carriesForm(value: string, form: string | readonly string[]): boolean {
      const forms = dom.arrayIsArray(form) ? form : [form];
      const _forOfItems36 = forms;
      for (let _forOfIndex36 = 0; _forOfIndex36 < _forOfItems36.length; _forOfIndex36 += 1) {
        const candidate = _forOfItems36[_forOfIndex36]!;
        if (value === candidate || (candidate !== "" && stringIncludes(value, candidate))) return true;
      }
      return false;
    }

    function shadowBaselineAllows(node: Node, epochToUpdate: BrowserSensitiveEpoch, value: string): boolean {
      return arrayHasString(weakMapGet(epochToUpdate.shadowBaseline, node) ?? [], value);
    }

    function shadowRootAuthorityUnavailable(): boolean {
      const registry = (win as unknown as Record<string, unknown>)[input.runtimeRegistryProperty] as {
        readonly validateShadowRootAuthority?: () => { readonly status: "ok" | "failed"; readonly reason?: string };
      } | undefined;
      const validate = registry?.validateShadowRootAuthority;
      if (typeof validate !== "function") {
        state.poisoned = true;
        return true;
      }
      try {
        if (validate().status === "ok") return false;
      } catch {
        // Fall through to the fail-closed state below.
      }
      state.poisoned = true;
      return true;
    }

    function shadowRootOverflow(): boolean {
      const registry = (win as unknown as Record<string, unknown>)[input.runtimeRegistryProperty] as {
        readonly shadowRootOverflow?: unknown;
      } | undefined;
      if (shadowRootAuthorityUnavailable()) return true;
      if (registry?.shadowRootOverflow === true) return true;
      shadowRoots();
      return registry?.shadowRootOverflow === true;
    }

    function poison(epochToUpdate: BrowserSensitiveEpoch): void {
      epochToUpdate.poisoned = true;
      state.poisoned = true;
    }
  }, {
    markerId: prepared.markerId,
    kind,
    sourceValue,
    stateProperty: SENSITIVE_EVIDENCE_STATE_PROPERTY,
    targetIdsProperty: SENSITIVE_TARGET_IDS_PROPERTY,
    maskAttribute: SENSITIVE_MASK_ID_ATTRIBUTE,
    runtimeRegistryProperty: SENSITIVE_SHADOW_ROOTS_PROPERTY,
    maxMutationRecords: MAX_REFLECTED_MUTATION_RECORDS,
    maxClassifiedNodes: MAX_REFLECTED_NODES,
    maxMaskRegions: MAX_REFLECTED_REGIONS,
    maxShadowRoots: MAX_SENSITIVE_SHADOW_ROOTS,
  });
}

async function endPageSensitiveActionEpoch(
  locator: Locator,
  prepared: PreparedSensitiveEvidenceRecord,
  kind: "input" | "select",
  retainRecord = true,
): Promise<PageSensitiveEpochResult> {
  return locator.evaluate((element, input): PageSensitiveEpochResult => {
    type BrowserSensitiveState = {
      active?: {
        markerId: string;
        forms: string[];
        baseline: WeakMap<Element, readonly string[]>;
        shadowBaseline: WeakMap<Node, readonly string[]>;
        observer: MutationObserver;
        targetCaptureListener: EventListener;
        documentBubbleListener: EventListener;
        mutationOrdinal: number;
        deferredRecords: MutationRecord[];
        classifiedNodes: string[];
        classifiedRegions: string[];
        classifiedElements?: Element[];
        classifiedMaskIds?: string[];
        hasDelegatedListener: boolean;
        inTargetDispatch: boolean;
        inSchedulerCallback?: boolean;
        schedulerRegistrations?: number;
        poisoned: boolean;
      } | null;
      records: {
        markerId: string;
        forms: string[];
        baseline: WeakMap<Element, readonly string[]>;
        shadowBaseline?: WeakMap<Node, readonly string[]>;
        classifiedNodes?: string[];
        classifiedRegions?: string[];
        classifiedElements?: Element[];
        classifiedMaskIds?: string[];
        schedulerRegistrations?: number;
        poisoned?: boolean;
        observer?: MutationObserver;
      }[];
      poisoned: boolean;
      nextNodeOrdinal: number;
      nextMaskOrdinal: number;
      schedulerSessionRegistrations?: number;
      retainedSchedulerEpochs?: NonNullable<BrowserSensitiveState["active"]>[];
    };
    type SensitiveRuntimeRegistry = {
      readonly nativeDom?: NativeDomAuthority;
      readonly retainSensitiveSchedulerEpoch?: (epoch: NonNullable<BrowserSensitiveState["active"]>) => void;
      readonly sensitiveSchedulerRegistrationCount?: (epoch: NonNullable<BrowserSensitiveState["active"]>) => number;
    };
    type NativeDomAuthority = {
      readonly arrayFrom: typeof Array.from;
      readonly arrayIsArray: typeof Array.isArray;
      readonly htmlCollectionItem: (index: number) => Element | null;
      readonly htmlCollectionLengthGet: (() => number) | undefined;
      readonly htmlOptionsCollectionItem: (index: number) => HTMLOptionElement | null;
      readonly htmlOptionsCollectionLengthGet: (() => number) | undefined;
      readonly nodeListItem: (index: number) => Node | null;
      readonly nodeListLengthGet: (() => number) | undefined;
      readonly objectDefineProperty: typeof Object.defineProperty;
      readonly reflectApply: typeof Reflect.apply;
      readonly stringIncludes: typeof String.prototype.includes;
      readonly stringNormalize: typeof String.prototype.normalize;
      readonly stringReplace: typeof String.prototype.replace;
      readonly stringToLowerCase: typeof String.prototype.toLowerCase;
      readonly stringTrim: typeof String.prototype.trim;
      readonly weakMap: WeakMapConstructor;
      readonly weakMapGet: typeof WeakMap.prototype.get;
      readonly weakMapSet: typeof WeakMap.prototype.set;
      readonly documentQuerySelectorAll: typeof Document.prototype.querySelectorAll;
      readonly documentFragmentQuerySelectorAll: typeof DocumentFragment.prototype.querySelectorAll;
      readonly elementGetAttribute: typeof Element.prototype.getAttribute;
      readonly elementHasAttribute: typeof Element.prototype.hasAttribute;
      readonly elementQuerySelectorAll: typeof Element.prototype.querySelectorAll;
      readonly elementRemoveAttribute: typeof Element.prototype.removeAttribute;
      readonly elementSetAttribute: typeof Element.prototype.setAttribute;
      readonly elementTagNameGet: (() => string) | undefined;
      readonly htmlInputElementPlaceholderGet: (() => string) | undefined;
      readonly htmlInputElementValueGet: (() => string) | undefined;
      readonly htmlOptionElementLabelGet: (() => string) | undefined;
      readonly htmlOptionElementTextGet: (() => string) | undefined;
      readonly htmlOptionElementValueGet: (() => string) | undefined;
      readonly htmlSelectElementOptionsGet: (() => HTMLOptionsCollection) | undefined;
      readonly htmlSelectElementSelectedOptionsGet: (() => HTMLCollectionOf<HTMLOptionElement>) | undefined;
      readonly htmlSelectElementValueGet: (() => string) | undefined;
      readonly htmlTextAreaElementPlaceholderGet: (() => string) | undefined;
      readonly htmlTextAreaElementValueGet: (() => string) | undefined;
      readonly nodeChildNodesGet: (() => NodeListOf<ChildNode>) | undefined;
      readonly nodeContains: typeof Node.prototype.contains;
      readonly nodeGetRootNode: typeof Node.prototype.getRootNode;
      readonly nodeParentElementGet: (() => HTMLElement | null) | undefined;
      readonly nodeTextContentGet: (() => string | null) | undefined;
      readonly characterDataDataGet: (() => string) | undefined;
      readonly shadowRootHostGet: (() => Element) | undefined;
      readonly shadowRootModeGet: (() => ShadowRootMode) | undefined;
    };
    const win = element.ownerDocument.defaultView;
    if (win === null) return { status: "failed" };
    const registry = (win as unknown as Record<string, SensitiveRuntimeRegistry | undefined>)[input.runtimeRegistryProperty];
    const maybeDom = nativeDomAuthority(registry);
    if (maybeDom === undefined) return { status: "failed" };
    const dom: NativeDomAuthority = maybeDom;
    const state = (win as unknown as Record<string, BrowserSensitiveState | undefined>)[input.stateProperty];
    const active = state?.active;
    if (state === undefined || active === null || active === undefined || active.markerId !== input.markerId) {
      if (state !== undefined) state.poisoned = true;
      return { status: "failed" };
    }
    if (input.retainRecord) {
      active.forms = mergeSensitiveForms(active.forms, reflectedCandidateForms(element, input.kind));
      processCurrentSensitiveMatches(state, active);
      bindSelectedSensitiveOptions(state, active, element, input.kind);
      const records = cloneArray(active.deferredRecords);
      appendArray(records, active.observer.takeRecords());
      active.deferredRecords = [];
      processMutationRecords(
        state,
        active,
        records,
        canClassifyCurrentDispatch(active) || (active.schedulerRegistrations ?? 0) > 0,
      );
    }
    active.inTargetDispatch = false;
    const schedulerRegistrations = registry?.sensitiveSchedulerRegistrationCount?.(active) ?? active.schedulerRegistrations ?? 0;
    const retainSchedulerObserver = input.retainRecord && schedulerRegistrations > 0;
    if (!retainSchedulerObserver) active.observer.disconnect();
    element.removeEventListener("input", active.targetCaptureListener, true);
    element.removeEventListener("change", active.targetCaptureListener, true);
    element.ownerDocument.removeEventListener("input", active.documentBubbleListener, false);
    element.ownerDocument.removeEventListener("change", active.documentBubbleListener, false);
    const maskIds = input.retainRecord ? assignSensitiveMaskIds(state, active) : [];
    if (input.retainRecord) {
      state.records[state.records.length] = {
        markerId: active.markerId,
        forms: active.forms,
        baseline: active.baseline,
        shadowBaseline: active.shadowBaseline,
        classifiedNodes: active.classifiedNodes,
        classifiedRegions: active.classifiedRegions,
        ...(active.classifiedElements === undefined ? {} : { classifiedElements: active.classifiedElements }),
        ...(active.classifiedMaskIds === undefined ? {} : { classifiedMaskIds: active.classifiedMaskIds }),
        schedulerRegistrations: active.schedulerRegistrations ?? 0,
        poisoned: active.poisoned,
        ...(retainSchedulerObserver ? { observer: active.observer } : {}),
      };
      if (retainSchedulerObserver) {
        state.retainedSchedulerEpochs ??= [];
        state.retainedSchedulerEpochs[state.retainedSchedulerEpochs.length] = active;
        registry?.retainSensitiveSchedulerEpoch?.(active);
      }
    } else {
      cleanupSensitiveMarkers(active.markerId, active.classifiedElements ?? []);
    }
    const failed = input.retainRecord && (state.poisoned || active.poisoned);
    state.active = null;
    return failed ? { status: "failed" } : { status: "ok", maskIds };

    function nativeDomAuthority(runtimeRegistry: SensitiveRuntimeRegistry | undefined): NativeDomAuthority | undefined {
      const candidate = runtimeRegistry?.nativeDom;
      if (candidate === undefined) return undefined;
      const required = [
        candidate.arrayFrom,
        candidate.arrayIsArray,
        candidate.htmlCollectionItem,
        candidate.htmlCollectionLengthGet,
        candidate.htmlOptionsCollectionItem,
        candidate.htmlOptionsCollectionLengthGet,
        candidate.nodeListItem,
        candidate.nodeListLengthGet,
        candidate.objectDefineProperty,
        candidate.reflectApply,
        candidate.stringIncludes,
        candidate.stringNormalize,
        candidate.stringReplace,
        candidate.stringToLowerCase,
        candidate.stringTrim,
        candidate.weakMap,
        candidate.weakMapGet,
        candidate.weakMapSet,
        candidate.documentQuerySelectorAll,
        candidate.documentFragmentQuerySelectorAll,
        candidate.elementGetAttribute,
        candidate.elementHasAttribute,
        candidate.elementQuerySelectorAll,
        candidate.elementRemoveAttribute,
        candidate.elementSetAttribute,
        candidate.elementTagNameGet,
        candidate.htmlInputElementPlaceholderGet,
        candidate.htmlInputElementValueGet,
        candidate.htmlOptionElementLabelGet,
        candidate.htmlOptionElementTextGet,
        candidate.htmlOptionElementValueGet,
        candidate.htmlSelectElementOptionsGet,
        candidate.htmlSelectElementSelectedOptionsGet,
        candidate.htmlSelectElementValueGet,
        candidate.htmlTextAreaElementPlaceholderGet,
        candidate.htmlTextAreaElementValueGet,
        candidate.nodeChildNodesGet,
        candidate.nodeContains,
        candidate.nodeGetRootNode,
        candidate.nodeParentElementGet,
        candidate.nodeTextContentGet,
        candidate.characterDataDataGet,
        candidate.shadowRootHostGet,
        candidate.shadowRootModeGet,
      ];
      const _forOfItems37 = required;
      for (let _forOfIndex37 = 0; _forOfIndex37 < _forOfItems37.length; _forOfIndex37 += 1) {
        const fn = _forOfItems37[_forOfIndex37]!;
        if (typeof fn !== "function") return undefined;
      }
      return candidate;
    }

    function apply<T>(fn: (...args: never[]) => T, receiver: unknown, args: readonly unknown[] = []): T {
      return dom.reflectApply(fn, receiver, args as never[]) as T;
    }

    function stringIncludes(value: string, search: string): boolean {
      return apply(dom.stringIncludes as (...args: never[]) => boolean, value, [search]);
    }

    function stringNormalize(value: string, form: string): string {
      return apply(dom.stringNormalize as (...args: never[]) => string, value, [form]);
    }

    function stringToLowerCase(value: string): string {
      return apply(dom.stringToLowerCase as (...args: never[]) => string, value);
    }

    function stringTrim(value: string): string {
      return apply(dom.stringTrim as (...args: never[]) => string, value);
    }

    function assertCollectionLength(length: unknown): number {
      if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
        throw new Error("Untrusted DOM collection length.");
      }
      return length;
    }

    function nodeListToArray<T extends Node>(items: NodeList): T[] {
      const length = assertCollectionLength(apply(dom.nodeListLengthGet!, items));
      const result: T[] = [];
      for (let index = 0; index < length; index += 1) {
        const item = apply(dom.nodeListItem, items, [index]);
        if (item === null) throw new Error("Untrusted NodeList item.");
        result[index] = item as T;
      }
      return result;
    }

    function htmlCollectionToArray<T extends Element>(items: HTMLCollectionOf<T>): T[] {
      const length = assertCollectionLength(apply(dom.htmlCollectionLengthGet!, items));
      const result: T[] = [];
      for (let index = 0; index < length; index += 1) {
        const item = apply(dom.htmlCollectionItem, items, [index]);
        if (item === null) throw new Error("Untrusted HTMLCollection item.");
        result[index] = item as T;
      }
      return result;
    }

    function htmlOptionsCollectionToArray(items: HTMLOptionsCollection): HTMLOptionElement[] {
      const length = assertCollectionLength(apply(dom.htmlOptionsCollectionLengthGet!, items));
      const result: HTMLOptionElement[] = [];
      for (let index = 0; index < length; index += 1) {
        const item = apply(dom.htmlOptionsCollectionItem, items, [index]);
        if (item === null) throw new Error("Untrusted HTMLOptionsCollection item.");
        result[index] = item;
      }
      return result;
    }

    function createWeakMap<K extends object, V>(): WeakMap<K, V> {
      return new dom.weakMap<K, V>();
    }

    function weakMapGet<K extends object, V>(map: WeakMap<K, V>, key: K): V | undefined {
      return apply(dom.weakMapGet as (...args: never[]) => V | undefined, map, [key]);
    }

    function weakMapSet<K extends object, V>(map: WeakMap<K, V>, key: K, value: V): void {
      apply(dom.weakMapSet as (...args: never[]) => WeakMap<K, V>, map, [key, value]);
    }

    function queryDocument(selector: string): Element[] {
      return nodeListToArray(apply(dom.documentQuerySelectorAll, element.ownerDocument, [selector]));
    }

    function queryRoot(root: ShadowRoot, selector: string): Element[] {
      return nodeListToArray(apply(dom.documentFragmentQuerySelectorAll, root, [selector]));
    }

    function queryDescendants(candidate: Element): Element[] {
      return nodeListToArray(apply(dom.elementQuerySelectorAll, candidate, ["*"]));
    }

    function getAttribute(candidate: Element, name: string): string | null {
      return apply(dom.elementGetAttribute, candidate, [name]);
    }

    function hasAttribute(candidate: Element, name: string): boolean {
      return apply(dom.elementHasAttribute, candidate, [name]);
    }

    function removeAttribute(candidate: Element, name: string): void {
      apply(dom.elementRemoveAttribute, candidate, [name]);
    }

    function setAttribute(candidate: Element, name: string, value: string): void {
      apply(dom.elementSetAttribute, candidate, [name, value]);
    }

    function tagName(candidate: Element): string {
      return stringToLowerCase(apply(dom.elementTagNameGet!, candidate));
    }

    function childNodes(node: Node): ChildNode[] {
      return nodeListToArray(apply(dom.nodeChildNodesGet!, node));
    }

    function textContent(node: Node): string {
      return apply(dom.nodeTextContentGet!, node) ?? "";
    }

    function textData(node: Text): string {
      return apply(dom.characterDataDataGet!, node);
    }

    function getRootNode(node: Node): Node {
      return apply(dom.nodeGetRootNode, node);
    }

    function parentElement(node: Node): Element | null {
      return apply(dom.nodeParentElementGet!, node);
    }

    function contains(parent: Node, child: Node): boolean {
      return apply(dom.nodeContains, parent, [child]);
    }

    function selectOptions(candidate: Element): HTMLOptionElement[] {
      return htmlOptionsCollectionToArray(apply(dom.htmlSelectElementOptionsGet!, candidate));
    }

    function selectedOptions(candidate: Element): HTMLOptionElement[] {
      return htmlCollectionToArray(apply(dom.htmlSelectElementSelectedOptionsGet!, candidate));
    }

    function firstSelectedOption(candidate: Element): HTMLOptionElement | undefined {
      const selected = apply(dom.htmlSelectElementSelectedOptionsGet!, candidate);
      const length = assertCollectionLength(apply(dom.htmlCollectionLengthGet!, selected));
      if (length < 1) return undefined;
      return (apply(dom.htmlCollectionItem, selected, [0]) as HTMLOptionElement | null) ?? undefined;
    }

    function inputValue(candidate: Element): string {
      return apply(dom.htmlInputElementValueGet!, candidate);
    }

    function inputPlaceholder(candidate: Element): string {
      return apply(dom.htmlInputElementPlaceholderGet!, candidate);
    }

    function textareaValue(candidate: Element): string {
      return apply(dom.htmlTextAreaElementValueGet!, candidate);
    }

    function textareaPlaceholder(candidate: Element): string {
      return apply(dom.htmlTextAreaElementPlaceholderGet!, candidate);
    }

    function selectValue(candidate: Element): string {
      return apply(dom.htmlSelectElementValueGet!, candidate);
    }

    function optionValue(option: HTMLOptionElement): string {
      return apply(dom.htmlOptionElementValueGet!, option);
    }

    function optionText(option: HTMLOptionElement): string {
      return apply(dom.htmlOptionElementTextGet!, option);
    }

    function optionLabel(option: HTMLOptionElement): string {
      return apply(dom.htmlOptionElementLabelGet!, option);
    }

    function shadowRootMode(root: ShadowRoot): ShadowRootMode {
      return apply(dom.shadowRootModeGet!, root);
    }

    function shadowRootHost(root: ShadowRoot): Element {
      return apply(dom.shadowRootHostGet!, root);
    }

    function isElementNode(node: Node): node is Element {
      return node.nodeType === 1;
    }

    function isShadowRootNode(node: unknown): node is ShadowRoot {
      return typeof (node as { readonly nodeType?: unknown }).nodeType === "number" &&
        (node as { readonly nodeType: number }).nodeType === 11 &&
        "host" in (node as object);
    }

    function isEventElement(target: unknown): target is Element {
      return typeof (target as { readonly nodeType?: unknown }).nodeType === "number" &&
        (target as unknown as { readonly nodeType: number }).nodeType === 1;
    }

    function isNodeLike(target: unknown): target is Node {
      return typeof (target as { readonly nodeType?: unknown }).nodeType === "number";
    }

    function isTextNode(node: Node): node is Text {
      return node.nodeType === 3;
    }

    function arrayHasString(values: readonly string[], candidate: string): boolean {
      const _forOfItems38 = values;
      for (let _forOfIndex38 = 0; _forOfIndex38 < _forOfItems38.length; _forOfIndex38 += 1) {
        const value = _forOfItems38[_forOfIndex38]!;
        if (value === candidate) return true;
      }
      return false;
    }

    function arrayHasIdentity<T>(values: readonly T[], candidate: T): boolean {
      const _forOfItems39 = values;
      for (let _forOfIndex39 = 0; _forOfIndex39 < _forOfItems39.length; _forOfIndex39 += 1) {
        const value = _forOfItems39[_forOfIndex39]!;
        if (value === candidate) return true;
      }
      return false;
    }

    function pushUniqueNonEmpty(values: string[], candidate: string): void {
      if (candidate !== "" && !arrayHasString(values, candidate)) values[values.length] = candidate;
    }

    function appendArray<T>(target: T[], items: readonly T[]): void {
      for (let index = 0; index < items.length; index += 1) {
        target[target.length] = items[index]!;
      }
    }

    function cloneArray<T>(items: readonly T[]): T[] {
      const result: T[] = [];
      appendArray(result, items);
      return result;
    }

    function baselineContainsAll(baseline: readonly string[] | undefined, matches: readonly string[]): boolean {
      if (baseline === undefined) return false;
      const _forOfItems40 = matches;
      for (let _forOfIndex40 = 0; _forOfIndex40 < _forOfItems40.length; _forOfIndex40 += 1) {
        const value = _forOfItems40[_forOfIndex40]!;
        if (!arrayHasString(baseline, value)) return false;
      }
      return true;
    }

    function assignSensitiveMaskIds(
      stateToUpdate: BrowserSensitiveState,
      epochToUpdate: NonNullable<BrowserSensitiveState["active"]>,
    ): string[] {
      const maskIds: string[] = [];
      const elements = epochToUpdate.classifiedElements ?? [];
      if (elements.length === 0 || elements.length > input.maxMaskRegions ||
        elements.length !== epochToUpdate.classifiedRegions.length) {
        epochToUpdate.poisoned = true;
        stateToUpdate.poisoned = true;
        return maskIds;
      }
      let ordinal = 0;
      const _forOfItems41 = elements;
      for (let _forOfIndex41 = 0; _forOfIndex41 < _forOfItems41.length; _forOfIndex41 += 1) {
        const candidate = _forOfItems41[_forOfIndex41]!;
        if (candidate.nodeType !== 1) {
          epochToUpdate.poisoned = true;
          stateToUpdate.poisoned = true;
          return maskIds;
        }
        const expectedNodeKey = `${epochToUpdate.markerId}:${nodeIdentity(stateToUpdate, candidate)}`;
        if (epochToUpdate.classifiedRegions[ordinal] !== expectedNodeKey) {
          epochToUpdate.poisoned = true;
          stateToUpdate.poisoned = true;
          return maskIds;
        }
        ordinal += 1;
        const maskId = `qm-${safeMaskIdPart(epochToUpdate.markerId)}-${ordinal}`;
        setAttribute(candidate, input.maskAttribute, maskId);
        if (getAttribute(candidate, input.maskAttribute) !== maskId) {
          epochToUpdate.poisoned = true;
          stateToUpdate.poisoned = true;
          return maskIds;
        }
        maskIds[maskIds.length] = maskId;
      }
      epochToUpdate.classifiedMaskIds = maskIds;
      return maskIds;
    }

    function cleanupSensitiveMarkers(markerId: string, classifiedElements: readonly Element[]): void {
      const candidates: Element[] = [];
      const _forOfItems42 = classifiedElements;
      for (let _forOfIndex42 = 0; _forOfIndex42 < _forOfItems42.length; _forOfIndex42 += 1) {
        const candidate = _forOfItems42[_forOfIndex42]!;
        if (!arrayHasIdentity(candidates, candidate)) candidates[candidates.length] = candidate;
      }
      if (!arrayHasIdentity(candidates, element)) candidates[candidates.length] = element;
      const _forOfItems43 = queryDocument("*");
      for (let _forOfIndex43 = 0; _forOfIndex43 < _forOfItems43.length; _forOfIndex43 += 1) {
        const candidate = _forOfItems43[_forOfIndex43]!;
        const ids = (candidate as unknown as Element & Record<string, unknown>)[input.targetIdsProperty];
        if (dom.arrayIsArray(ids) && arrayHasString(ids, markerId) && !arrayHasIdentity(candidates, candidate)) {
          candidates[candidates.length] = candidate;
        }
      }
      const _forOfItems44 = candidates;
      for (let _forOfIndex44 = 0; _forOfIndex44 < _forOfItems44.length; _forOfIndex44 += 1) {
        const candidate = _forOfItems44[_forOfIndex44]!;
        removeSensitiveMarker(candidate, markerId);
      }
    }

    function removeSensitiveMarker(candidate: Element, markerId: string): void {
      const host = candidate as unknown as Element & Record<string, unknown>;
      const ids = host[input.targetIdsProperty];
      if (!dom.arrayIsArray(ids)) {
        return;
      }
      const remaining: string[] = [];
      const _forOfItems45 = ids;
      for (let _forOfIndex45 = 0; _forOfIndex45 < _forOfItems45.length; _forOfIndex45 += 1) {
        const id = _forOfItems45[_forOfIndex45]!;
        if (id !== markerId) remaining[remaining.length] = id;
      }
      if (remaining.length === 0) {
        delete host[input.targetIdsProperty];
        removeAttribute(candidate, input.maskAttribute);
        return;
      }
      host[input.targetIdsProperty] = remaining;
    }

    function bindSelectedSensitiveOptions(
      stateToUpdate: BrowserSensitiveState,
      epochToUpdate: NonNullable<BrowserSensitiveState["active"]>,
      target: Element,
      actionKind: "input" | "select",
    ): void {
      if (actionKind !== "select" || tagName(target) !== "select") return;
      const options = selectedOptions(target);
      for (let index = 0; index < options.length; index += 1) {
        const option = options[index]!;
        if (sensitiveMatches(option, epochToUpdate.forms).length === 0) continue;
        classifyElement(stateToUpdate, epochToUpdate, option);
        if (epochToUpdate.poisoned) return;
      }
    }

    function processCurrentSensitiveMatches(
      stateToUpdate: BrowserSensitiveState,
      epochToUpdate: NonNullable<BrowserSensitiveState["active"]>,
    ): void {
      const _forOfItems46 = queryDocument("*");
      for (let _forOfIndex46 = 0; _forOfIndex46 < _forOfItems46.length; _forOfIndex46 += 1) {
        const candidate = _forOfItems46[_forOfIndex46]!;
        const matches = sensitiveMatches(candidate, epochToUpdate.forms);
        if (matches.length === 0) continue;
        if (isMarkedSensitive(candidate, epochToUpdate.markerId)) continue;
        if (baselineContainsAll(weakMapGet(epochToUpdate.baseline, candidate), matches)) continue;
        classifyElement(stateToUpdate, epochToUpdate, candidate);
        if (epochToUpdate.poisoned) return;
      }
    }

    function processMutationRecords(
      stateToUpdate: BrowserSensitiveState,
      epochToUpdate: NonNullable<BrowserSensitiveState["active"]>,
      records: readonly MutationRecord[],
      allowClassification: boolean,
    ): void {
      const applicationRecords: MutationRecord[] = [];
      const _forOfItems47 = records;
      for (let _forOfIndex47 = 0; _forOfIndex47 < _forOfItems47.length; _forOfIndex47 += 1) {
        const record = _forOfItems47[_forOfIndex47]!;
        if (record.type !== "attributes" || record.attributeName !== input.maskAttribute) {
          applicationRecords[applicationRecords.length] = record;
        }
      }
      epochToUpdate.mutationOrdinal += applicationRecords.length;
      if (epochToUpdate.mutationOrdinal > input.maxMutationRecords) {
        epochToUpdate.poisoned = true;
        stateToUpdate.poisoned = true;
        return;
      }
      const _forOfItems48 = applicationRecords;
      for (let _forOfIndex48 = 0; _forOfIndex48 < _forOfItems48.length; _forOfIndex48 += 1) {
        const record = _forOfItems48[_forOfIndex48]!;
        if (touchesUnprovableShadowRoot(record)) {
          epochToUpdate.poisoned = true;
          stateToUpdate.poisoned = true;
          return;
        }
        const _forOfItems49 = mutationCandidateElements(record);
        for (let _forOfIndex49 = 0; _forOfIndex49 < _forOfItems49.length; _forOfIndex49 += 1) {
          const candidate = _forOfItems49[_forOfIndex49]!;
          const matches = sensitiveMatches(candidate, epochToUpdate.forms);
          if (matches.length === 0) continue;
          if (isMarkedSensitive(candidate, epochToUpdate.markerId)) continue;
          if (baselineContainsAll(weakMapGet(epochToUpdate.baseline, candidate), matches)) {
            continue;
          }
          if (!allowClassification) {
            epochToUpdate.poisoned = true;
            stateToUpdate.poisoned = true;
            return;
          }
          classifyElement(stateToUpdate, epochToUpdate, candidate);
        }
      }
    }

    function touchesUnprovableShadowRoot(record: MutationRecord): boolean {
      const touchedNodes: Node[] = [record.target];
      appendArray(touchedNodes, nodeListToArray(record.addedNodes));
      const _forOfItems50 = touchedNodes;
      for (let _forOfIndex50 = 0; _forOfIndex50 < _forOfItems50.length; _forOfIndex50 += 1) {
        const node = _forOfItems50[_forOfIndex50]!;
        const root = isShadowRootNode(node) ? node : getRootNode(node);
        if (isShadowRootNode(root) && shadowRootMode(root) !== "open") return true;
      }
      return false;
    }

    function mutationCandidateElements(record: MutationRecord): Element[] {
      const candidates: Element[] = [];
      addNode(record.target, candidates);
      if (record.type === "childList") {
        const _forOfItems51 = nodeListToArray(record.addedNodes);
        for (let _forOfIndex51 = 0; _forOfIndex51 < _forOfItems51.length; _forOfIndex51 += 1) {
          const node = _forOfItems51[_forOfIndex51]!;
          addNode(node, candidates);
        }
      }
      return candidates;
    }

    function addNode(node: Node, candidates: Element[]): void {
      if (isElementNode(node)) {
        candidates[candidates.length] = node;
        appendArray(candidates, queryDescendants(node));
        appendArray(candidates, observedAncestors(node));
        return;
      }
      const parent = parentElementAcrossShadow(node);
      if (parent !== null) {
        candidates[candidates.length] = parent;
        appendArray(candidates, observedAncestors(parent));
      }
    }

    function sensitiveMatches(candidate: Element, formsToMatch: readonly string[]): string[] {
      const matches: string[] = [];
      const _forOfItems52 = sensitiveValues(candidate);
      for (let _forOfIndex52 = 0; _forOfIndex52 < _forOfItems52.length; _forOfIndex52 += 1) {
        const value = _forOfItems52[_forOfIndex52]!;
        const _forOfItems53 = formsToMatch;
        for (let _forOfIndex53 = 0; _forOfIndex53 < _forOfItems53.length; _forOfIndex53 += 1) {
          const form = _forOfItems53[_forOfIndex53]!;
          if (carriesForm(value, form)) {
            matches[matches.length] = value;
            break;
          }
        }
      }
      return matches;
    }

    function canClassifyCurrentDispatch(
      epochToUpdate: NonNullable<BrowserSensitiveState["active"]>,
    ): boolean {
      epochToUpdate.hasDelegatedListener = epochToUpdate.hasDelegatedListener || hasDelegatedListener(input.kind);
      return epochToUpdate.inTargetDispatch && !epochToUpdate.hasDelegatedListener;
    }

    function hasDelegatedListener(eventType: "input" | "select"): boolean {
      const _forOfItems54 = sensitiveEventTypes(eventType);
      for (let _forOfIndex54 = 0; _forOfIndex54 < _forOfItems54.length; _forOfIndex54 += 1) {
        const listenerType = _forOfItems54[_forOfIndex54]!;
        if (hasDelegatedEventListener(listenerType) ||
          hasDelegatedEventHandlerProperty(listenerType)) {
          return true;
        }
      }
      return false;
    }

    function sensitiveEventTypes(eventType: "input" | "select"): readonly ("input" | "change")[] {
      return eventType === "select" ? ["input", "change"] : ["input"];
    }

    function hasDelegatedEventListener(listenerType: "input" | "change"): boolean {
      const registry = (win as unknown as Record<string, unknown>)[input.runtimeRegistryProperty] as {
        readonly listenerTargets?: readonly {
          readonly type?: unknown;
          readonly target?: unknown;
          readonly listener?: unknown;
        }[];
      } | undefined;
      const _forOfItems55 = registry?.listenerTargets ?? [];
      for (let _forOfIndex55 = 0; _forOfIndex55 < _forOfItems55.length; _forOfIndex55 += 1) {
        const entry = _forOfItems55[_forOfIndex55]!;
        if (entry.type !== listenerType) continue;
        if (isInstrumentationListener(entry.listener)) continue;
        if (isDelegatedEventTarget(entry.target)) return true;
      }
      return false;
    }

    function hasDelegatedEventHandlerProperty(listenerType: "input" | "change"): boolean {
      const handlerName = `on${listenerType}`;
      const _forOfItems56 = delegatedEventPathTargets();
      for (let _forOfIndex56 = 0; _forOfIndex56 < _forOfItems56.length; _forOfIndex56 += 1) {
        const target = _forOfItems56[_forOfIndex56]!;
        if (isEventElement(target) && hasAttribute(target, handlerName)) return true;

      }
      return false;
    }

    function isInstrumentationListener(listener: unknown): boolean {
      return listener !== null &&
        (typeof listener === "function" || typeof listener === "object") &&
        (listener as Record<string, unknown>).__qualigenceSensitiveInstrumentation === true;
    }

    function delegatedEventPathTargets(): EventTarget[] {
      const targets: EventTarget[] = [];
      for (let current = parentElement(element); current !== null; current = parentElement(current)) {
        targets[targets.length] = current;
      }
      targets[targets.length] = element.ownerDocument;
      if (win !== null) targets[targets.length] = win;
      return targets;
    }

    function isDelegatedEventTarget(target: unknown): boolean {
      if (target === element) return false;
      if (target === win || target === element.ownerDocument) return true;
      return isNodeLike(target) && contains(target, element);
    }

    function classifyElement(
      stateToUpdate: BrowserSensitiveState,
      epochToUpdate: NonNullable<BrowserSensitiveState["active"]>,
      candidate: Element,
    ): void {
      classifySingleElement(stateToUpdate, epochToUpdate, candidate);
      if (epochToUpdate.poisoned) return;
      const _forOfItems57 = observedAncestors(candidate);
      for (let _forOfIndex57 = 0; _forOfIndex57 < _forOfItems57.length; _forOfIndex57 += 1) {
        const ancestor = _forOfItems57[_forOfIndex57]!;
        classifySingleElement(stateToUpdate, epochToUpdate, ancestor);
        if (epochToUpdate.poisoned) return;
      }
    }

    function classifySingleElement(
      stateToUpdate: BrowserSensitiveState,
      epochToUpdate: NonNullable<BrowserSensitiveState["active"]>,
      candidate: Element,
    ): void {
      const root = getRootNode(candidate);
      if (root !== candidate.ownerDocument && (!isShadowRootNode(root) || shadowRootMode(root) !== "open")) {
        epochToUpdate.poisoned = true;
        stateToUpdate.poisoned = true;
        return;
      }
      const nodeKey = `${input.markerId}:${nodeIdentity(stateToUpdate, candidate)}`;
      if (!arrayHasString(epochToUpdate.classifiedNodes, nodeKey)) {
        epochToUpdate.classifiedNodes[epochToUpdate.classifiedNodes.length] = nodeKey;
        if (epochToUpdate.classifiedNodes.length > input.maxClassifiedNodes) {
          epochToUpdate.poisoned = true;
          stateToUpdate.poisoned = true;
          return;
        }
      }
      const regionKey = nodeKey;
      if (isMaskableElement(candidate) && !arrayHasString(epochToUpdate.classifiedRegions, regionKey)) {
        epochToUpdate.classifiedRegions[epochToUpdate.classifiedRegions.length] = regionKey;
        if (epochToUpdate.classifiedElements !== undefined) {
          epochToUpdate.classifiedElements[epochToUpdate.classifiedElements.length] = candidate;
        }
        if (epochToUpdate.classifiedRegions.length > input.maxMaskRegions) {
          epochToUpdate.poisoned = true;
          stateToUpdate.poisoned = true;
          return;
        }
      }
      markSensitiveElement(stateToUpdate, candidate, epochToUpdate.markerId);
    }

    function observedAncestors(candidate: Element): Element[] {
      const result: Element[] = [];
      for (let current = parentElementAcrossShadow(candidate); current !== null; current = parentElementAcrossShadow(current)) {
        if (isObservationCandidate(current)) result[result.length] = current;
      }
      return result;
    }

    function parentElementAcrossShadow(node: Node): Element | null {
      const directParent = parentElement(node);
      if (directParent !== null) return directParent;
      const root = getRootNode(node);
      return isShadowRootNode(root) && shadowRootMode(root) === "open" ? shadowRootHost(root) : null;
    }

    function isObservationCandidate(candidate: Element): boolean {
      const tag = tagName(candidate);
      return tag === "button" ||
        (tag === "a" && hasAttribute(candidate, "href")) ||
        tag === "input" ||
        tag === "textarea" ||
        tag === "select" ||
        hasAttribute(candidate, "role") ||
        hasAttribute(candidate, "data-qualigence-observe");
    }

    function isMaskableElement(candidate: Element): boolean {
      const tag = tagName(candidate);
      return tag !== "head" && tag !== "title" && tag !== "meta" && tag !== "script" && tag !== "style" && tag !== "option";
    }

    function nodeIdentity(stateToUpdate: BrowserSensitiveState, candidate: Element): string {
      const host = candidate as unknown as Element & Record<string, unknown>;
      const existingId = host.__qualigenceSensitiveNodeIdentity;
      if (typeof existingId === "string") return existingId;
      stateToUpdate.nextNodeOrdinal += 1;
      const nodeId = `qn-${stateToUpdate.nextNodeOrdinal}`;
      apply(dom.objectDefineProperty, Object, [host, "__qualigenceSensitiveNodeIdentity", {
        configurable: false,
        enumerable: false,
        value: nodeId,
        writable: false,
      }]);
      return nodeId;
    }

    function markSensitiveElement(
      stateToUpdate: BrowserSensitiveState,
      candidate: Element,
      markerId: string,
    ): void {
      const host = candidate as unknown as Element & Record<string, unknown>;
      const current = host[input.targetIdsProperty];
      if (dom.arrayIsArray(current)) {
        if (!arrayHasString(current, markerId)) current[current.length] = markerId;
      } else {
        apply(dom.objectDefineProperty, Object, [host, input.targetIdsProperty, {
          configurable: false,
          enumerable: false,
          value: [markerId],
          writable: false,
        }]);
      }
      if (!hasAttribute(candidate, input.maskAttribute)) {
        stateToUpdate.nextMaskOrdinal += 1;
        setAttribute(candidate, input.maskAttribute, `qm-${stateToUpdate.nextMaskOrdinal}`);
      }
    }

    function isMarkedSensitive(candidate: Element, markerId: string): boolean {
      const ids = (candidate as unknown as Element & Record<string, unknown>)[input.targetIdsProperty];
      return dom.arrayIsArray(ids) && arrayHasString(ids, markerId);
    }

    function reflectedCandidateForms(target: Element, actionKind: "input" | "select"): string[] {
      const values: string[] = [];
      if (actionKind === "input" && (tagName(target) === "input" || tagName(target) === "textarea")) {
        const currentValue = fieldValue(target);
        pushUniqueNonEmpty(values, currentValue);
        pushUniqueNonEmpty(values, normalizeBrowserLineBreaks(currentValue));
        pushUniqueNonEmpty(values, normalizeVisibleSensitiveForm(currentValue));
      }
      if (actionKind === "select" && tagName(target) === "select") {
        pushUniqueNonEmpty(values, fieldValue(target));
        const _forOfItems58 = selectedOptions(target);
        for (let _forOfIndex58 = 0; _forOfIndex58 < _forOfItems58.length; _forOfIndex58 += 1) {
          const option = _forOfItems58[_forOfIndex58]!;
          pushUniqueNonEmpty(values, optionValue(option));
          pushUniqueNonEmpty(values, optionText(option));
          pushUniqueNonEmpty(values, optionLabel(option));
        }
      }
      return values;
    }

    function mergeSensitiveForms(current: string[], next: readonly string[]): string[] {
      const merged: string[] = [];
      const _forOfItems59 = current;
      for (let _forOfIndex59 = 0; _forOfIndex59 < _forOfItems59.length; _forOfIndex59 += 1) {
        const value = _forOfItems59[_forOfIndex59]!;
        pushUniqueNonEmpty(merged, value);
      }
      const _forOfItems60 = next;
      for (let _forOfIndex60 = 0; _forOfIndex60 < _forOfItems60.length; _forOfIndex60 += 1) {
        const value = _forOfItems60[_forOfIndex60]!;
        pushUniqueNonEmpty(merged, value);
      }
      return merged;
    }

    function normalizeVisibleSensitiveForm(value: string): string {
      return stringTrim(collapseWhitespace(stringNormalize(value, "NFC")));
    }

    function normalizeBrowserLineBreaks(value: string): string {
      let result = "";
      for (let index = 0; index < value.length; index += 1) {
        const character = value[index] ?? "";
        if (character === "\r") {
          if (value[index + 1] === "\n") index += 1;
          result += "\n";
        } else {
          result += character;
        }
      }
      return result;
    }

    function collapseWhitespace(value: string): string {
      let result = "";
      let pendingSpace = false;
      for (let index = 0; index < value.length; index += 1) {
        const character = value[index] ?? "";
        if (isWhitespaceCharacter(character)) {
          pendingSpace = true;
        } else {
          if (pendingSpace && result !== "") result += " ";
          result += character;
          pendingSpace = false;
        }
      }
      return result;
    }

    function safeMaskIdPart(value: string): string {
      let result = "";
      for (let index = 0; index < value.length; index += 1) {
        const character = value[index] ?? "";
        result += isAsciiMaskIdCharacter(character) ? character : "_";
      }
      return result;
    }

    function isAsciiMaskIdCharacter(character: string): boolean {
      return (character >= "A" && character <= "Z") ||
        (character >= "a" && character <= "z") ||
        (character >= "0" && character <= "9") ||
        character === "_" || character === "-";
    }

    function isWhitespaceCharacter(character: string): boolean {
      return character === " " || character === "\t" || character === "\n" || character === "\r" || character === "\f" || character === "\v" ||
        character === "\u00a0" || character === "\u1680" || character === "\u180e" || character === "\u2000" || character === "\u2001" ||
        character === "\u2002" || character === "\u2003" || character === "\u2004" || character === "\u2005" || character === "\u2006" ||
        character === "\u2007" || character === "\u2008" || character === "\u2009" || character === "\u200a" || character === "\u2028" ||
        character === "\u2029" || character === "\u202f" || character === "\u205f" || character === "\u3000" || character === "\ufeff";
    }

    function fieldValue(candidate: Element): string {
      const tag = tagName(candidate);
      if (tag === "input") return inputValue(candidate);
      if (tag === "textarea") return textareaValue(candidate);
      if (tag === "select") return selectValue(candidate);
      return "";
    }

    function fieldPlaceholder(candidate: Element): string {
      const tag = tagName(candidate);
      if (tag === "input") return inputPlaceholder(candidate);
      if (tag === "textarea") return textareaPlaceholder(candidate);
      return "";
    }

    function sensitiveValues(candidate: Element): readonly string[] {
      const values: string[] = [];
      const text = directText(candidate);
      if (text !== "") values[values.length] = text;
      const observedText = isObservationCandidate(candidate) ? textContent(candidate) : "";
      if (observedText !== "" && observedText !== text) values[values.length] = observedText;
      const tag = tagName(candidate);
      if (tag === "input" || tag === "textarea") {
        if (fieldValue(candidate) !== "") values[values.length] = fieldValue(candidate);
        if (fieldPlaceholder(candidate) !== "") values[values.length] = fieldPlaceholder(candidate);
      }
      if (tag === "select") {
        if (fieldValue(candidate) !== "") values[values.length] = fieldValue(candidate);
        const selectedOption = firstSelectedOption(candidate);
        const selectedText = selectedOption === undefined ? "" : optionText(selectedOption);
        if (selectedText !== "") values[values.length] = selectedText;
      }
      const _forOfItems61 = ["role", "aria-label", "title", "value"] as const;
      for (let _forOfIndex61 = 0; _forOfIndex61 < _forOfItems61.length; _forOfIndex61 += 1) {
        const attribute = _forOfItems61[_forOfIndex61]!;
        const attributeValue = getAttribute(candidate, attribute);
        if (attributeValue !== null && attributeValue !== "") values[values.length] = attributeValue;
      }
      return values;
    }

    function directText(candidate: Element): string {
      let text = "";
      const _forOfItems62 = childNodes(candidate);
      for (let _forOfIndex62 = 0; _forOfIndex62 < _forOfItems62.length; _forOfIndex62 += 1) {
        const node = _forOfItems62[_forOfIndex62]!;
        if (isTextNode(node)) text += textData(node);
      }
      return text;
    }

    function carriesForm(value: string, form: string): boolean {
      return value === form || (form !== "" && stringIncludes(value, form));
    }
  }, {
    markerId: prepared.markerId,
    retainRecord,
    kind,
    stateProperty: SENSITIVE_EVIDENCE_STATE_PROPERTY,
    targetIdsProperty: SENSITIVE_TARGET_IDS_PROPERTY,
    maskAttribute: SENSITIVE_MASK_ID_ATTRIBUTE,
    runtimeRegistryProperty: SENSITIVE_SHADOW_ROOTS_PROPERTY,
    maxMutationRecords: MAX_REFLECTED_MUTATION_RECORDS,
    maxClassifiedNodes: MAX_REFLECTED_NODES,
    maxMaskRegions: MAX_REFLECTED_REGIONS,
  });
}

function sensitiveInputForms(value: string): string[] {
  const forms = new Set<string>([value]);
  const visible = value.normalize("NFC").replace(/\s+/g, " ").trim();
  if (visible !== "") forms.add(visible);
  return [...forms];
}

async function markSensitiveTarget(
  locator: Locator,
  markerId: string,
): Promise<void> {
  await locator.evaluate(
    (element, input) => {
      type NativeDomAuthority = {
        readonly arrayIsArray: typeof Array.isArray;
        readonly objectDefineProperty: typeof Object.defineProperty;
        readonly reflectApply: typeof Reflect.apply;
      };
      const dom = ((element.ownerDocument.defaultView as unknown as Record<string, { readonly nativeDom?: NativeDomAuthority } | undefined>)[input.runtimeRegistryProperty])?.nativeDom;
      if (dom === undefined || typeof dom.arrayIsArray !== "function" || typeof dom.objectDefineProperty !== "function" || typeof dom.reflectApply !== "function") {
        throw new Error("Sensitive DOM authority is unavailable.");
      }
      const host = element as unknown as Element & Record<string, unknown>;
      const current = host[input.property];
      if (dom.arrayIsArray(current)) {
        let found = false;
        const _forOfItems63 = current;
        for (let _forOfIndex63 = 0; _forOfIndex63 < _forOfItems63.length; _forOfIndex63 += 1) {
          const markerId = _forOfItems63[_forOfIndex63]!;
          if (markerId === input.markerId) found = true;
        }
        if (!found) current[current.length] = input.markerId;
        // The epoch may have installed a reversible marker before permit
        // dispatch. Once dispatch succeeds, freeze the exact marker list used
        // by the host/CDP authority snapshot.
        dom.reflectApply(dom.objectDefineProperty, Object, [host, input.property, {
          configurable: false,
          enumerable: false,
          value: current,
          writable: false,
        }]);
        return;
      }
      if (current !== undefined) throw new Error("Sensitive target marker is unavailable.");
      dom.reflectApply(dom.objectDefineProperty, Object, [host, input.property, {
        configurable: false,
        enumerable: false,
        value: [input.markerId],
        writable: false,
      }]);
    },
    {
      property: SENSITIVE_TARGET_IDS_PROPERTY,
      markerId,
      runtimeRegistryProperty: SENSITIVE_SHADOW_ROOTS_PROPERTY,
    },
  );
}

interface InputSensitiveForms {
  readonly sensitiveTargetIds: readonly string[];
  readonly value: string;
}

interface SelectSensitiveForms extends InputSensitiveForms {
  readonly selectedOptionValue: string;
  readonly selectedOptionText: string;
}

async function readInputSensitiveForms(locator: Locator): Promise<InputSensitiveForms> {
  return locator.evaluate((element, input) => {
    type NativeDomAuthority = {
      readonly arrayIsArray: typeof Array.isArray;
      readonly reflectApply: typeof Reflect.apply;
      readonly stringToLowerCase: typeof String.prototype.toLowerCase;
      readonly elementTagNameGet: (() => string) | undefined;
      readonly htmlInputElementValueGet: (() => string) | undefined;
      readonly htmlTextAreaElementValueGet: (() => string) | undefined;
    };
    const ids = (element as unknown as Element & Record<string, unknown>)[input.property];
    const dom = ((element.ownerDocument.defaultView as unknown as Record<string, { readonly nativeDom?: NativeDomAuthority } | undefined>)[input.runtimeRegistryProperty])?.nativeDom;
    if (dom === undefined || dom.elementTagNameGet === undefined || typeof dom.arrayIsArray !== "function" || typeof dom.reflectApply !== "function" || typeof dom.stringToLowerCase !== "function") {
      throw new Error("Sensitive DOM authority is unavailable.");
    }
    const sensitiveTargetIds = dom.arrayIsArray(ids) && allStrings(ids)
      ? ids
      : [];
    function allStrings(values: readonly unknown[]): boolean {
      const _forOfItems64 = values;
      for (let _forOfIndex64 = 0; _forOfIndex64 < _forOfItems64.length; _forOfIndex64 += 1) {
        const entry = _forOfItems64[_forOfIndex64]!;
        if (typeof entry !== "string") return false;
      }
      return true;
    }
    const tag = dom.reflectApply(dom.stringToLowerCase, dom.reflectApply(dom.elementTagNameGet, element, []) as string, []) as string;
    if (tag === "input") {
      if (dom.htmlInputElementValueGet === undefined) throw new Error("Sensitive input value authority is unavailable.");
      return { sensitiveTargetIds, value: dom.reflectApply(dom.htmlInputElementValueGet, element, []) as string };
    }
    if (tag === "textarea") {
      if (dom.htmlTextAreaElementValueGet === undefined) throw new Error("Sensitive textarea value authority is unavailable.");
      return { sensitiveTargetIds, value: dom.reflectApply(dom.htmlTextAreaElementValueGet, element, []) as string };
    }
    throw new Error("Sensitive target is not an input field.");
  }, {
    property: SENSITIVE_TARGET_IDS_PROPERTY,
    runtimeRegistryProperty: SENSITIVE_SHADOW_ROOTS_PROPERTY,
  });
}

async function readSelectSensitiveForms(locator: Locator): Promise<SelectSensitiveForms> {
  return locator.evaluate((element, input) => {
    type NativeDomAuthority = {
      readonly arrayIsArray: typeof Array.isArray;
      readonly htmlCollectionItem: (index: number) => Element | null;
      readonly htmlCollectionLengthGet: (() => number) | undefined;
      readonly reflectApply: typeof Reflect.apply;
      readonly stringToLowerCase: typeof String.prototype.toLowerCase;
      readonly elementTagNameGet: (() => string) | undefined;
      readonly htmlOptionElementTextGet: (() => string) | undefined;
      readonly htmlOptionElementValueGet: (() => string) | undefined;
      readonly htmlSelectElementSelectedOptionsGet: (() => HTMLCollectionOf<HTMLOptionElement>) | undefined;
      readonly htmlSelectElementValueGet: (() => string) | undefined;
    };
    const ids = (element as unknown as Element & Record<string, unknown>)[input.property];
    const dom = ((element.ownerDocument.defaultView as unknown as Record<string, { readonly nativeDom?: NativeDomAuthority } | undefined>)[input.runtimeRegistryProperty])?.nativeDom;
    if (dom === undefined || dom.elementTagNameGet === undefined || dom.htmlSelectElementValueGet === undefined ||
      dom.htmlSelectElementSelectedOptionsGet === undefined || dom.htmlOptionElementValueGet === undefined ||
      dom.htmlOptionElementTextGet === undefined || typeof dom.arrayIsArray !== "function" ||
      typeof dom.htmlCollectionItem !== "function" || typeof dom.htmlCollectionLengthGet !== "function" ||
      typeof dom.reflectApply !== "function" || typeof dom.stringToLowerCase !== "function") {
      throw new Error("Sensitive select authority is unavailable.");
    }
    const sensitiveTargetIds = dom.arrayIsArray(ids) && allStrings(ids)
      ? ids
      : [];
    function allStrings(values: readonly unknown[]): boolean {
      const _forOfItems65 = values;
      for (let _forOfIndex65 = 0; _forOfIndex65 < _forOfItems65.length; _forOfIndex65 += 1) {
        const entry = _forOfItems65[_forOfIndex65]!;
        if (typeof entry !== "string") return false;
      }
      return true;
    }
    if ((dom.reflectApply(dom.stringToLowerCase, dom.reflectApply(dom.elementTagNameGet, element, []) as string, []) as string) !== "select") {
      throw new Error("Sensitive select target is not a select field.");
    }
    const selectedOptions = dom.reflectApply(dom.htmlSelectElementSelectedOptionsGet, element, []) as HTMLCollectionOf<HTMLOptionElement>;
    const selectedOptionsLength = dom.reflectApply(dom.htmlCollectionLengthGet, selectedOptions, []) as unknown;
    if (typeof selectedOptionsLength !== "number" || !Number.isSafeInteger(selectedOptionsLength) || selectedOptionsLength < 1) {
      throw new Error("Sensitive select target has no selected option.");
    }
    const selectedOption = dom.reflectApply(dom.htmlCollectionItem, selectedOptions, [0]) as HTMLOptionElement | null;
    if (selectedOption === null) {
      throw new Error("Sensitive select target has no selected option.");
    }
    return {
      sensitiveTargetIds,
      value: dom.reflectApply(dom.htmlSelectElementValueGet, element, []) as string,
      selectedOptionValue: dom.reflectApply(dom.htmlOptionElementValueGet, selectedOption, []) as string,
      selectedOptionText: dom.reflectApply(dom.htmlOptionElementTextGet, selectedOption, []) as string,
    };
  }, {
    property: SENSITIVE_TARGET_IDS_PROPERTY,
    runtimeRegistryProperty: SENSITIVE_SHADOW_ROOTS_PROPERTY,
  });
}

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
    for (const maskId of maskIds) {
      const nodeId = await uniqueCdpNodeIdForMask(cdp, maskId);
      const box = await cdp.send("DOM.getBoxModel", { nodeId }).catch(() => undefined);
      if (box === undefined) continue;
      const described = await cdp.send("DOM.describeNode", { nodeId }) as {
        readonly node?: { readonly backendNodeId?: number };
      };
      const backendNodeId = described.node?.backendNodeId;
      if (typeof backendNodeId !== "number" || !Number.isSafeInteger(backendNodeId)) {
        throw new Error("Sensitive mask backend node is unavailable.");
      }
      entries[entries.length] = { markerId, maskId, backendNodeId };
    }
    if (entries.length === 0) {
      throw new Error("Sensitive mask snapshot is empty.");
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
      readonly objectDefineProperty: typeof Object.defineProperty;
      readonly reflectApply: typeof Reflect.apply;
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
        active.deferredRecords.push(...records);
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
        const records = [...active.deferredRecords, ...active.observer.takeRecords()];
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
      const records = [...activeEpoch.deferredRecords, ...activeEpoch.observer.takeRecords()];
      activeEpoch.deferredRecords = [];
      processMutationRecords(activeEpoch, records, true);
    };
    epoch = activeEpoch;
    state.active = activeEpoch;
    classifyElement(element, activeEpoch);
    observeSensitiveMutations(observer, element.ownerDocument);
    for (const root of shadowRoots()) observeSensitiveMutations(observer, root);
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
        candidate.objectDefineProperty,
        candidate.reflectApply,
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
      for (const fn of required) {
        if (typeof fn !== "function") return undefined;
      }
      return candidate;
    }

    function apply<T>(fn: (...args: never[]) => T, receiver: unknown, args: readonly unknown[] = []): T {
      return dom.reflectApply(fn, receiver, args as never[]) as T;
    }

    function arrayFrom<T>(items: ArrayLike<T> | Iterable<T>): T[] {
      return apply(dom.arrayFrom as (...args: never[]) => T[], Array, [items]);
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
      return arrayFrom(apply(dom.documentQuerySelectorAll, element.ownerDocument, [selector]));
    }

    function queryRoot(root: ShadowRoot, selector: string): Element[] {
      return arrayFrom(apply(dom.documentFragmentQuerySelectorAll, root, [selector]));
    }

    function queryDescendants(candidate: Element): Element[] {
      return arrayFrom(apply(dom.elementQuerySelectorAll, candidate, ["*"]));
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
      return apply(dom.elementTagNameGet!, candidate).toLowerCase();
    }

    function childNodes(node: Node): ChildNode[] {
      return arrayFrom(apply(dom.nodeChildNodesGet!, node));
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
      return arrayFrom(apply(dom.htmlSelectElementOptionsGet!, candidate));
    }

    function selectedOptions(candidate: Element): HTMLOptionElement[] {
      return arrayFrom(apply(dom.htmlSelectElementSelectedOptionsGet!, candidate));
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
      for (const value of values) {
        if (value === candidate) return true;
      }
      return false;
    }

    function arrayHasIdentity<T>(values: readonly T[], candidate: T): boolean {
      for (const value of values) {
        if (value === candidate) return true;
      }
      return false;
    }

    function pushUniqueNonEmpty(values: string[], candidate: string): void {
      if (candidate !== "" && !arrayHasString(values, candidate)) values[values.length] = candidate;
    }

    function baselineContainsAll(baseline: readonly string[] | undefined, matches: readonly string[]): boolean {
      if (baseline === undefined) return false;
      for (const value of matches) {
        if (!arrayHasString(baseline, value)) return false;
      }
      return true;
    }

    function reflectedCandidateForms(target: Element, actionKind: "input" | "select", source: string): string[] {
      const values: string[] = [];
      pushUniqueNonEmpty(values, source);
      if (actionKind === "input") {
        const lineFeed = String.fromCharCode(10);
        const carriageReturn = String.fromCharCode(13);
        const browserValue = source.split(carriageReturn + lineFeed).join(lineFeed).split(carriageReturn).join(lineFeed);
        pushUniqueNonEmpty(values, browserValue);
        pushUniqueNonEmpty(values, normalizeVisibleSensitiveForm(browserValue));
      }
      if (actionKind === "select" && tagName(target) === "select") {
        for (const option of selectOptions(target)) {
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
      for (const candidate of observableElements()) {
        const matches: string[] = [];
        for (const value of sensitiveValues(candidate)) {
          for (const form of formsToMatch) {
            if (carriesForm(value, form)) pushUniqueNonEmpty(matches, value);
          }
        }
        if (matches.length > 0) weakMapSet(result, candidate, matches);
      }
      return result;
    }

    function baselineShadowSensitiveForms(formsToMatch: readonly string[]): WeakMap<Node, readonly string[]> {
      const result = createWeakMap<Node, readonly string[]>();
      for (const root of shadowRoots()) {
        rememberSensitiveBaseline(result, root, shadowRootValues(root), formsToMatch);
        for (const candidate of queryRoot(root, "*")) {
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
      for (const value of values) {
        for (const form of formsToMatch) {
          if (carriesForm(value, form)) pushUniqueNonEmpty(matches, value);
        }
      }
      if (matches.length > 0) weakMapSet(result, node, matches);
    }

    function sensitiveMatches(candidate: Element, formsToMatch: readonly string[]): string[] {
      const matches: string[] = [];
      for (const value of sensitiveValues(candidate)) {
        for (const form of formsToMatch) {
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
      for (const listenerType of sensitiveEventTypes(eventType)) {
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
      for (const entry of registry?.listenerTargets ?? []) {
        if (entry.type !== listenerType) continue;
        if (isInstrumentationListener(entry.listener)) continue;
        if (isDelegatedEventTarget(entry.target)) return true;
      }
      return false;
    }

    function hasDelegatedEventHandlerProperty(listenerType: "input" | "change"): boolean {
      const handlerName = `on${listenerType}`;
      for (const target of delegatedEventPathTargets()) {
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
        targets.push(current);
      }
      targets.push(element.ownerDocument);
      if (win !== null) targets.push(win);
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
      for (const candidate of observableElements()) {
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
      for (const root of shadowRoots()) {
        for (const value of shadowRootValues(root)) {
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
        for (const candidate of queryRoot(root, "*")) {
          for (const value of sensitiveValues(candidate)) {
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
      for (const record of records) {
        if (record.type !== "attributes" || record.attributeName !== input.maskAttribute) {
          applicationRecords[applicationRecords.length] = record;
        }
      }
      epochToUpdate.mutationOrdinal += applicationRecords.length;
      if (epochToUpdate.mutationOrdinal > input.maxMutationRecords) {
        poison(epochToUpdate);
        return;
      }
      for (const record of applicationRecords) {
        if (touchesUnprovableShadowRoot(record)) {
          poison(epochToUpdate);
          return;
        }
        for (const candidate of mutationCandidateElements(record)) {
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
      const touchedNodes = [record.target, ...arrayFrom(record.addedNodes)];
      for (const node of touchedNodes) {
        const root = isShadowRootNode(node) ? node : getRootNode(node);
        if (isShadowRootNode(root) && shadowRootMode(root) !== "open") return true;
      }
      return false;
    }

    function mutationCandidateElements(record: MutationRecord): Element[] {
      const candidates: Element[] = [];
      addNode(record.target, candidates);
      if (record.type === "childList") {
        for (const node of arrayFrom(record.addedNodes)) addNode(node, candidates);
      }
      return candidates;
    }

    function addNode(node: Node, candidates: Element[]): void {
      if (isElementNode(node)) {
        candidates.push(node);
        candidates.push(...queryDescendants(node));
        candidates.push(...observedAncestors(node));
        return;
      }
      const parent = parentElementAcrossShadow(node);
      if (parent !== null) {
        candidates.push(parent);
        candidates.push(...observedAncestors(parent));
      }
    }

    function classifyElement(candidate: Element, epochToUpdate: BrowserSensitiveEpoch): void {
      classifySingleElement(candidate, epochToUpdate);
      if (epochToUpdate.poisoned) return;
      for (const ancestor of observedAncestors(candidate)) {
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
        epochToUpdate.classifiedElements.push(candidate);
        if (epochToUpdate.classifiedNodes.length > input.maxClassifiedNodes) {
          poison(epochToUpdate);
          return;
        }
      }
      const regionKey = nodeKey;
      if (!arrayHasString(epochToUpdate.classifiedRegions, regionKey)) {
        epochToUpdate.classifiedRegions[epochToUpdate.classifiedRegions.length] = regionKey;
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
        if (isObservationCandidate(current)) result.push(current);
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
      for (const root of shadowRoots()) {
        if (shadowRootMode(root) === "open") elements.push(...queryRoot(root, "*"));
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
        if (!arrayHasString(current, markerId)) current.push(markerId);
      } else {
        apply(dom.objectDefineProperty, Object, [host, input.targetIdsProperty, {
          configurable: false,
          enumerable: false,
          value: [markerId],
          writable: false,
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
      if (text !== "") values.push(text);
      const observedText = isObservationCandidate(candidate) ? textContent(candidate) : "";
      if (observedText !== "" && observedText !== text) values.push(observedText);
      const tag = tagName(candidate);
      if (tag === "input" || tag === "textarea") {
        if (fieldValue(candidate) !== "") values.push(fieldValue(candidate));
        if (fieldPlaceholder(candidate) !== "") values.push(fieldPlaceholder(candidate));
      }
      if (tag === "select") {
        if (fieldValue(candidate) !== "") values.push(fieldValue(candidate));
        const selectedOption = selectedOptions(candidate)[0];
        const selectedText = selectedOption === undefined ? "" : optionText(selectedOption);
        if (selectedText !== "") values.push(selectedText);
      }
      for (const attribute of ["aria-label", "title", "value"] as const) {
        const attributeValue = getAttribute(candidate, attribute);
        if (attributeValue !== null && attributeValue !== "") values.push(attributeValue);
      }
      return values;
    }

    function directText(candidate: Element): string {
      let text = "";
      for (const node of childNodes(candidate)) {
        if (isTextNode(node)) text += textData(node);
      }
      return text;
    }

    function shadowRootValues(root: ShadowRoot): readonly string[] {
      const values: string[] = [];
      let direct = "";
      for (const node of childNodes(root)) {
        if (isTextNode(node)) direct += textData(node);
      }
      if (direct !== "") values.push(direct);
      const fullText = textContent(root);
      if (fullText !== "" && fullText !== direct) values.push(fullText);
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
        if (registry !== undefined) registry.shadowRootOverflow = true;
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
      for (const root of registry?.roots ?? []) {
        if (isShadowRootNode(root) && !addRoot(root)) return pending;
      }
      for (const candidate of queryDocument("*")) {
        const candidateShadowRoot = shadowRoot(candidate);
        if (candidateShadowRoot !== null && !addRoot(candidateShadowRoot)) return pending;
      }
      for (let index = 0; index < pending.length; index += 1) {
        const root = pending[index]!;
        for (const candidate of queryRoot(root, "*")) {
          const nestedShadowRoot = shadowRoot(candidate);
          if (nestedShadowRoot !== null && !addRoot(nestedShadowRoot)) return pending;
        }
      }
      return pending;
    }

    function normalizeVisibleSensitiveForm(value: string): string {
      return value.normalize("NFC").replace(/\s+/g, " ").trim();
    }

    function carriesForm(value: string, form: string | readonly string[]): boolean {
      const forms = dom.arrayIsArray(form) ? form : [form];
      for (const candidate of forms) {
        if (value === candidate || (candidate !== "" && value.includes(candidate))) return true;
      }
      return false;
    }

    function shadowBaselineAllows(node: Node, epochToUpdate: BrowserSensitiveEpoch, value: string): boolean {
      return arrayHasString(weakMapGet(epochToUpdate.shadowBaseline, node) ?? [], value);
    }

    function shadowRootOverflow(): boolean {
      const registry = (win as unknown as Record<string, unknown>)[input.runtimeRegistryProperty] as {
        readonly shadowRootOverflow?: unknown;
      } | undefined;
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
    type NativeDomAuthority = {
      readonly arrayFrom: typeof Array.from;
      readonly arrayIsArray: typeof Array.isArray;
      readonly objectDefineProperty: typeof Object.defineProperty;
      readonly reflectApply: typeof Reflect.apply;
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
    const maybeDom = nativeDomAuthority();
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
      const records = [...active.deferredRecords, ...active.observer.takeRecords()];
      active.deferredRecords = [];
      processMutationRecords(
        state,
        active,
        records,
        canClassifyCurrentDispatch(active) || (active.schedulerRegistrations ?? 0) > 0,
      );
    }
    active.inTargetDispatch = false;
    const retainSchedulerObserver = input.retainRecord && (active.schedulerRegistrations ?? 0) > 0;
    if (!retainSchedulerObserver) active.observer.disconnect();
    element.removeEventListener("input", active.targetCaptureListener, true);
    element.removeEventListener("change", active.targetCaptureListener, true);
    element.ownerDocument.removeEventListener("input", active.documentBubbleListener, false);
    element.ownerDocument.removeEventListener("change", active.documentBubbleListener, false);
    const maskIds = input.retainRecord ? assignSensitiveMaskIds(state, active) : [];
    if (input.retainRecord) {
      state.records.push({
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
      });
      if (retainSchedulerObserver) {
        state.retainedSchedulerEpochs ??= [];
        state.retainedSchedulerEpochs.push(active);
      }
    } else {
      cleanupSensitiveMarkers(active.markerId, active.classifiedElements ?? []);
    }
    const failed = input.retainRecord && (state.poisoned || active.poisoned);
    state.active = null;
    return failed ? { status: "failed" } : { status: "ok", maskIds };

    function nativeDomAuthority(): NativeDomAuthority | undefined {
      const registry = (win as unknown as Record<string, { readonly nativeDom?: NativeDomAuthority } | undefined>)[input.runtimeRegistryProperty];
      const candidate = registry?.nativeDom;
      if (candidate === undefined) return undefined;
      const required = [
        candidate.arrayFrom,
        candidate.arrayIsArray,
        candidate.objectDefineProperty,
        candidate.reflectApply,
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
      for (const fn of required) {
        if (typeof fn !== "function") return undefined;
      }
      return candidate;
    }

    function apply<T>(fn: (...args: never[]) => T, receiver: unknown, args: readonly unknown[] = []): T {
      return dom.reflectApply(fn, receiver, args as never[]) as T;
    }

    function arrayFrom<T>(items: ArrayLike<T> | Iterable<T>): T[] {
      return apply(dom.arrayFrom as (...args: never[]) => T[], Array, [items]);
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
      return arrayFrom(apply(dom.documentQuerySelectorAll, element.ownerDocument, [selector]));
    }

    function queryRoot(root: ShadowRoot, selector: string): Element[] {
      return arrayFrom(apply(dom.documentFragmentQuerySelectorAll, root, [selector]));
    }

    function queryDescendants(candidate: Element): Element[] {
      return arrayFrom(apply(dom.elementQuerySelectorAll, candidate, ["*"]));
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
      return apply(dom.elementTagNameGet!, candidate).toLowerCase();
    }

    function childNodes(node: Node): ChildNode[] {
      return arrayFrom(apply(dom.nodeChildNodesGet!, node));
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
      return arrayFrom(apply(dom.htmlSelectElementOptionsGet!, candidate));
    }

    function selectedOptions(candidate: Element): HTMLOptionElement[] {
      return arrayFrom(apply(dom.htmlSelectElementSelectedOptionsGet!, candidate));
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
      for (const value of values) {
        if (value === candidate) return true;
      }
      return false;
    }

    function arrayHasIdentity<T>(values: readonly T[], candidate: T): boolean {
      for (const value of values) {
        if (value === candidate) return true;
      }
      return false;
    }

    function pushUniqueNonEmpty(values: string[], candidate: string): void {
      if (candidate !== "" && !arrayHasString(values, candidate)) values[values.length] = candidate;
    }

    function baselineContainsAll(baseline: readonly string[] | undefined, matches: readonly string[]): boolean {
      if (baseline === undefined) return false;
      for (const value of matches) {
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
      if (elements.length === 0 || elements.length > input.maxMaskRegions) {
        epochToUpdate.poisoned = true;
        stateToUpdate.poisoned = true;
        return maskIds;
      }
      let ordinal = 0;
      for (const candidate of elements) {
        if (candidate.nodeType !== 1) {
          epochToUpdate.poisoned = true;
          stateToUpdate.poisoned = true;
          return maskIds;
        }
        ordinal += 1;
        const maskId = `qm-${epochToUpdate.markerId.replace(/[^A-Za-z0-9_-]/g, "_")}-${ordinal}`;
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
      for (const candidate of classifiedElements) {
        if (!arrayHasIdentity(candidates, candidate)) candidates[candidates.length] = candidate;
      }
      if (!arrayHasIdentity(candidates, element)) candidates[candidates.length] = element;
      for (const candidate of queryDocument("*")) {
        const ids = (candidate as unknown as Element & Record<string, unknown>)[input.targetIdsProperty];
        if (dom.arrayIsArray(ids) && arrayHasString(ids, markerId) && !arrayHasIdentity(candidates, candidate)) {
          candidates[candidates.length] = candidate;
        }
      }
      for (const candidate of candidates) {
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
      for (const id of ids) {
        if (id !== markerId) remaining[remaining.length] = id;
      }
      if (remaining.length === 0) {
        delete host[input.targetIdsProperty];
        removeAttribute(candidate, input.maskAttribute);
        return;
      }
      host[input.targetIdsProperty] = remaining;
    }

    function processCurrentSensitiveMatches(
      stateToUpdate: BrowserSensitiveState,
      epochToUpdate: NonNullable<BrowserSensitiveState["active"]>,
    ): void {
      for (const candidate of queryDocument("*")) {
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
      for (const record of records) {
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
      for (const record of applicationRecords) {
        if (touchesUnprovableShadowRoot(record)) {
          epochToUpdate.poisoned = true;
          stateToUpdate.poisoned = true;
          return;
        }
        for (const candidate of mutationCandidateElements(record)) {
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
      const touchedNodes = [record.target, ...arrayFrom(record.addedNodes)];
      for (const node of touchedNodes) {
        const root = isShadowRootNode(node) ? node : getRootNode(node);
        if (isShadowRootNode(root) && shadowRootMode(root) !== "open") return true;
      }
      return false;
    }

    function mutationCandidateElements(record: MutationRecord): Element[] {
      const candidates: Element[] = [];
      addNode(record.target, candidates);
      if (record.type === "childList") {
        for (const node of arrayFrom(record.addedNodes)) addNode(node, candidates);
      }
      return candidates;
    }

    function addNode(node: Node, candidates: Element[]): void {
      if (isElementNode(node)) {
        candidates.push(node);
        candidates.push(...queryDescendants(node));
        candidates.push(...observedAncestors(node));
        return;
      }
      const parent = parentElementAcrossShadow(node);
      if (parent !== null) {
        candidates.push(parent);
        candidates.push(...observedAncestors(parent));
      }
    }

    function sensitiveMatches(candidate: Element, formsToMatch: readonly string[]): string[] {
      const matches: string[] = [];
      for (const value of sensitiveValues(candidate)) {
        for (const form of formsToMatch) {
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
      for (const listenerType of sensitiveEventTypes(eventType)) {
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
      for (const entry of registry?.listenerTargets ?? []) {
        if (entry.type !== listenerType) continue;
        if (isInstrumentationListener(entry.listener)) continue;
        if (isDelegatedEventTarget(entry.target)) return true;
      }
      return false;
    }

    function hasDelegatedEventHandlerProperty(listenerType: "input" | "change"): boolean {
      const handlerName = `on${listenerType}`;
      for (const target of delegatedEventPathTargets()) {
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
        targets.push(current);
      }
      targets.push(element.ownerDocument);
      if (win !== null) targets.push(win);
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
      for (const ancestor of observedAncestors(candidate)) {
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
        if (epochToUpdate.classifiedElements !== undefined) {
          epochToUpdate.classifiedElements.push(candidate);
        }
        if (epochToUpdate.classifiedNodes.length > input.maxClassifiedNodes) {
          epochToUpdate.poisoned = true;
          stateToUpdate.poisoned = true;
          return;
        }
      }
      const regionKey = nodeKey;
      if (!arrayHasString(epochToUpdate.classifiedRegions, regionKey)) {
        epochToUpdate.classifiedRegions[epochToUpdate.classifiedRegions.length] = regionKey;
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
        if (isObservationCandidate(current)) result.push(current);
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
        if (!arrayHasString(current, markerId)) current.push(markerId);
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
        pushUniqueNonEmpty(values, currentValue.replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
        pushUniqueNonEmpty(values, normalizeVisibleSensitiveForm(currentValue));
      }
      if (actionKind === "select" && tagName(target) === "select") {
        pushUniqueNonEmpty(values, fieldValue(target));
        for (const option of selectedOptions(target)) {
          pushUniqueNonEmpty(values, optionValue(option));
          pushUniqueNonEmpty(values, optionText(option));
          pushUniqueNonEmpty(values, optionLabel(option));
        }
      }
      return values;
    }

    function mergeSensitiveForms(current: string[], next: readonly string[]): string[] {
      const merged: string[] = [];
      for (const value of current) pushUniqueNonEmpty(merged, value);
      for (const value of next) pushUniqueNonEmpty(merged, value);
      return merged;
    }

    function normalizeVisibleSensitiveForm(value: string): string {
      return value.normalize("NFC").replace(/\s+/g, " ").trim();
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
      if (text !== "") values.push(text);
      const observedText = isObservationCandidate(candidate) ? textContent(candidate) : "";
      if (observedText !== "" && observedText !== text) values.push(observedText);
      const tag = tagName(candidate);
      if (tag === "input" || tag === "textarea") {
        if (fieldValue(candidate) !== "") values.push(fieldValue(candidate));
        if (fieldPlaceholder(candidate) !== "") values.push(fieldPlaceholder(candidate));
      }
      if (tag === "select") {
        if (fieldValue(candidate) !== "") values.push(fieldValue(candidate));
        const selectedOption = selectedOptions(candidate)[0];
        const selectedText = selectedOption === undefined ? "" : optionText(selectedOption);
        if (selectedText !== "") values.push(selectedText);
      }
      for (const attribute of ["aria-label", "title", "value"] as const) {
        const attributeValue = getAttribute(candidate, attribute);
        if (attributeValue !== null && attributeValue !== "") values.push(attributeValue);
      }
      return values;
    }

    function directText(candidate: Element): string {
      let text = "";
      for (const node of childNodes(candidate)) {
        if (isTextNode(node)) text += textData(node);
      }
      return text;
    }

    function carriesForm(value: string, form: string): boolean {
      return value === form || (form !== "" && value.includes(form));
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
        for (const markerId of current) {
          if (markerId === input.markerId) found = true;
        }
        if (!found) current.push(input.markerId);
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
      readonly elementTagNameGet: (() => string) | undefined;
      readonly htmlInputElementValueGet: (() => string) | undefined;
      readonly htmlTextAreaElementValueGet: (() => string) | undefined;
    };
    const ids = (element as unknown as Element & Record<string, unknown>)[input.property];
    const dom = ((element.ownerDocument.defaultView as unknown as Record<string, { readonly nativeDom?: NativeDomAuthority } | undefined>)[input.runtimeRegistryProperty])?.nativeDom;
    if (dom === undefined || dom.elementTagNameGet === undefined || typeof dom.arrayIsArray !== "function" || typeof dom.reflectApply !== "function") {
      throw new Error("Sensitive DOM authority is unavailable.");
    }
    const sensitiveTargetIds = dom.arrayIsArray(ids) && allStrings(ids)
      ? ids
      : [];
    function allStrings(values: readonly unknown[]): boolean {
      for (const entry of values) {
        if (typeof entry !== "string") return false;
      }
      return true;
    }
    const tag = (dom.reflectApply(dom.elementTagNameGet, element, []) as string).toLowerCase();
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
      readonly reflectApply: typeof Reflect.apply;
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
      dom.htmlOptionElementTextGet === undefined || typeof dom.arrayIsArray !== "function" || typeof dom.reflectApply !== "function") {
      throw new Error("Sensitive select authority is unavailable.");
    }
    const sensitiveTargetIds = dom.arrayIsArray(ids) && allStrings(ids)
      ? ids
      : [];
    function allStrings(values: readonly unknown[]): boolean {
      for (const entry of values) {
        if (typeof entry !== "string") return false;
      }
      return true;
    }
    if ((dom.reflectApply(dom.elementTagNameGet, element, []) as string).toLowerCase() !== "select") {
      throw new Error("Sensitive select target is not a select field.");
    }
    const selectedOption = (dom.reflectApply(dom.htmlSelectElementSelectedOptionsGet, element, []) as HTMLCollectionOf<HTMLOptionElement>)[0];
    if (selectedOption === undefined) {
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

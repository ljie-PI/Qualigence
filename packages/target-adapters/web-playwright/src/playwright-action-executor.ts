import type {
  ActionExecutor,
  ActionOutcome,
  AnyResolvedAction,
  ResolvedAction,
} from "@qualigence/runner-kernel";
import type { Locator } from "playwright";
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
              if (startedEpoch.status === "failed") {
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
              if (epochResult.status === "failed") {
                this.session.abandonSensitiveEvidenceDispatch(sensitiveEvidence);
              } else {
                await this.completeInputSensitiveEvidence(locator, sensitiveEvidence);
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
              if (startedEpoch.status === "failed") {
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
              if (epochResult.status === "failed") {
                this.session.abandonSensitiveEvidenceDispatch(sensitiveEvidence);
              } else {
                await this.completeSelectSensitiveEvidence(locator, sensitiveEvidence);
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
    locator: Locator,
    prepared: PreparedSensitiveEvidenceRecord,
  ): Promise<void> {
    try {
      await markSensitiveTarget(locator, prepared.markerId);
      const observed = await readInputSensitiveForms(locator);
      if (!observed.sensitiveTargetIds.includes(prepared.markerId)) {
        this.session.markSensitiveEvidenceUnavailable();
        return;
      }
      this.session.completeSensitiveEvidenceRecord(prepared, sensitiveInputForms(observed.value));
    } catch {
      this.session.markSensitiveEvidenceUnavailable();
    }
  }

  private async completeSelectSensitiveEvidence(
    locator: Locator,
    prepared: PreparedSensitiveEvidenceRecord,
  ): Promise<void> {
    try {
      await markSensitiveTarget(locator, prepared.markerId);
      const observed = await readSelectSensitiveForms(locator);
      if (!observed.sensitiveTargetIds.includes(prepared.markerId)) {
        this.session.markSensitiveEvidenceUnavailable();
        return;
      }
      this.session.completeSensitiveEvidenceRecord(prepared, [
        observed.value,
        observed.selectedOptionValue,
        observed.selectedOptionText,
      ]);
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

interface PageSensitiveEpochResult {
  readonly status: "ok" | "failed";
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
    };
    type BrowserSensitiveEpoch = {
      markerId: string;
      forms: string[];
      mutationOrdinal: number;
      deferredRecords: MutationRecord[];
      classifiedNodes: Set<string>;
      classifiedRegions: Set<string>;
      classifiedElements: Element[];
      baseline: WeakMap<Element, ReadonlySet<string>>;
      shadowBaseline: WeakMap<Node, ReadonlySet<string>>;
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
      baseline: WeakMap<Element, ReadonlySet<string>>;
      shadowBaseline: WeakMap<Node, ReadonlySet<string>>;
      classifiedNodes: Set<string>;
      classifiedRegions: Set<string>;
      classifiedElements: Element[];
      schedulerRegistrations: number;
      poisoned: boolean;
      observer?: MutationObserver;
    };

    const win = element.ownerDocument.defaultView;
    if (win === null) return { status: "failed" };
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
    stateHost[input.stateProperty] = state;
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
      classifiedNodes: new Set<string>(),
      classifiedRegions: new Set<string>(),
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

    function reflectedCandidateForms(target: Element, actionKind: "input" | "select", source: string): string[] {
      const values = new Set<string>([source]);
      if (actionKind === "input") {
        const browserValue = source.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        values.add(browserValue);
        values.add(normalizeVisibleSensitiveForm(browserValue));
      }
      if (actionKind === "select" && target instanceof HTMLSelectElement) {
        for (const option of Array.from(target.options)) {
          if (option.value === source || option.text === source || option.label === source) {
            values.add(option.value);
            values.add(option.text);
            values.add(option.label);
          }
        }
      }
      return Array.from(values).filter((value) => value !== "");
    }

    function baselineSensitiveForms(document: Document, formsToMatch: readonly string[]): WeakMap<Element, ReadonlySet<string>> {
      const result = new WeakMap<Element, ReadonlySet<string>>();
      void document;
      for (const candidate of observableElements()) {
        const matches = new Set<string>();
        for (const value of sensitiveValues(candidate)) {
          for (const form of formsToMatch) {
            if (carriesForm(value, form)) matches.add(value);
          }
        }
        if (matches.size > 0) result.set(candidate, matches);
      }
      return result;
    }

    function baselineShadowSensitiveForms(formsToMatch: readonly string[]): WeakMap<Node, ReadonlySet<string>> {
      const result = new WeakMap<Node, ReadonlySet<string>>();
      for (const root of shadowRoots()) {
        rememberSensitiveBaseline(result, root, shadowRootValues(root), formsToMatch);
        for (const candidate of Array.from(root.querySelectorAll("*"))) {
          rememberSensitiveBaseline(result, candidate, sensitiveValues(candidate), formsToMatch);
        }
      }
      return result;
    }

    function rememberSensitiveBaseline(
      result: WeakMap<Node, ReadonlySet<string>>,
      node: Node,
      values: readonly string[],
      formsToMatch: readonly string[],
    ): void {
      const matches = new Set<string>();
      for (const value of values) {
        for (const form of formsToMatch) {
          if (carriesForm(value, form)) matches.add(value);
        }
      }
      if (matches.size > 0) result.set(node, matches);
    }

    function sensitiveMatches(candidate: Element, formsToMatch: readonly string[]): string[] {
      const matches: string[] = [];
      for (const value of sensitiveValues(candidate)) {
        if (formsToMatch.some((form) => carriesForm(value, form))) matches.push(value);
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
        if (target instanceof Element && target.hasAttribute(handlerName)) return true;
        try {
          if (typeof (target as unknown as Record<string, unknown>)[handlerName] === "function") {
            return true;
          }
        } catch {
          return true;
        }
      }
      return false;
    }


    function markInstrumentationListener(listener: EventListener): void {
      Object.defineProperty(listener, "__qualigenceSensitiveInstrumentation", {
        configurable: true,
        enumerable: false,
        value: true,
        writable: false,
      });
    }

    function isInstrumentationListener(listener: unknown): boolean {
      return listener !== null &&
        (typeof listener === "function" || typeof listener === "object") &&
        (listener as Record<string, unknown>).__qualigenceSensitiveInstrumentation === true;
    }


    function delegatedEventPathTargets(): EventTarget[] {
      const targets: EventTarget[] = [];
      for (let current = element.parentElement; current !== null; current = current.parentElement) {
        targets.push(current);
      }
      targets.push(element.ownerDocument);
      if (win !== null) targets.push(win);
      return targets;
    }

    function isDelegatedEventTarget(target: unknown): boolean {
      if (target === element) return false;
      if (target === win || target === element.ownerDocument) return true;
      return target instanceof Node && target.contains(element);
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
        if (matches.every((value) => epochToUpdate.baseline.get(candidate)?.has(value) === true)) {
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
          if (root.mode === "open" && allowClassification) {
            classifyElement(root.host, epochToUpdate);
            if (epochToUpdate.poisoned) return;
            continue;
          }
          poison(epochToUpdate);
          return;
        }
        if (root.mode !== "closed") continue;
        for (const candidate of Array.from(root.querySelectorAll("*"))) {
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
      const applicationRecords = records.filter((record) =>
        record.type !== "attributes" || record.attributeName !== input.maskAttribute);
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
          if (matches.every((value) => epochToUpdate.baseline.get(candidate)?.has(value) === true)) {
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
      const touchedNodes = [record.target, ...Array.from(record.addedNodes)];
      return touchedNodes.some((node) => {
        const root = node instanceof ShadowRoot ? node : node.getRootNode();
        return root instanceof ShadowRoot && root.mode !== "open";
      });
    }

    function mutationCandidateElements(record: MutationRecord): Element[] {
      const candidates: Element[] = [];
      addNode(record.target, candidates);
      if (record.type === "childList") {
        for (const node of Array.from(record.addedNodes)) addNode(node, candidates);
      }
      return candidates;
    }

    function addNode(node: Node, candidates: Element[]): void {
      if (node instanceof Element) {
        candidates.push(node);
        candidates.push(...Array.from(node.querySelectorAll("*")));
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
      const root = candidate.getRootNode();
      if (root !== candidate.ownerDocument && (!(root instanceof ShadowRoot) || root.mode !== "open")) {
        poison(epochToUpdate);
        return;
      }
      const nodeKey = `${input.markerId}:${nodeIdentity(candidate)}`;
      if (!epochToUpdate.classifiedNodes.has(nodeKey)) {
        epochToUpdate.classifiedNodes.add(nodeKey);
        epochToUpdate.classifiedElements.push(candidate);
        if (epochToUpdate.classifiedNodes.size > input.maxClassifiedNodes) {
          poison(epochToUpdate);
          return;
        }
      }
      const regionKey = nodeKey;
      if (!epochToUpdate.classifiedRegions.has(regionKey)) {
        epochToUpdate.classifiedRegions.add(regionKey);
        if (epochToUpdate.classifiedRegions.size > input.maxMaskRegions) {
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
      if (node.parentElement !== null) return node.parentElement;
      const root = node.getRootNode();
      return root instanceof ShadowRoot && root.mode === "open" ? root.host : null;
    }

    function observableElements(): Element[] {
      const elements = Array.from(element.ownerDocument.querySelectorAll("*"));
      for (const root of shadowRoots().filter((candidate) => candidate.mode === "open")) {
        elements.push(...Array.from(root.querySelectorAll("*")));
      }
      return elements;
    }

    function isObservationCandidate(candidate: Element): boolean {
      const tag = candidate.tagName.toLowerCase();
      return tag === "button" ||
        (tag === "a" && candidate.hasAttribute("href")) ||
        tag === "input" ||
        tag === "textarea" ||
        tag === "select" ||
        candidate.hasAttribute("role") ||
        candidate.hasAttribute("data-qualigence-observe");
    }

    function nodeIdentity(candidate: Element): string {
      const host = candidate as unknown as Element & Record<string, unknown>;
      const existingId = host.__qualigenceSensitiveNodeIdentity;
      if (typeof existingId === "string") return existingId;
      state.nextNodeOrdinal += 1;
      const nodeId = `qn-${state.nextNodeOrdinal}`;
      Object.defineProperty(host, "__qualigenceSensitiveNodeIdentity", {
        configurable: true,
        enumerable: false,
        value: nodeId,
        writable: false,
      });
      return nodeId;
    }

    function markSensitiveElement(candidate: Element, markerId: string): void {
      const host = candidate as unknown as Element & Record<string, unknown>;
      const current = host[input.targetIdsProperty];
      if (Array.isArray(current)) {
        if (!current.includes(markerId)) current.push(markerId);
      } else {
        Object.defineProperty(host, input.targetIdsProperty, {
          configurable: true,
          enumerable: false,
          value: [markerId],
          writable: true,
        });
      }
      if (!candidate.hasAttribute(input.maskAttribute)) {
        state.nextMaskOrdinal += 1;
        candidate.setAttribute(input.maskAttribute, `qm-${state.nextMaskOrdinal}`);
      }
    }

    function isMarkedSensitive(candidate: Element, markerId: string): boolean {
      const ids = (candidate as unknown as Element & Record<string, unknown>)[input.targetIdsProperty];
      return Array.isArray(ids) && ids.includes(markerId);
    }

    function sensitiveValues(candidate: Element): readonly string[] {
      const values: string[] = [];
      const text = directText(candidate);
      if (text !== "") values.push(text);
      const observedText = isObservationCandidate(candidate) ? candidate.textContent ?? "" : "";
      if (observedText !== "" && observedText !== text) values.push(observedText);
      if (candidate instanceof HTMLInputElement || candidate instanceof HTMLTextAreaElement) {
        if (candidate.value !== "") values.push(candidate.value);
        if (candidate.placeholder !== "") values.push(candidate.placeholder);
      }
      if (candidate instanceof HTMLSelectElement) {
        if (candidate.value !== "") values.push(candidate.value);
        const selectedText = candidate.selectedOptions.item(0)?.text ?? "";
        if (selectedText !== "") values.push(selectedText);
      }
      for (const attribute of ["aria-label", "title", "value"] as const) {
        const attributeValue = candidate.getAttribute(attribute);
        if (attributeValue !== null && attributeValue !== "") values.push(attributeValue);
      }
      return values;
    }

    function directText(candidate: Element): string {
      return Array.from(candidate.childNodes)
        .filter((node): node is Text => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.data)
        .join("");
    }

    function shadowRootValues(root: ShadowRoot): readonly string[] {
      const values: string[] = [];
      const direct = Array.from(root.childNodes)
        .filter((node): node is Text => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.data)
        .join("");
      if (direct !== "") values.push(direct);
      const fullText = root.textContent ?? "";
      if (fullText !== "" && fullText !== direct) values.push(fullText);
      return values;
    }

    function shadowRoots(): ShadowRoot[] {
      const roots = new Set<ShadowRoot>();
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
        if (roots.has(root)) return true;
        if (pending.length >= input.maxShadowRoots) {
          noteOverflow();
          return false;
        }
        roots.add(root);
        pending.push(root);
        return true;
      };
      for (const root of registry?.roots ?? []) {
        if (root instanceof ShadowRoot && !addRoot(root)) return pending;
      }
      for (const candidate of Array.from(element.ownerDocument.querySelectorAll("*"))) {
        const shadowRoot = candidate.shadowRoot;
        if (shadowRoot !== null && !addRoot(shadowRoot)) return pending;
      }
      for (let index = 0; index < pending.length; index += 1) {
        const root = pending[index]!;
        for (const candidate of Array.from(root.querySelectorAll("*"))) {
          const nestedShadowRoot = candidate.shadowRoot;
          if (nestedShadowRoot !== null && !addRoot(nestedShadowRoot)) return pending;
        }
      }
      return pending;
    }

    function normalizeVisibleSensitiveForm(value: string): string {
      return value.normalize("NFC").replace(/\s+/g, " ").trim();
    }

    function carriesForm(value: string, form: string | readonly string[]): boolean {
      const forms = Array.isArray(form) ? form : [form];
      return forms.some((candidate) => value === candidate || (candidate !== "" && value.includes(candidate)));
    }

    function shadowBaselineAllows(node: Node, epochToUpdate: BrowserSensitiveEpoch, value: string): boolean {
      return epochToUpdate.shadowBaseline.get(node)?.has(value) === true;
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
        baseline: WeakMap<Element, ReadonlySet<string>>;
        shadowBaseline: WeakMap<Node, ReadonlySet<string>>;
        observer: MutationObserver;
        targetCaptureListener: EventListener;
        documentBubbleListener: EventListener;
        mutationOrdinal: number;
        deferredRecords: MutationRecord[];
        classifiedNodes: Set<string>;
        classifiedRegions: Set<string>;
        classifiedElements?: Element[];
        hasDelegatedListener: boolean;
        inTargetDispatch: boolean;
        inSchedulerCallback?: boolean;
        schedulerRegistrations?: number;
        poisoned: boolean;
      } | null;
      records: {
        markerId: string;
        forms: string[];
        baseline: WeakMap<Element, ReadonlySet<string>>;
        shadowBaseline?: WeakMap<Node, ReadonlySet<string>>;
        classifiedNodes?: Set<string>;
        classifiedRegions?: Set<string>;
        classifiedElements?: Element[];
        schedulerRegistrations?: number;
        poisoned?: boolean;
        observer?: MutationObserver;
      }[];
      poisoned: boolean;
      nextNodeOrdinal: number;
      nextMaskOrdinal: number;
      schedulerSessionRegistrations?: number;
    };
    const win = element.ownerDocument.defaultView;
    const state = win === null
      ? undefined
      : (win as unknown as Record<string, BrowserSensitiveState | undefined>)[input.stateProperty];
    const active = state?.active;
    if (state === undefined || active === null || active === undefined || active.markerId !== input.markerId) {
      if (state !== undefined) state.poisoned = true;
      return { status: "failed" };
    }
    if (input.retainRecord) {
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
    if (input.retainRecord) {
      state.records.push({
        markerId: active.markerId,
        forms: active.forms,
        baseline: active.baseline,
        shadowBaseline: active.shadowBaseline,
        classifiedNodes: active.classifiedNodes,
        classifiedRegions: active.classifiedRegions,
        ...(active.classifiedElements === undefined ? {} : { classifiedElements: active.classifiedElements }),
        schedulerRegistrations: active.schedulerRegistrations ?? 0,
        poisoned: active.poisoned,
        ...(retainSchedulerObserver ? { observer: active.observer } : {}),
      });
    } else {
      cleanupSensitiveMarkers(active.markerId, active.classifiedElements ?? []);
    }
    const failed = input.retainRecord && (state.poisoned || active.poisoned);
    state.active = null;
    return { status: failed ? "failed" : "ok" };

    function cleanupSensitiveMarkers(markerId: string, classifiedElements: readonly Element[]): void {
      const candidates = new Set<Element>(classifiedElements);
      candidates.add(element);
      for (const candidate of Array.from(element.ownerDocument.querySelectorAll("*"))) {
        const ids = (candidate as unknown as Element & Record<string, unknown>)[input.targetIdsProperty];
        if (Array.isArray(ids) && ids.includes(markerId)) {
          candidates.add(candidate);
        }
      }
      for (const candidate of candidates) {
        removeSensitiveMarker(candidate, markerId);
      }
    }

    function removeSensitiveMarker(candidate: Element, markerId: string): void {
      const host = candidate as unknown as Element & Record<string, unknown>;
      const ids = host[input.targetIdsProperty];
      if (!Array.isArray(ids)) {
        return;
      }
      const remaining = ids.filter((id) => id !== markerId);
      if (remaining.length === 0) {
        delete host[input.targetIdsProperty];
        candidate.removeAttribute(input.maskAttribute);
        return;
      }
      host[input.targetIdsProperty] = remaining;
    }

    function processMutationRecords(
      stateToUpdate: BrowserSensitiveState,
      epochToUpdate: NonNullable<BrowserSensitiveState["active"]>,
      records: readonly MutationRecord[],
      allowClassification: boolean,
    ): void {
      const applicationRecords = records.filter((record) =>
        record.type !== "attributes" || record.attributeName !== input.maskAttribute);
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
          if (matches.every((value) => epochToUpdate.baseline.get(candidate)?.has(value) === true)) {
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
      const touchedNodes = [record.target, ...Array.from(record.addedNodes)];
      return touchedNodes.some((node) => {
        const root = node instanceof ShadowRoot ? node : node.getRootNode();
        return root instanceof ShadowRoot && root.mode !== "open";
      });
    }

    function mutationCandidateElements(record: MutationRecord): Element[] {
      const candidates: Element[] = [];
      addNode(record.target, candidates);
      if (record.type === "childList") {
        for (const node of Array.from(record.addedNodes)) addNode(node, candidates);
      }
      return candidates;
    }

    function addNode(node: Node, candidates: Element[]): void {
      if (node instanceof Element) {
        candidates.push(node);
        candidates.push(...Array.from(node.querySelectorAll("*")));
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
        if (formsToMatch.some((form) => carriesForm(value, form))) matches.push(value);
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
        if (target instanceof Element && target.hasAttribute(handlerName)) return true;
        try {
          if (typeof (target as unknown as Record<string, unknown>)[handlerName] === "function") {
            return true;
          }
        } catch {
          return true;
        }
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
      for (let current = element.parentElement; current !== null; current = current.parentElement) {
        targets.push(current);
      }
      targets.push(element.ownerDocument);
      if (win !== null) targets.push(win);
      return targets;
    }

    function isDelegatedEventTarget(target: unknown): boolean {
      if (target === element) return false;
      if (target === win || target === element.ownerDocument) return true;
      return target instanceof Node && target.contains(element);
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
      const root = candidate.getRootNode();
      if (root !== candidate.ownerDocument && (!(root instanceof ShadowRoot) || root.mode !== "open")) {
        epochToUpdate.poisoned = true;
        stateToUpdate.poisoned = true;
        return;
      }
      const nodeKey = `${input.markerId}:${nodeIdentity(stateToUpdate, candidate)}`;
      if (!epochToUpdate.classifiedNodes.has(nodeKey)) {
        epochToUpdate.classifiedNodes.add(nodeKey);
        if (epochToUpdate.classifiedElements !== undefined) {
          epochToUpdate.classifiedElements.push(candidate);
        }
        if (epochToUpdate.classifiedNodes.size > input.maxClassifiedNodes) {
          epochToUpdate.poisoned = true;
          stateToUpdate.poisoned = true;
          return;
        }
      }
      const regionKey = nodeKey;
      if (!epochToUpdate.classifiedRegions.has(regionKey)) {
        epochToUpdate.classifiedRegions.add(regionKey);
        if (epochToUpdate.classifiedRegions.size > input.maxMaskRegions) {
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
      if (node.parentElement !== null) return node.parentElement;
      const root = node.getRootNode();
      return root instanceof ShadowRoot && root.mode === "open" ? root.host : null;
    }

    function isObservationCandidate(candidate: Element): boolean {
      const tag = candidate.tagName.toLowerCase();
      return tag === "button" ||
        (tag === "a" && candidate.hasAttribute("href")) ||
        tag === "input" ||
        tag === "textarea" ||
        tag === "select" ||
        candidate.hasAttribute("role") ||
        candidate.hasAttribute("data-qualigence-observe");
    }

    function nodeIdentity(stateToUpdate: BrowserSensitiveState, candidate: Element): string {
      const host = candidate as unknown as Element & Record<string, unknown>;
      const existingId = host.__qualigenceSensitiveNodeIdentity;
      if (typeof existingId === "string") return existingId;
      stateToUpdate.nextNodeOrdinal += 1;
      const nodeId = `qn-${stateToUpdate.nextNodeOrdinal}`;
      Object.defineProperty(host, "__qualigenceSensitiveNodeIdentity", {
        configurable: true,
        enumerable: false,
        value: nodeId,
        writable: false,
      });
      return nodeId;
    }

    function markSensitiveElement(
      stateToUpdate: BrowserSensitiveState,
      candidate: Element,
      markerId: string,
    ): void {
      const host = candidate as unknown as Element & Record<string, unknown>;
      const current = host[input.targetIdsProperty];
      if (Array.isArray(current)) {
        if (!current.includes(markerId)) current.push(markerId);
      } else {
        Object.defineProperty(host, input.targetIdsProperty, {
          configurable: true,
          enumerable: false,
          value: [markerId],
          writable: true,
        });
      }
      if (!candidate.hasAttribute(input.maskAttribute)) {
        stateToUpdate.nextMaskOrdinal += 1;
        candidate.setAttribute(input.maskAttribute, `qm-${stateToUpdate.nextMaskOrdinal}`);
      }
    }

    function isMarkedSensitive(candidate: Element, markerId: string): boolean {
      const ids = (candidate as unknown as Element & Record<string, unknown>)[input.targetIdsProperty];
      return Array.isArray(ids) && ids.includes(markerId);
    }

    function sensitiveValues(candidate: Element): readonly string[] {
      const values: string[] = [];
      const text = directText(candidate);
      if (text !== "") values.push(text);
      const observedText = isObservationCandidate(candidate) ? candidate.textContent ?? "" : "";
      if (observedText !== "" && observedText !== text) values.push(observedText);
      if (candidate instanceof HTMLInputElement || candidate instanceof HTMLTextAreaElement) {
        if (candidate.value !== "") values.push(candidate.value);
        if (candidate.placeholder !== "") values.push(candidate.placeholder);
      }
      if (candidate instanceof HTMLSelectElement) {
        if (candidate.value !== "") values.push(candidate.value);
        const selectedText = candidate.selectedOptions.item(0)?.text ?? "";
        if (selectedText !== "") values.push(selectedText);
      }
      for (const attribute of ["aria-label", "title", "value"] as const) {
        const attributeValue = candidate.getAttribute(attribute);
        if (attributeValue !== null && attributeValue !== "") values.push(attributeValue);
      }
      return values;
    }

    function directText(candidate: Element): string {
      return Array.from(candidate.childNodes)
        .filter((node): node is Text => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.data)
        .join("");
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
      const host = element as unknown as Element & Record<string, unknown>;
      const current = host[input.property];
      if (Array.isArray(current)) {
        if (!current.includes(input.markerId)) current.push(input.markerId);
      } else {
        Object.defineProperty(host, input.property, {
          configurable: true,
          enumerable: false,
          value: [input.markerId],
          writable: true,
        });
      }
      if (!element.hasAttribute(input.maskAttribute)) {
        element.setAttribute(input.maskAttribute, "qm-target");
      }
    },
    {
      property: SENSITIVE_TARGET_IDS_PROPERTY,
      markerId,
      maskAttribute: SENSITIVE_MASK_ID_ATTRIBUTE,
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
  return locator.evaluate((element, property) => {
    const ids = (element as unknown as Element & Record<string, unknown>)[property];
    const sensitiveTargetIds = Array.isArray(ids) && ids.every((entry) => typeof entry === "string")
      ? ids
      : [];
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
      throw new Error("Sensitive target is not an input field.");
    }
    return { sensitiveTargetIds, value: element.value };
  }, SENSITIVE_TARGET_IDS_PROPERTY);
}

async function readSelectSensitiveForms(locator: Locator): Promise<SelectSensitiveForms> {
  return locator.evaluate((element, property) => {
    const ids = (element as unknown as Element & Record<string, unknown>)[property];
    const sensitiveTargetIds = Array.isArray(ids) && ids.every((entry) => typeof entry === "string")
      ? ids
      : [];
    if (!(element instanceof HTMLSelectElement)) {
      throw new Error("Sensitive target is not a select field.");
    }
    const selectedOption = element.selectedOptions.item(0);
    if (selectedOption === null) {
      throw new Error("Sensitive select target has no selected option.");
    }
    return {
      sensitiveTargetIds,
      value: element.value,
      selectedOptionValue: selectedOption.value,
      selectedOptionText: selectedOption.text,
    };
  }, SENSITIVE_TARGET_IDS_PROPERTY);
}

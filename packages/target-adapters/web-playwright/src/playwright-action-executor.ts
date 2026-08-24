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
          if (action.kind === "input") {
            const dispatchGenerationFailure = navigationGenerationFailure(
              page,
              this.session,
              navigationGeneration,
            );
            if (dispatchGenerationFailure !== undefined) return dispatchGenerationFailure;
            this.session.invalidateObservations();
            permit.assertAuthorizedForDispatch(signal, () => dispatchSnapshot(this.session));
            await locator.fill(value, { timeout: this.session.actionTimeoutMs });
            await this.completeInputSensitiveEvidence(locator, sensitiveEvidence);
          } else {
            const dispatchGenerationFailure = navigationGenerationFailure(
              page,
              this.session,
              navigationGeneration,
            );
            if (dispatchGenerationFailure !== undefined) return dispatchGenerationFailure;
            this.session.invalidateObservations();
            permit.assertAuthorizedForDispatch(signal, () => dispatchSnapshot(this.session));
            await locator.selectOption(value, { timeout: this.session.actionTimeoutMs });
            await this.completeSelectSensitiveEvidence(locator, sensitiveEvidence);
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
      this.session.completeSensitiveEvidenceRecord(prepared, [observed.value]);
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
        return;
      }
      Object.defineProperty(host, input.property, {
        configurable: true,
        enumerable: false,
        value: [input.markerId],
        writable: true,
      });
    },
    { property: SENSITIVE_TARGET_IDS_PROPERTY, markerId },
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

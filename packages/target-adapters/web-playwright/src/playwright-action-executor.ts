import type {
  ActionExecutor,
  ActionOutcome,
  AnyResolvedAction,
  ResolvedAction,
} from "@qualigence/runner-kernel";
import { ExecutionPermit, isDesktopAction } from "@qualigence/runner-kernel";
import {
  PlaywrightBrowserSession,
  WebTargetError,
} from "./browser-session.js";
import { locatorFor } from "./action-locator.js";
import { isActionToken } from "./action-token.js";
import type { LocatorDescriptor } from "./types.js";

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

    if (action.kind === "navigate") {
      if (!isSafeTargetUrl(action.url, this.session)) {
        return { status: "failed", errorCode: "OriginViolation" };
      }
      this.session.invalidateObservations();
      return this.session.withPage(async (page) => {
        signal?.throwIfAborted();
        if (!isSafeTargetUrl(action.url, this.session)) {
          return { status: "failed", errorCode: "OriginViolation" };
        }
        const originFailure = targetOriginFailure(page, this.session);
        if (originFailure !== undefined) return originFailure;
        try {
          permit.assertAuthorizedForDispatch(signal);
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
        return hasTargetOrigin(page, this.session)
          ? { status: "ok" }
          : { status: "failed", errorCode: "ActionOutcomeUnknown" };
      });
    }
    if (action.kind === "scroll" && action.target === undefined) {
      if (!this.session.hasGraph(action.graphId)) {
        return { status: "failed", errorCode: "StaleObservation" };
      }
      return this.session.withPage(async (page) => {
        signal?.throwIfAborted();
        const guardFailure = this.guardPageAction(page, action.graphId);
        if (guardFailure !== undefined) return guardFailure;
        this.session.invalidateObservations();
        const distance = action.amount === "page" ? 1 : 0.25;
        try {
          permit.assertAuthorizedForDispatch(signal);
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
        return hasTargetOrigin(page, this.session)
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

    const descriptor = this.session.descriptorFor(
      action.graphId,
      actionTarget.nodeId,
    );
    if (!descriptor) {
      return { status: "failed", errorCode: "StaleObservation" };
    }

    return this.session.withPage(async (page): Promise<ActionOutcome> => {
      signal?.throwIfAborted();
      const originFailure = targetOriginFailure(page, this.session);
      if (originFailure !== undefined) return originFailure;
      const locator = locatorFor(page, descriptor);

      let count: number;
      let visible: boolean;
      let enabled: boolean;
      let href: string | null;
      try {
        count = await locator.count();
        visible = count === 1 && await locator.isVisible();
        enabled = visible && await locator.isEnabled();
        href = enabled ? await locator.getAttribute("href") : null;
      } catch {
        const readOriginFailure = targetOriginFailure(page, this.session);
        if (readOriginFailure !== undefined) return readOriginFailure;
        signal?.throwIfAborted();
        return { status: "failed", errorCode: "ActionFailed" };
      }
      const preflightOriginFailure = targetOriginFailure(page, this.session);
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
          destination = new URL(href, page.url()).href;
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
          let value: string;
          try {
            value = await this.valueProvider.resolve(action.valueRef);
          } catch {
            return { status: "failed", errorCode: "ActionValueUnavailable" };
          }
          signal?.throwIfAborted();
          this.session.registerSensitiveValue(value);
          const guardFailure = this.guardElementAction(
            page,
            action.graphId,
            actionTarget.nodeId,
            descriptor,
          );
          if (guardFailure !== undefined) return guardFailure;
          this.session.invalidateObservations();
          if (action.kind === "input") {
            permit.assertAuthorizedForDispatch(signal);
            await locator.fill(value, { timeout: this.session.actionTimeoutMs });
          } else {
            permit.assertAuthorizedForDispatch(signal);
            await locator.selectOption(value, { timeout: this.session.actionTimeoutMs });
          }
        } else if (action.kind === "click") {
          const guardFailure = this.guardElementAction(
            page,
            action.graphId,
            actionTarget.nodeId,
            descriptor,
          );
          if (guardFailure !== undefined) return guardFailure;
          this.session.invalidateObservations();
          permit.assertAuthorizedForDispatch(signal);
          await locator.click({ timeout: this.session.actionTimeoutMs });
        } else if (action.kind === "scroll") {
          const guardFailure = this.guardElementAction(
            page,
            action.graphId,
            actionTarget.nodeId,
            descriptor,
          );
          if (guardFailure !== undefined) return guardFailure;
          this.session.invalidateObservations();
          const distance = action.amount === "page" ? 1 : 0.25;
          permit.assertAuthorizedForDispatch(signal);
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

      return hasTargetOrigin(page, this.session)
        ? { status: "ok" }
        : { status: "failed", errorCode: "ActionOutcomeUnknown" };
    });
  }

  private guardPageAction(page: { url(): string }, graphId: string): ActionOutcome | undefined {
    const originFailure = targetOriginFailure(page, this.session);
    if (originFailure !== undefined) return originFailure;
    if (!this.session.hasGraph(graphId)) {
      return { status: "failed", errorCode: "StaleObservation" };
    }
    return undefined;
  }

  private guardElementAction(
    page: { url(): string },
    graphId: string,
    nodeId: string,
    descriptor: LocatorDescriptor,
  ): ActionOutcome | undefined {
    const pageFailure = this.guardPageAction(page, graphId);
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

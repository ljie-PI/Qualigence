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

function isInfrastructureFailure(message: string): boolean {
  return (
    /Target closed/i.test(message) ||
    /Browser has been closed/i.test(message) ||
    /crash/i.test(message) ||
    /Protocol error/i.test(message)
  );
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
        try {
          await page.goto(action.url, {
            waitUntil: "domcontentloaded",
            timeout: this.session.navigationTimeoutMs,
          });
        } catch (error) {
          if (!isSafeTargetUrl(page.url(), this.session)) {
            return { status: "failed", errorCode: "OriginViolation" };
          }
          signal?.throwIfAborted();
          const message = error instanceof Error ? error.message : String(error);
          if (/timeout/i.test(message)) return { status: "failed", errorCode: "ActionOutcomeUnknown" };
          if (isInfrastructureFailure(message)) throw new WebTargetError("ActionInfrastructureFailure");
          return { status: "failed", errorCode: "ActionFailed" };
        }
        return isSafeTargetUrl(page.url(), this.session)
          ? { status: "ok" }
          : { status: "failed", errorCode: "OriginViolation" };
      });
    }
    if (action.kind === "scroll" && action.target === undefined) {
      if (!this.session.hasGraph(action.graphId)) {
        return { status: "failed", errorCode: "StaleObservation" };
      }
      return this.session.withPage(async (page) => {
        signal?.throwIfAborted();
        const guardFailure = this.guardPageAction(page.url(), action.graphId);
        if (guardFailure !== undefined) return guardFailure;
        this.session.invalidateObservations();
        const distance = action.amount === "page" ? 1 : 0.25;
        try {
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
          if (!isSafeTargetUrl(page.url(), this.session)) {
            return { status: "failed", errorCode: "OriginViolation" };
          }
          signal?.throwIfAborted();
          return classifyActionFailure(error);
        }
        if (!isSafeTargetUrl(page.url(), this.session)) {
          return { status: "failed", errorCode: "OriginViolation" };
        }
        return { status: "ok" };
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
      const locator = locatorFor(page, descriptor);

      const count = await locator.count();
      if (count === 0) {
        return { status: "failed", errorCode: "TargetNotFound" };
      }
      if (count > 1) {
        return { status: "failed", errorCode: "AmbiguousTarget" };
      }
      if (!(await locator.isVisible())) {
        return { status: "failed", errorCode: "TargetNotVisible" };
      }
      if (!(await locator.isEnabled())) {
        return { status: "failed", errorCode: "TargetDisabled" };
      }

      const href = await locator.getAttribute("href");
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
            page.url(),
            action.graphId,
            actionTarget.nodeId,
            descriptor,
          );
          if (guardFailure !== undefined) return guardFailure;
          this.session.invalidateObservations();
          if (action.kind === "input") {
            await locator.fill(value, { timeout: this.session.actionTimeoutMs });
          } else {
            await locator.selectOption(value, { timeout: this.session.actionTimeoutMs });
          }
        } else if (action.kind === "click") {
          const guardFailure = this.guardElementAction(
            page.url(),
            action.graphId,
            actionTarget.nodeId,
            descriptor,
          );
          if (guardFailure !== undefined) return guardFailure;
          this.session.invalidateObservations();
          await locator.click({ timeout: this.session.actionTimeoutMs });
        } else if (action.kind === "scroll") {
          const guardFailure = this.guardElementAction(
            page.url(),
            action.graphId,
            actionTarget.nodeId,
            descriptor,
          );
          if (guardFailure !== undefined) return guardFailure;
          this.session.invalidateObservations();
          const distance = action.amount === "page" ? 1 : 0.25;
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
        if (!isSafeTargetUrl(page.url(), this.session)) {
          return { status: "failed", errorCode: "OriginViolation" };
        }
        signal?.throwIfAborted();
        return classifyActionFailure(error);
      }

      if (!isSafeTargetUrl(page.url(), this.session)) {
        return { status: "failed", errorCode: "OriginViolation" };
      }

      return { status: "ok" };
    });
  }

  private guardPageAction(pageUrl: string, graphId: string): ActionOutcome | undefined {
    if (!isSafeTargetUrl(pageUrl, this.session)) {
      return { status: "failed", errorCode: "OriginViolation" };
    }
    if (!this.session.hasGraph(graphId)) {
      return { status: "failed", errorCode: "StaleObservation" };
    }
    return undefined;
  }

  private guardElementAction(
    pageUrl: string,
    graphId: string,
    nodeId: string,
    descriptor: LocatorDescriptor,
  ): ActionOutcome | undefined {
    const pageFailure = this.guardPageAction(pageUrl, graphId);
    if (pageFailure !== undefined) return pageFailure;
    if (this.session.descriptorFor(graphId, nodeId) !== descriptor) {
      return { status: "failed", errorCode: "StaleObservation" };
    }
    return undefined;
  }
}

function classifyActionFailure(error: unknown): ActionOutcome {
  const message = error instanceof Error ? error.message : String(error);
  if (isInfrastructureFailure(message)) {
    throw new WebTargetError("ActionInfrastructureFailure");
  }
  if (/timeout/i.test(message)) {
    return { status: "failed", errorCode: "ActionOutcomeUnknown" };
  }
  return { status: "failed", errorCode: "ActionFailed" };
}

function isSafeTargetUrl(url: string, session: PlaywrightBrowserSession): boolean {
  try {
    const parsed = new URL(url);
    return parsed.username === "" && parsed.password === "" && session.isTargetOrigin(parsed.href);
  } catch {
    return false;
  }
}

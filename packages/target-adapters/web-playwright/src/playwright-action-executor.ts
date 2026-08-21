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
  isOriginAllowed,
} from "./browser-session.js";
import { locatorFor } from "./action-locator.js";
import { isActionToken } from "./action-token.js";

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
  ): Promise<ActionOutcome>;
  execute(
    action: AnyResolvedAction,
    permit: ExecutionPermit,
  ): Promise<ActionOutcome>;
  async execute(
    action: AnyResolvedAction,
    permit: ExecutionPermit,
  ): Promise<ActionOutcome> {
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

    if (action.kind === "navigate" || (action.kind === "scroll" && action.target === undefined)) {
      return { status: "failed", errorCode: "UnsupportedAction" };
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
        let destinationOrigin: string | undefined;
        try {
          destinationOrigin = new URL(href, page.url()).origin;
        } catch {
          destinationOrigin = undefined;
        }
        if (
          destinationOrigin !== undefined &&
          !this.session.allowedOrigins.includes(destinationOrigin)
        ) {
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
          this.session.registerSensitiveValue(value);
          if (action.kind === "input") {
            await locator.fill(value, { timeout: this.session.actionTimeoutMs });
          } else {
            await locator.selectOption(value, { timeout: this.session.actionTimeoutMs });
          }
        } else if (action.kind === "click") {
          await locator.click({ timeout: this.session.actionTimeoutMs });
        } else {
          return { status: "failed", errorCode: "UnsupportedAction" };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isInfrastructureFailure(message)) {
          throw error;
        }
        if (/timeout/i.test(message)) {
          return { status: "failed", errorCode: "ActionTimedOut" };
        }
        return { status: "failed", errorCode: "ActionFailed" };
      }

      if (!isOriginAllowed(page.url(), this.session.allowedOrigins)) {
        return { status: "failed", errorCode: "OriginViolation" };
      }

      return { status: "ok" };
    });
  }
}

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

    const privateTarget = this.session.privateActionTargetFor(
      action.graphId,
      actionTarget.nodeId,
    );
    if (privateTarget === undefined) {
      return { status: "failed", errorCode: "StaleObservation" };
    }

    return this.session.withPage(async (page): Promise<ActionOutcome> => {
      const target = privateTarget.handle;
      if (!(await target.evaluate((element) => element.isConnected))) {
        return { status: "failed", errorCode: "TargetNotFound" };
      }
      if (!(await target.isVisible())) {
        return { status: "failed", errorCode: "TargetNotVisible" };
      }
      if (!(await target.isEnabled())) {
        return { status: "failed", errorCode: "TargetDisabled" };
      }

      const href = await target.getAttribute("href");
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
          // Register the source before Playwright can echo it in an error. Any
          // browser normalization is redacted only on this target after success.
          this.session.registerSensitiveValue(value);
          if (action.kind === "input") {
            await target.fill(value, { timeout: this.session.actionTimeoutMs });
          } else {
            await target.selectOption(value, {
              timeout: this.session.actionTimeoutMs,
            });
          }
          this.session.registerSensitiveActionTarget(action.graphId, actionTarget.nodeId);
        } else if (action.kind === "click") {
          await target.click({ timeout: this.session.actionTimeoutMs });
        } else {
          return { status: "failed", errorCode: "UnsupportedAction" };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isInfrastructureFailure(message)) {
          throw new WebTargetError("ActionInfrastructureFailure");
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

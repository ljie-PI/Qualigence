import type {
  ActionExecutor,
  ActionOutcome,
  ResolvedAction,
} from "@qualigence/runner-kernel";
import { ExecutionPermit } from "@qualigence/runner-kernel";
import {
  PlaywrightBrowserSession,
  WebTargetError,
  isOriginAllowed,
} from "./browser-session.js";
import { locatorFor } from "./action-locator.js";
import { isActionToken } from "./action-token.js";

function isInfrastructureFailure(message: string): boolean {
  return (
    /Target closed/i.test(message) ||
    /Browser has been closed/i.test(message) ||
    /crash/i.test(message) ||
    /Protocol error/i.test(message)
  );
}

export class PlaywrightActionExecutor implements ActionExecutor {
  constructor(private readonly session: PlaywrightBrowserSession) {}

  async execute(
    action: ResolvedAction,
    permit: ExecutionPermit,
  ): Promise<ActionOutcome> {
    if (!(permit instanceof ExecutionPermit)) {
      throw new WebTargetError(
        "ConcurrentSessionOperation",
        "A valid ExecutionPermit is required to execute an action.",
      );
    }

    if (
      !isActionToken(action.target.selector, action.graphId, action.target.nodeId)
    ) {
      return { status: "failed", errorCode: "UnknownObservationNode" };
    }

    const descriptor = this.session.descriptorFor(
      action.graphId,
      action.target.nodeId,
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
        await locator.click({ timeout: this.session.actionTimeoutMs });
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

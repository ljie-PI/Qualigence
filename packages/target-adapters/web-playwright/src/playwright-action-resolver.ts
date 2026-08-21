import type { ObservationGraph } from "@qualigence/runner-protocol";
import type {
  ActionResolver,
  AnyProposedAction,
  AnyResolvedWebAction,
  ProposedAction,
  ResolvedWebAction,
} from "@qualigence/runner-kernel";
import { PlaywrightBrowserSession, WebTargetError } from "./browser-session.js";
import { locatorFor } from "./action-locator.js";
import { actionToken } from "./action-token.js";

export class PlaywrightActionResolver implements ActionResolver {
  constructor(private readonly session: PlaywrightBrowserSession) {}

  resolve(
    action: ProposedAction,
    graph: ObservationGraph,
  ): Promise<ResolvedWebAction>;
  resolve(
    action: AnyProposedAction,
    graph: ObservationGraph,
  ): Promise<AnyResolvedWebAction>;
  async resolve(
    action: AnyProposedAction,
    graph: ObservationGraph,
  ): Promise<AnyResolvedWebAction> {
    if (action.kind === "navigate" || action.kind === "window" || (action.kind === "scroll" && action.target === undefined)) {
      throw new WebTargetError("UnsupportedAction", "This action is not implemented by this Runtime.");
    }
    const actionTarget = action.target;
    if (actionTarget === undefined) {
      throw new WebTargetError("UnsupportedAction", "This action requires a semantic target.");
    }
    if (!this.session.hasGraph(graph.graphId)) {
      throw new WebTargetError(
        "StaleObservation",
        `Graph ${graph.graphId} is not the session's registered observation.`,
      );
    }

    const descriptor = this.session.descriptorFor(
      graph.graphId,
      actionTarget.nodeId,
    );
    if (!descriptor) {
      throw new WebTargetError(
        "UnknownObservationNode",
        `Node ${actionTarget.nodeId} is not present in graph ${graph.graphId}.`,
      );
    }

    const retainedTarget = this.session.privateActionTargetFor(graph.graphId, actionTarget.nodeId);
    if (retainedTarget === undefined) {
      await this.session.withPage(async (page) => {
        const locator = locatorFor(page, descriptor);
        const count = await locator.count();
        if (count === 0) {
          throw new WebTargetError(
            "TargetNotFound",
            `Node ${actionTarget.nodeId} no longer matches any element.`,
          );
        }
        if (count > 1) {
          throw new WebTargetError(
            "AmbiguousTarget",
            `Node ${actionTarget.nodeId} matches ${count} elements.`,
          );
        }
        await this.session.establishPrivateActionTarget(graph.graphId, actionTarget.nodeId, locator);
      });
    } else if (!(await retainedTarget.handle.evaluate((element) => element.isConnected))) {
      throw new WebTargetError(
        "TargetNotFound",
        `Node ${actionTarget.nodeId} no longer matches any element.`,
      );
    }

    const target = {
      nodeId: actionTarget.nodeId,
      selector: actionToken(graph.graphId, actionTarget.nodeId),
    };
    if (action.kind === "input" || action.kind === "select") {
      return {
        targetKind: "web",
        kind: action.kind,
        target,
        graphId: graph.graphId,
        valueRef: action.valueRef,
      };
    }
    if (action.kind !== "click") {
      throw new WebTargetError("UnsupportedAction", "This action is not implemented by this Runtime.");
    }
    return {
      targetKind: "web",
      kind: "click",
      target,
      graphId: graph.graphId,
    };
  }
}

import type { ObservationGraph } from "@qualigence/runner-protocol";
import type {
  ActionResolver,
  ProposedAction,
  ResolvedAction,
} from "@qualigence/runner-kernel";
import { PlaywrightBrowserSession, WebTargetError } from "./browser-session.js";
import { locatorFor } from "./action-locator.js";
import { actionToken } from "./action-token.js";

export class PlaywrightActionResolver implements ActionResolver {
  constructor(private readonly session: PlaywrightBrowserSession) {}

  async resolve(
    action: ProposedAction,
    graph: ObservationGraph,
  ): Promise<ResolvedAction> {
    if (!this.session.hasGraph(graph.graphId)) {
      throw new WebTargetError(
        "StaleObservation",
        `Graph ${graph.graphId} is not the session's registered observation.`,
      );
    }

    const descriptor = this.session.descriptorFor(
      graph.graphId,
      action.target.nodeId,
    );
    if (!descriptor) {
      throw new WebTargetError(
        "UnknownObservationNode",
        `Node ${action.target.nodeId} is not present in graph ${graph.graphId}.`,
      );
    }

    const count = await this.session.withPage((page) =>
      locatorFor(page, descriptor).count(),
    );
    if (count === 0) {
      throw new WebTargetError(
        "TargetNotFound",
        `Node ${action.target.nodeId} no longer matches any element.`,
      );
    }
    if (count > 1) {
      throw new WebTargetError(
        "AmbiguousTarget",
        `Node ${action.target.nodeId} matches ${count} elements.`,
      );
    }

    return {
      targetKind: "web",
      kind: "click",
      target: {
        nodeId: action.target.nodeId,
        selector: actionToken(graph.graphId, action.target.nodeId),
      },
      graphId: graph.graphId,
    };
  }
}

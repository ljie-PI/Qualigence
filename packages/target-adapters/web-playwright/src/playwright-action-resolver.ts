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
    if (action.kind === "window") {
      throw new WebTargetError("UnsupportedAction", "This action is not implemented by this Runtime.");
    }
    if (action.kind === "navigate") {
      let url: URL;
      try {
        url = new URL(action.path, this.session.targetUrl);
      } catch {
        throw new WebTargetError("NavigationFailed", "The planned navigation path is invalid.");
      }
      if (url.username !== "" || url.password !== "") {
        throw new WebTargetError("NavigationFailed", "The planned navigation must not embed credentials.");
      }
      if (!this.session.isTargetOrigin(url.href)) {
        throw new WebTargetError("OriginViolation", "The planned navigation leaves the Job target origin.");
      }
      return { targetKind: "web", kind: "navigate", url: url.href };
    }
    if (!this.session.hasGraph(graph.graphId)) {
      throw new WebTargetError(
        "StaleObservation",
        `Graph ${graph.graphId} is not the session's current observation.`,
      );
    }
    if (action.kind === "scroll" && action.target === undefined) {
      return {
        targetKind: "web",
        kind: "scroll",
        graphId: graph.graphId,
        direction: action.direction,
        amount: action.amount,
      };
    }
    const actionTarget = action.target;
    if (actionTarget === undefined) {
      throw new WebTargetError("UnsupportedAction", "This action requires a semantic target.");
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

    const count = await this.session.withPage((page) =>
      locatorFor(page, descriptor).count(),
    );
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
    if (action.kind === "scroll") {
      return {
        targetKind: "web",
        kind: "scroll",
        target,
        graphId: graph.graphId,
        direction: action.direction,
        amount: action.amount,
      };
    }
    return {
      targetKind: "web",
      kind: "click",
      target,
      graphId: graph.graphId,
    };
  }
}

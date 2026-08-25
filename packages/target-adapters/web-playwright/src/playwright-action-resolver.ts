import type { ObservationGraphV1 } from "@qualigence/runner-protocol";
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
    graph: ObservationGraphV1,
  ): Promise<ResolvedWebAction>;
  resolve(
    action: AnyProposedAction,
    graph: ObservationGraphV1,
  ): Promise<AnyResolvedWebAction>;
  async resolve(
    action: AnyProposedAction,
    graph: ObservationGraphV1,
  ): Promise<AnyResolvedWebAction> {
    if (action.kind === "window") {
      throw new WebTargetError("UnsupportedAction", "This action is not implemented by this Runtime.");
    }
    const navigationGeneration = this.session.requireCurrentObservationGeneration(graph.graphId);
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
      return this.session.withPage(async (page) => {
        this.session.assertObservationGeneration(graph.graphId, navigationGeneration);
        this.session.assertPageTargetOrigin(page, navigationGeneration);
        const resolved = { targetKind: "web", kind: "navigate", url: url.href } as const;
        this.session.assertObservationGeneration(graph.graphId, navigationGeneration);
        this.session.assertPageTargetOrigin(page, navigationGeneration);
        return this.session.bindResolvedAction(resolved, navigationGeneration);
      });
    }
    if (action.kind === "scroll" && action.target === undefined) {
      return this.session.withPage(async (page) => {
        this.session.assertObservationGeneration(graph.graphId, navigationGeneration);
        this.session.assertPageTargetOrigin(page, navigationGeneration);
        const resolved = {
          targetKind: "web",
          kind: "scroll",
          graphId: graph.graphId,
          direction: action.direction,
          amount: action.amount,
        } as const;
        this.session.assertObservationGeneration(graph.graphId, navigationGeneration);
        this.session.assertPageTargetOrigin(page, navigationGeneration);
        return this.session.bindResolvedAction(resolved, navigationGeneration);
      });
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

    return this.session.withPage(async (page) => {
      this.session.assertObservationGeneration(graph.graphId, navigationGeneration);
      const readForObservation = <T>(read: () => Promise<T>): Promise<T> =>
        this.session.readForObservation(page, graph.graphId, navigationGeneration, read);
      const locator = locatorFor(page, descriptor);
      const count = await readForObservation(() => locator.count());

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
      let resolved: AnyResolvedWebAction;
      if (action.kind === "input" || action.kind === "select") {
        resolved = {
          targetKind: "web",
          kind: action.kind,
          target,
          graphId: graph.graphId,
          valueRef: action.valueRef,
        };
      } else if (action.kind === "scroll") {
        resolved = {
          targetKind: "web",
          kind: "scroll",
          target,
          graphId: graph.graphId,
          direction: action.direction,
          amount: action.amount,
        };
      } else {
        resolved = {
          targetKind: "web",
          kind: "click",
          target,
          graphId: graph.graphId,
        };
      }
      this.session.assertObservationGeneration(graph.graphId, navigationGeneration);
      this.session.assertPageTargetOrigin(page, navigationGeneration);
      return this.session.bindResolvedAction(resolved, navigationGeneration);
    });
  }
}

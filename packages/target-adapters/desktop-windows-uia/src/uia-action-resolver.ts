/**
 * Re-resolve a semantic {@link ProposedAction} against a freshly captured
 * Observation Graph into a concrete {@link ResolvedDesktopAction}, choosing the
 * UIA Pattern that will carry out the interaction.
 *
 * Resolution is semantic-first: the proposal references an observation node id,
 * and the matching node's `uia/v1` extension tells us which Pattern is available.
 * A proposal that no longer matches a live node fails as `PlanDiverged`; a node
 * that lacks the required Pattern fails as `UiaPatternUnsupported`. Neither ever
 * silently falls back to a blind click.
 */

import type { UiaPattern } from "@qualigence/desktop-contracts";
import type {
  ObservationGraphV1,
  ObservationJsonValue,
  ObservationNodeV1,
} from "@qualigence/observation-contracts";
import type { AnyProposedAction, ResolvedDesktopAction } from "@qualigence/runner-kernel";
import { UIA_EXTENSION_TYPE } from "@qualigence/desktop-contracts";

export type UiaResolutionErrorCode =
  | "PlanDiverged"
  | "UiaPatternUnsupported"
  | "ElementStale";

export class UiaResolutionError extends Error {
  readonly code: UiaResolutionErrorCode;

  constructor(code: UiaResolutionErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "UiaResolutionError";
    this.code = code;
  }
}

export interface UiaResolutionInput {
  readonly actionId: string;
}

function availablePatterns(node: ObservationNodeV1): ReadonlySet<string> {
  const extension = node.extensions[UIA_EXTENSION_TYPE];
  if (extension === undefined) {
    return new Set();
  }
  const raw: ObservationJsonValue | undefined = extension.payload.patterns;
  if (!Array.isArray(raw)) {
    return new Set();
  }
  const names = new Set<string>();
  for (const entry of raw) {
    if (
      entry !== null &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      entry.available === true &&
      typeof entry.pattern === "string"
    ) {
      names.add(entry.pattern);
    }
  }
  return names;
}

function requireNode(graph: ObservationGraphV1, nodeId: string): ObservationNodeV1 {
  const node = graph.nodes.find((candidate) => candidate.id === nodeId);
  if (node === undefined) {
    throw new UiaResolutionError(
      "PlanDiverged",
      `proposed node "${nodeId}" is not present in graph "${graph.graphId}"`,
    );
  }
  return node;
}

function requirePattern(node: ObservationNodeV1, pattern: UiaPattern): UiaPattern {
  if (!availablePatterns(node).has(pattern)) {
    throw new UiaResolutionError(
      "UiaPatternUnsupported",
      `node "${node.id}" does not expose the ${pattern} pattern required for the action`,
    );
  }
  return pattern;
}

export class UiaActionResolver {
  resolve(
    proposal: AnyProposedAction,
    graph: ObservationGraphV1,
    input: UiaResolutionInput,
  ): ResolvedDesktopAction {
    if (proposal.kind === "navigate") {
      throw new UiaResolutionError("UiaPatternUnsupported", "Desktop targets do not support navigate actions");
    }
    if (proposal.target === undefined) {
      throw new UiaResolutionError("PlanDiverged", "Desktop actions require a resolved target node");
    }
    const node = requireNode(graph, proposal.target.nodeId);
    const base = {
      targetKind: "desktop" as const,
      actionId: input.actionId,
      graphId: graph.graphId,
      nodeId: node.id,
      resolution: "semantic" as const,
    };

    switch (proposal.kind) {
      case "click":
        return { ...base, kind: "click", uiaPattern: requirePattern(node, "Invoke") };
      case "input":
        return { ...base, kind: "input", valueRef: proposal.valueRef, uiaPattern: requirePattern(node, "Value") };
      case "select": {
        const patterns = availablePatterns(node);
        const pattern: UiaPattern = patterns.has("SelectionItem") ? "SelectionItem" : "Selection";
        return { ...base, kind: "select", valueRef: proposal.valueRef, uiaPattern: requirePattern(node, pattern) };
      }
      case "scroll":
        return {
          ...base,
          kind: "scroll",
          direction: proposal.direction,
          amount: proposal.amount,
          uiaPattern: requirePattern(node, "Scroll"),
        };
      case "window":
        return {
          ...base,
          kind: "window",
          windowOperation: proposal.operation,
          uiaPattern: requirePattern(node, "Window"),
        };
    }
  }
}

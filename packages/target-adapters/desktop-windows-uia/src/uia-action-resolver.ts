/**
 * Re-resolve a semantic {@link ProposedAction} against a freshly captured
 * Observation Graph into a concrete {@link ResolvedDesktopAction}, choosing the
 * UIA Pattern that will carry out the interaction.
 *
 * Resolution is semantic-first: the proposal references an observation node id,
 * and the matching node's `uia/v1` extension tells us which Pattern is available
 * (`Invoke` for a click). A proposal that no longer matches a live node fails as
 * `PlanDiverged`; a node that lacks the required Pattern fails as
 * `UiaPatternUnsupported`. Neither ever silently falls back to a blind click.
 */

import type { UiaPattern } from "@qualigence/desktop-contracts";
import type {
  ObservationGraphV1,
  ObservationJsonValue,
  ObservationNodeV1,
} from "@qualigence/observation-contracts";
import type { ProposedAction, ResolvedDesktopAction } from "@qualigence/runner-kernel";
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

const CLICK_PATTERN: UiaPattern = "Invoke";

export class UiaActionResolver {
  resolve(
    proposal: ProposedAction,
    graph: ObservationGraphV1,
    input: UiaResolutionInput,
  ): ResolvedDesktopAction {
    const node = graph.nodes.find((candidate) => candidate.id === proposal.target.nodeId);
    if (node === undefined) {
      throw new UiaResolutionError(
        "PlanDiverged",
        `proposed node "${proposal.target.nodeId}" is not present in graph "${graph.graphId}"`,
      );
    }

    const patterns = availablePatterns(node);
    if (!patterns.has(CLICK_PATTERN)) {
      throw new UiaResolutionError(
        "UiaPatternUnsupported",
        `node "${node.id}" does not expose the ${CLICK_PATTERN} pattern required to click`,
      );
    }

    return {
      targetKind: "desktop",
      kind: "click",
      actionId: input.actionId,
      graphId: graph.graphId,
      nodeId: node.id,
      resolution: "semantic",
      uiaPattern: CLICK_PATTERN,
    };
  }
}

/**
 * Map a lossless `uia/v1` {@link UiaSource} into a canonical Observation Graph
 * v1. Common facts (role, name, value, focus/offscreen state, bounds, child
 * relations) go into the cross-platform core; every UIA-specific fact
 * (AutomationId, ControlType, framework, native handle, patterns) is preserved
 * losslessly inside the versioned `uia/v1` extension so nothing is dropped.
 *
 * Password / protected controls are mapped to `sensitivity: "secret"` with NO
 * recoverable value — the Companion already masked the raw value in the worker,
 * and we drop it entirely here so a secret can never reach the Graph, a log, or
 * an Artifact.
 */

import {
  UIA_EXTENSION_TYPE,
  UIA_EXTENSION_VERSION,
  type UiaPatternDescriptor,
} from "@qualigence/desktop-contracts";
import {
  OBSERVATION_GRAPH_V1_SCHEMA,
  validateObservationGraphV1,
  type ObservationGraphV1,
  type ObservationJsonValue,
  type ObservationNodeV1,
  type ObservationRelationV1,
  type VersionedExtension,
} from "@qualigence/observation-contracts";
import type { UiaSource, UiaSourceNode } from "./uia-source.js";

export interface MapUiaOptions {
  /** The adapter identity recorded as each node's provenance. */
  readonly adapterId: string;
  /** Optional stable Graph id; defaults to `uia:<sessionId>`. */
  readonly graphId?: string;
  /** Evidence refs (e.g. the raw source Artifact) to attach to the Graph. */
  readonly evidenceRefs?: readonly string[];
}

const UIA_EXTENSION_KEY = `${UIA_EXTENSION_TYPE}` as const;

function patternPayload(patterns: readonly UiaPatternDescriptor[]): ObservationJsonValue {
  return patterns.map((descriptor) => {
    const entry: Record<string, ObservationJsonValue> = {
      pattern: descriptor.pattern,
      available: descriptor.available,
    };
    if (descriptor.readOnly !== undefined) {
      entry.readOnly = descriptor.readOnly;
    }
    return entry;
  });
}

function uiaExtension(node: UiaSourceNode): VersionedExtension {
  const payload: Record<string, ObservationJsonValue> = {
    controlTypeId: node.controlTypeId,
    processId: node.processId,
    isOffscreen: node.isOffscreen,
    isKeyboardFocusable: node.isKeyboardFocusable,
    hasKeyboardFocus: node.hasKeyboardFocus,
    patterns: patternPayload(node.patterns),
  };
  if (node.automationId !== undefined) {
    payload.automationId = node.automationId;
  }
  if (node.frameworkId !== undefined) {
    payload.frameworkId = node.frameworkId;
  }
  if (node.className !== undefined) {
    payload.className = node.className;
  }
  if (node.nativeWindowHandle !== undefined) {
    payload.nativeWindowHandle = node.nativeWindowHandle;
  }
  return {
    type: UIA_EXTENSION_TYPE,
    version: UIA_EXTENSION_VERSION,
    payload,
  };
}

function mapNode(node: UiaSourceNode, adapterId: string): ObservationNodeV1 {
  const relations: ObservationRelationV1[] = node.children.map((childId) => ({
    type: "child",
    targetNodeId: childId,
  }));

  const state: Record<string, boolean> = {
    offscreen: node.isOffscreen,
    keyboardFocusable: node.isKeyboardFocusable,
    keyboardFocused: node.hasKeyboardFocus,
  };

  const isSecret = node.isPassword;
  const base: {
    id: string;
    role: string;
    name?: string;
    value?: string;
    state: Record<string, boolean>;
    bounds?: { x: number; y: number; width: number; height: number };
    relations: ObservationRelationV1[];
    source: { adapterId: string; sourceKind: string };
    confidence: number;
    sensitivity: "public" | "secret";
    extensions: Record<string, VersionedExtension>;
    evidenceRefs: readonly string[];
  } = {
    id: node.nodeId,
    role: node.role,
    state,
    relations,
    source: { adapterId, sourceKind: "uia" },
    confidence: 1,
    sensitivity: isSecret ? "secret" : "public",
    extensions: { [UIA_EXTENSION_KEY]: uiaExtension(node) },
    evidenceRefs: [],
  };

  if (node.name !== undefined) {
    base.name = node.name;
  }
  // A secret node NEVER carries a recoverable value, even a masked one.
  if (!isSecret && node.value !== undefined) {
    base.value = node.value;
  }
  if (node.bounds !== undefined) {
    base.bounds = {
      x: node.bounds.x,
      y: node.bounds.y,
      width: node.bounds.width,
      height: node.bounds.height,
    };
  }

  return base;
}

/**
 * Produce a validated Observation Graph v1 from a `uia/v1` capture source.
 * Throws {@link ObservationError} if the produced Graph violates the v1 contract.
 */
export function mapUiaPayloadToObservationV1(
  source: UiaSource,
  options: MapUiaOptions,
): ObservationGraphV1 {
  const graph: ObservationGraphV1 = {
    schema: OBSERVATION_GRAPH_V1_SCHEMA,
    graphId: options.graphId ?? `uia:${source.sessionId}`,
    target: { kind: "app", targetId: source.sessionId },
    capturedAt: source.capturedAt,
    rootNodeIds: [...source.rootNodeIds],
    nodes: source.nodes.map((node) => mapNode(node, options.adapterId)),
    evidenceRefs: options.evidenceRefs === undefined ? [] : [...options.evidenceRefs],
  };

  return validateObservationGraphV1(graph);
}

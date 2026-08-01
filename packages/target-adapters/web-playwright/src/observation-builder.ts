import {
  canonicalPayloadHash,
  type ObservationGraph,
  type ObservationNode,
} from "@qualigence/runner-protocol";
import type { LocatorDescriptor } from "./types.js";

export interface ObservationCandidate {
  readonly role: string;
  readonly name?: string;
  readonly text?: string;
  readonly value?: string;
  readonly disabled?: boolean;
}

export interface BuiltObservation {
  readonly graph: ObservationGraph;
  readonly descriptors: ReadonlyMap<string, LocatorDescriptor>;
}

const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "checkbox",
  "radio",
  "combobox",
  "menuitem",
  "tab",
  "switch",
  "option",
]);

export function normalizeVisibleText(input: string): string {
  return input.normalize("NFC").replace(/\s+/g, " ").trim();
}

function normalizeOptional(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = normalizeVisibleText(value);
  return normalized === "" ? undefined : normalized;
}

export function buildObservationGraph(
  runId: string,
  ordinal: number,
  candidates: readonly ObservationCandidate[],
  meta: { readonly url?: string; readonly title?: string; readonly capturedAt?: string } = {},
): BuiltObservation {
  const graphId = `${runId}:observation:${ordinal}`;
  const descriptors = new Map<string, LocatorDescriptor>();
  const nodes: ObservationNode[] = [];

  candidates.forEach((candidate, index) => {
    const role = normalizeVisibleText(candidate.role) || "generic";
    const name = normalizeOptional(candidate.name);
    const text = normalizeOptional(candidate.text);
    const value = normalizeOptional(candidate.value);
    const disabled = candidate.disabled === true ? true : undefined;

    const identity = {
      index,
      role,
      name: name ?? null,
      text: text ?? null,
      value: value ?? null,
      disabled: disabled ?? false,
    };
    const shortHash = canonicalPayloadHash(identity).slice(0, 8);
    const nodeId = `n-${index}-${shortHash}`;

    const node: ObservationNode = {
      id: nodeId,
      role,
      confidence: 1,
      ...(name !== undefined ? { name } : {}),
      ...(text !== undefined ? { text } : {}),
      ...(value !== undefined ? { value } : {}),
      ...(disabled !== undefined ? { disabled } : {}),
    };
    nodes.push(node);

    const useRole = name !== undefined && INTERACTIVE_ROLES.has(role);
    const descriptor: LocatorDescriptor = useRole
      ? {
          kind: "role",
          role,
          ...(name !== undefined ? { name } : {}),
        }
      : {
          kind: "text",
          role,
          ...(text !== undefined ? { text } : name !== undefined ? { text: name } : {}),
        };
    descriptors.set(nodeId, descriptor);
  });

  const graph: ObservationGraph = {
    graphId,
    nodes,
    ...(meta.url !== undefined ? { url: meta.url } : {}),
    ...(meta.title !== undefined ? { title: meta.title } : {}),
    ...(meta.capturedAt !== undefined ? { capturedAt: meta.capturedAt } : {}),
  };

  return { graph, descriptors };
}

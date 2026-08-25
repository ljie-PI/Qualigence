import {
  OBSERVATION_GRAPH_V1_SCHEMA,
  WEB_EXTENSION_V1_REDACTION_MARKER,
  WEB_EXTENSION_V1_TYPE,
  canonicalPayloadHash,
  validateObservationGraphV1,
  type ObservationGraphV1,
  type ObservationNodeV1,
  type WebViewportV1,
} from "@qualigence/runner-protocol";
import type { LocatorDescriptor } from "./types.js";

export interface ObservationCandidate {
  readonly role: string;
  readonly name?: string;
  readonly text?: string;
  readonly value?: string;
  readonly disabled?: boolean;
  readonly sensitive?: boolean;
}

export interface WebObservationMetadata {
  readonly url?: string;
  readonly title?: string;
  readonly capturedAt?: string;
  readonly targetId?: string;
  readonly viewport?: WebViewportV1;
  readonly allowedQueryKeys?: readonly string[];
  readonly evidenceRefs?: readonly string[];
}

export interface BuiltObservation {
  readonly graph: ObservationGraphV1;
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

const ADAPTER_ID = "web-playwright";
const DOCUMENT_NODE_ID = "n-000000-document";
const DEFAULT_CAPTURED_AT = "1970-01-01T00:00:00.000Z";
const DEFAULT_VIEWPORT: WebViewportV1 = { width: 1, height: 1, devicePixelRatio: 1 };

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
  meta: WebObservationMetadata = {},
): BuiltObservation {
  const graphId = `${runId}:observation:${ordinal}`;
  const descriptors = new Map<string, LocatorDescriptor>();
  const childNodes: ObservationNodeV1[] = [];
  const childIds: string[] = [];

  candidates.forEach((candidate, index) => {
    const role = normalizeVisibleText(candidate.role) || "generic";
    const name = normalizeOptional(candidate.name);
    const text = normalizeOptional(candidate.text);
    const value = normalizeOptional(candidate.value);
    const disabled = candidate.disabled === true;
    const displayText = text ?? name ?? value;

    const identity = {
      index,
      role,
      name: name ?? null,
      text: text ?? null,
      value: value ?? null,
      disabled,
    };
    const shortHash = canonicalPayloadHash(identity).slice(0, 8);
    const nodeId = `n-${String(index + 1).padStart(6, "0")}-${shortHash}`;
    childIds.push(nodeId);

    const node = withLegacyProperties({
      id: nodeId,
      role,
      ...(name !== undefined ? { name } : text !== undefined ? { name: text } : {}),
      ...(value !== undefined ? { value } : {}),
      state: { disabled },
      relations: [],
      source: { adapterId: ADAPTER_ID, sourceKind: "dom" },
      confidence: 1,
      sensitivity: candidate.sensitive === true ? "sensitive" : "public",
      extensions: {},
      evidenceRefs: [],
    }, {
      ...(displayText === undefined ? {} : { text: displayText }),
      ...(disabled ? { disabled: true } : {}),
    });
    childNodes.push(node);

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

  const documentNode: ObservationNodeV1 = {
    id: DOCUMENT_NODE_ID,
    role: "document",
    state: {},
    relations: childIds.map((targetNodeId) => ({ type: "child", targetNodeId })),
    source: { adapterId: ADAPTER_ID, sourceKind: "document" },
    confidence: 1,
    sensitivity: "public",
    extensions: {},
    evidenceRefs: [],
  };

  const graph: ObservationGraphV1 = {
    schema: OBSERVATION_GRAPH_V1_SCHEMA,
    graphId,
    target: { kind: "web", targetId: targetIdFromMeta(runId, meta.url, meta.targetId) },
    capturedAt: meta.capturedAt ?? DEFAULT_CAPTURED_AT,
    rootNodeIds: [DOCUMENT_NODE_ID],
    nodes: [documentNode, ...childNodes],
    evidenceRefs: meta.evidenceRefs ?? [],
    ...(meta.url === undefined
      ? {}
      : {
          extensions: {
            [WEB_EXTENSION_V1_TYPE]: buildWebExtension(meta.url, meta.title ?? "", meta.viewport ?? DEFAULT_VIEWPORT, meta.allowedQueryKeys ?? []),
          },
        }),
  };

  validateObservationGraphV1(graph, {
    allowedWebQueryKeys: (meta.allowedQueryKeys ?? []).map((key) => key.normalize("NFC")),
  });
  attachLegacyGraphFields(graph, meta);
  return { graph, descriptors };
}

function targetIdFromMeta(runId: string, url: string | undefined, targetId: string | undefined): string {
  if (targetId !== undefined && targetId.trim() !== "") {
    return targetId;
  }
  if (url !== undefined) {
    return new URL(url).origin;
  }
  return runId;
}

function buildWebExtension(
  url: string,
  title: string,
  viewport: WebViewportV1,
  allowedQueryKeys: readonly string[],
) {
  const parsed = new URL(url);
  const allowed = new Set(allowedQueryKeys.map((key) => key.normalize("NFC")));
  const query: Record<string, typeof WEB_EXTENSION_V1_REDACTION_MARKER> = {};
  for (const key of parsed.searchParams.keys()) {
    const normalizedKey = key.normalize("NFC");
    if (allowed.has(normalizedKey)) {
      query[normalizedKey] = WEB_EXTENSION_V1_REDACTION_MARKER;
    }
  }
  return {
    type: WEB_EXTENSION_V1_TYPE,
    version: "1.0",
    payload: {
      origin: parsed.origin,
      pathname: parsed.pathname,
      title,
      viewport,
      query,
    },
  } as const;
}

function attachLegacyGraphFields(graph: ObservationGraphV1, meta: WebObservationMetadata): void {
  defineHidden(graph, "url", meta.url === undefined ? undefined : sanitizedLegacyUrl(meta.url));
  defineHidden(graph, "title", meta.title);
  defineHidden(graph, "artifactRefs", meta.evidenceRefs);
}

function sanitizedLegacyUrl(url: string): string {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
}

function withLegacyProperties<T extends ObservationNodeV1>(
  node: T,
  properties: { readonly text?: string; readonly disabled?: boolean },
): T {
  defineHidden(node, "text", properties.text);
  defineHidden(node, "disabled", properties.disabled);
  return node;
}

function defineHidden(target: object, property: string, value: unknown): void {
  if (value === undefined) {
    return;
  }
  Object.defineProperty(target, property, {
    value,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}

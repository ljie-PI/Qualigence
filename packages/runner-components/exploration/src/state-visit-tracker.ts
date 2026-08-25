import {
  canonicalPayloadHash,
  type ObservationGraph,
} from "@qualigence/runner-protocol";

/**
 * A deterministic, canonical fingerprint of an Observation Graph used to detect
 * revisited states. It reuses the protocol's {@link canonicalPayloadHash} rather
 * than inventing a parallel hashing scheme.
 *
 * Normalization keeps only semantically meaningful state — URL path, and each
 * interactable node's role/name/text/value/disabled flag — and drops everything
 * volatile: the graph id, node ids, capture timestamp, artifact refs, model
 * confidence, and the URL query/hash. Nodes are sorted so DOM reordering does
 * not change the fingerprint, while a genuine semantic or state change does.
 */
export function fingerprintObservationGraph(graph: ObservationGraph): string {
  const nodes = graph.nodes
    .map((node) => ({
      role: normalizeText(node.role),
      name: normalizeText(node.name ?? ""),
      text: normalizeText(node.text ?? ""),
      value: normalizeText(node.value ?? ""),
      disabled: node.disabled === true,
    }))
    .sort((a, b) => (canonicalNode(a) < canonicalNode(b) ? -1 : canonicalNode(a) > canonicalNode(b) ? 1 : 0));

  return canonicalPayloadHash({
    urlPath: normalizeUrlPath(graph.url),
    title: normalizeText(graph.title ?? ""),
    nodes,
  });
}

function canonicalNode(node: {
  readonly role: string;
  readonly name: string;
  readonly text: string;
  readonly value: string;
  readonly disabled: boolean;
}): string {
  return `${node.role}\u0000${node.name}\u0000${node.text}\u0000${node.value}\u0000${node.disabled ? "1" : "0"}`;
}

function normalizeUrlPath(url: string | undefined): string {
  if (url === undefined || url.length === 0) {
    return "";
  }
  try {
    return new URL(url).pathname;
  } catch {
    // Not an absolute URL — strip any query/hash and keep the path portion.
    const withoutHash = url.split("#", 1)[0] ?? "";
    return withoutHash.split("?", 1)[0] ?? "";
  }
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/** The outcome of recording a state visit. */
export type StateVisit =
  | { readonly status: "novel"; readonly fingerprint: string; readonly visits: number }
  | {
      readonly status: "repeated";
      readonly fingerprint: string;
      readonly visits: number;
      readonly reason: "state_repeated";
    };

/**
 * Tracks which state fingerprints have been visited within a single exploration
 * session so the controller never wastes budget re-exploring a state it has
 * already seen. The default cap of `1` enforces the hard invariant that a state
 * is never revisited once fingerprinted; a larger cap permits bounded repeats
 * and still stops at the exact threshold.
 */
export class StateVisitTracker {
  private readonly visits = new Map<string, number>();

  constructor(private readonly maximumVisits: number = 1) {
    if (!Number.isInteger(maximumVisits) || maximumVisits < 1) {
      throw new Error("StateVisitTracker maximumVisits must be a positive integer.");
    }
  }

  restore(fingerprint: string): void {
    const current = this.visits.get(fingerprint) ?? 0;
    if (current < this.maximumVisits) {
      this.visits.set(fingerprint, current + 1);
    }
  }

  fingerprintOf(graph: ObservationGraph): string {
    return fingerprintObservationGraph(graph);
  }

  hasVisited(fingerprint: string): boolean {
    return (this.visits.get(fingerprint) ?? 0) > 0;
  }

  visitCount(fingerprint: string): number {
    return this.visits.get(fingerprint) ?? 0;
  }

  /**
   * Records one visit to `fingerprint`. Returns `repeated` (terminal reason
   * `state_repeated`) once the fingerprint would exceed the configured cap; the
   * visit count is not incremented past the cap so the decision is stable.
   */
  record(fingerprint: string): StateVisit {
    const current = this.visits.get(fingerprint) ?? 0;
    if (current >= this.maximumVisits) {
      return {
        status: "repeated",
        fingerprint,
        visits: current,
        reason: "state_repeated",
      };
    }
    const next = current + 1;
    this.visits.set(fingerprint, next);
    return { status: "novel", fingerprint, visits: next };
  }
}

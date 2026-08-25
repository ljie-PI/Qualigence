import type { ObservationGraphV1 } from "@qualigence/runner-protocol";
import { fingerprintObservationGraphV1 } from "./observation-v1-consumer.js";

/**
 * A deterministic, canonical fingerprint of an Observation Graph v1 used to
 * detect revisited states. It validates the graph, reads URL/title semantics only
 * from the typed redacted web/v1 extension, and hashes a stable projection of v1
 * core fields and canonical relation semantics while dropping volatile graph ids,
 * node ids, timestamps, confidence, and evidence refs.
 */
export function fingerprintObservationGraph(graph: ObservationGraphV1): string {
  return fingerprintObservationGraphV1(graph);
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

  fingerprintOf(graph: ObservationGraphV1): string {
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

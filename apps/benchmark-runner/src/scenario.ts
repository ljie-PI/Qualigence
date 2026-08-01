import type { FindingConfidence } from "@qualigence/benchmarking-detection";
import type {
  ExplorationContext,
  ExplorationProposal,
  ExplorationTarget,
  GroundedExplorationAction,
} from "@qualigence/exploration";
import type { ObservationGraph, ObservationNode } from "@qualigence/runner-protocol";

/** A deterministic detection signal a scenario state surfaces when observed. */
export interface ScenarioSignal {
  readonly defectId: string;
  readonly confidence: FindingConfidence;
}

/** One observable state of a deterministic scenario target. */
export interface ScenarioState {
  readonly id: string;
  readonly url: string;
  readonly title?: string;
  readonly nodes: readonly ObservationNode[];
  /** The node the walker clicks to advance, or `null` for a terminal state. */
  readonly advanceNodeId: string | null;
  readonly signals: readonly ScenarioSignal[];
}

/** A frozen, synthetic fixture app with (optionally) seeded defects. */
export interface ScenarioDefinition {
  readonly scenarioId: string;
  readonly mode: "normal" | "fault";
  readonly seedUrl?: string;
  readonly states: readonly ScenarioState[];
}

function asRecord(value: unknown, ctx: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${ctx} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, key: string, ctx: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${ctx} is missing required string field "${key}".`);
  }
  return value;
}

function parseNode(value: unknown): ObservationNode {
  const record = asRecord(value, "scenario node");
  const id = requireString(record, "id", "scenario node");
  const role = requireString(record, "role", "scenario node");
  const confidence = record["confidence"];
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
    throw new Error(`scenario node "${id}" is missing a numeric confidence.`);
  }
  const node: {
    -readonly [K in keyof ObservationNode]?: ObservationNode[K];
  } = { id, role, confidence };
  if (typeof record["name"] === "string") node.name = record["name"];
  if (typeof record["text"] === "string") node.text = record["text"];
  if (typeof record["value"] === "string") node.value = record["value"];
  if (typeof record["disabled"] === "boolean") node.disabled = record["disabled"];
  return node as ObservationNode;
}

function parseSignal(value: unknown): ScenarioSignal {
  const record = asRecord(value, "scenario signal");
  const defectId = requireString(record, "defectId", "scenario signal");
  const confidence = requireString(record, "confidence", "scenario signal");
  if (confidence !== "low" && confidence !== "medium" && confidence !== "high") {
    throw new Error(`scenario signal "${defectId}" has invalid confidence "${confidence}".`);
  }
  return { defectId, confidence };
}

function parseState(value: unknown): ScenarioState {
  const record = asRecord(value, "scenario state");
  const nodesRaw = record["nodes"];
  if (!Array.isArray(nodesRaw)) {
    throw new Error("scenario state.nodes must be an array.");
  }
  const signalsRaw = record["signals"] ?? [];
  if (!Array.isArray(signalsRaw)) {
    throw new Error("scenario state.signals must be an array.");
  }
  const advanceRaw = record["advanceNodeId"];
  const advanceNodeId =
    advanceRaw === null || advanceRaw === undefined
      ? null
      : typeof advanceRaw === "string"
        ? advanceRaw
        : (() => {
            throw new Error("scenario state.advanceNodeId must be a string or null.");
          })();
  const state: ScenarioState = {
    id: requireString(record, "id", "scenario state"),
    url: requireString(record, "url", "scenario state"),
    ...(typeof record["title"] === "string" ? { title: record["title"] } : {}),
    nodes: nodesRaw.map((node) => parseNode(node)),
    advanceNodeId,
    signals: signalsRaw.map((signal) => parseSignal(signal)),
  };
  return state;
}

/** Strictly parse an untrusted scenario JSON value into a typed definition. */
export function parseScenario(value: unknown): ScenarioDefinition {
  const record = asRecord(value, "scenario");
  const mode = requireString(record, "mode", "scenario");
  if (mode !== "normal" && mode !== "fault") {
    throw new Error(`scenario.mode must be "normal" or "fault", received "${mode}".`);
  }
  const statesRaw = record["states"];
  if (!Array.isArray(statesRaw) || statesRaw.length === 0) {
    throw new Error("scenario.states must be a non-empty array.");
  }
  return {
    scenarioId: requireString(record, "scenarioId", "scenario"),
    mode,
    ...(typeof record["seedUrl"] === "string" ? { seedUrl: record["seedUrl"] } : {}),
    states: statesRaw.map((state) => parseState(state)),
  };
}

/**
 * A deterministic {@link ExplorationTarget} built from a scenario definition. It
 * walks a linear chain of states: `capture()` returns the current state's
 * observation graph and records the visit, and `execute()` advances to the next
 * state only when the walker clicks the state's declared advance node. The
 * detection signals of every state actually captured are collected as findings —
 * so detection depends on where the real exploration session actually reached.
 */
export class ScenarioExplorationTarget implements ExplorationTarget {
  private index = 0;
  private readonly visited: ScenarioState[] = [];

  constructor(private readonly scenario: ScenarioDefinition) {}

  async capture(): Promise<ObservationGraph> {
    const state = this.currentState();
    this.visited.push(state);
    return {
      graphId: `${this.scenario.scenarioId}:${state.id}`,
      url: state.url,
      ...(state.title === undefined ? {} : { title: state.title }),
      nodes: state.nodes,
    };
  }

  async execute(action: GroundedExplorationAction): Promise<void> {
    const state = this.currentState();
    if (
      action.kind === "click" &&
      state.advanceNodeId !== null &&
      action.node?.id === state.advanceNodeId &&
      this.index < this.scenario.states.length - 1
    ) {
      this.index += 1;
    }
  }

  /** The dedup'd detection findings from every state this session captured. */
  collectFindings(): ScenarioSignal[] {
    const seen = new Set<string>();
    const findings: ScenarioSignal[] = [];
    for (const state of this.visited) {
      for (const signal of state.signals) {
        if (seen.has(signal.defectId)) {
          continue;
        }
        seen.add(signal.defectId);
        findings.push(signal);
      }
    }
    return findings;
  }

  private currentState(): ScenarioState {
    const state = this.scenario.states[this.index];
    if (state === undefined) {
      throw new Error(`Scenario "${this.scenario.scenarioId}" has no state at index ${this.index}.`);
    }
    return state;
  }
}

/**
 * A deterministic exploration proposer that walks the fixture: it proposes
 * clicking the first `link` node in the current graph (the advance control), or
 * stops when there is none. It stands in for the model so the reference
 * benchmark is fully reproducible; a BYO profile may substitute a model-backed
 * agent. It only ever proposes — the controller owns every decision.
 */
export class ScenarioWalkAgent {
  async nextAction(context: ExplorationContext): Promise<ExplorationProposal> {
    const link = context.graph.nodes.find((node) => node.role === "link");
    if (link === undefined) {
      return { decision: { status: "stop", reason: "no further navigation available" }, tokensUsed: 8 };
    }
    return {
      decision: {
        status: "act",
        action: { kind: "click", nodeId: link.id, reason: `advance via ${link.name ?? link.id}` },
        reason: "walk to the next unexplored state",
      },
      tokensUsed: 8,
    };
  }
}

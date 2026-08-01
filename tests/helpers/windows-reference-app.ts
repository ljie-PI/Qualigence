/**
 * Test doubles + fixture loaders for the Linux-runnable Windows-UIA "Reference
 * App" pipeline tests (LS-13 Task 5).
 *
 * There is NO real Windows 11 machine, WPF/WinUI runtime, or UIA provider in
 * this sandbox, so we cannot capture a real UIA tree here. Instead we drive the
 * *entire* production software stack (Companion IPC client → Desktop adapter →
 * Observation Graph v1 → Runner Kernel executor → LS-08 Skill compiler/replay)
 * against SYNTHETIC-BUT-REALISTIC fixture data that is field-for-field the
 * {@link UiaSource} DTO the Rust Companion returns on Windows. This is the
 * maximum realism achievable off-Windows and proves the software logic.
 *
 * A REAL Windows 11 run against the compiled WindowsReferenceWpf /
 * WindowsReferenceWinUi apps is a SEPARATE, human/operator-performed manual step
 * (see docs/testing/windows-m3-manual-checklist.md and each fixture's
 * `manualWindowsVerification` block). This file never fabricates such a run.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type {
  ActionOutcomeReport,
  CompanionClient,
  DesktopActionExecuteRequest,
  UiaCaptureRequest,
  UiaSource,
} from "@qualigence/desktop-windows-uia";
import type {
  AppSession,
  AppTarget,
  LocalApprovalDecision,
  LocalExecutionPermit,
  LocalPermitRequest,
} from "@qualigence/desktop-contracts";
import { classifyLocalAuthorization, isLocalPermitExpired } from "@qualigence/desktop-contracts";
import type { ProposedAction } from "@qualigence/runner-kernel";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(HERE, "..", "fixtures");

export type ReferenceAppTechnology = "wpf" | "winui";

export type ReferenceAppCapability =
  | "Button"
  | "Edit"
  | "ComboBox"
  | "List"
  | "Scroll"
  | "Dialog"
  | "Crash"
  | "Reset"
  | "HighRisk";

export interface ReferenceExpectedAction {
  readonly actionId: string;
  readonly description: string;
  readonly proposal: ProposedAction;
  readonly expectedResolution: "semantic";
  readonly expectedUiaPattern: string;
  readonly kindRisk: "Normal" | "ExternalSideEffect" | "Destructive";
  readonly policyRisk: "Normal" | "ExternalSideEffect" | "Destructive" | "ProductionForbidden";
  readonly requiresLocalApproval: boolean;
}

export interface ReferenceAppFixture {
  readonly app: {
    readonly name: string;
    readonly technology: ReferenceAppTechnology;
    readonly frameworkId: string;
    readonly executableImageName: string;
  };
  readonly capabilities: readonly ReferenceAppCapability[];
  readonly appTarget: AppTarget;
  readonly uiaSource: UiaSource;
  readonly expectedActions: readonly ReferenceExpectedAction[];
  readonly manualWindowsVerification: {
    readonly steps: readonly string[];
  };
}

const FIXTURE_DIRS: Readonly<Record<ReferenceAppTechnology, string>> = {
  wpf: "windows-reference-wpf",
  winui: "windows-reference-winui",
};

/** Load a Reference App fixture (the synthetic UIA capture + expected actions). */
export function loadReferenceAppFixture(technology: ReferenceAppTechnology): ReferenceAppFixture {
  const path = join(FIXTURE_ROOT, FIXTURE_DIRS[technology], "reference-app.fixture.json");
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw) as ReferenceAppFixture;
}

/** Every Reference App fixture the suite exercises. */
export function loadAllReferenceAppFixtures(): readonly ReferenceAppFixture[] {
  return [loadReferenceAppFixture("wpf"), loadReferenceAppFixture("winui")];
}

/** The declared capability set of a fixture (Button/Edit/HighRisk/…). */
export function referenceFixtureCapabilities(
  fixture: ReferenceAppFixture,
): ReadonlySet<ReferenceAppCapability> {
  return new Set(fixture.capabilities);
}

export function referenceExpectedAction(
  fixture: ReferenceAppFixture,
  actionId: string,
): ReferenceExpectedAction {
  const action = fixture.expectedActions.find((candidate) => candidate.actionId === actionId);
  if (action === undefined) {
    throw new Error(`fixture "${fixture.app.name}" has no expected action "${actionId}"`);
  }
  return action;
}

export interface FakeReferenceCompanionOptions {
  /**
   * Whether the operator approves a `requires-approval` (Destructive /
   * ExternalSideEffect) local Permit request. Defaults to `true`; set `false`
   * to model a human denial.
   */
  readonly approveHighRisk?: boolean;
  /** Fixed clock; defaults to a deterministic 2026 instant. */
  readonly now?: () => string;
  /** Permit TTL in milliseconds handed to each minted local Permit. */
  readonly permitTtlMs?: number;
}

interface MintedPermitRecord {
  readonly permit: LocalExecutionPermit;
  consumed: boolean;
}

export interface ExecutedActionRecord {
  readonly actionId: string;
  readonly nodeId: string;
  readonly actionDigestSha256: string;
  readonly permitToken: string;
}

/**
 * A Linux test-double for the Rust Companion broker. It models the SECURITY
 * semantics the real Companion enforces (specialist finding W-01): TypeScript
 * never touches UIA directly; every action is brokered through a one-time local
 * Permit; a paused / emergency-stopped session dispatches ZERO actions; a
 * forbidden risk is always denied; a higher-risk action needs an explicit
 * approval; and a Permit is single-use (a replay fails closed).
 *
 * It is driven entirely by a fixture's {@link UiaSource}: `capture()` returns
 * that synthetic tree, exactly as the real worker would return a real UIA
 * capture on Windows.
 */
export class FakeReferenceCompanion implements CompanionClient {
  private readonly permits = new Map<string, MintedPermitRecord>();
  private readonly executed: ExecutedActionRecord[] = [];
  private stopped = false;
  private paused = false;
  private hangNextCapture = false;
  private launchedSessionId: string | undefined;
  private captureCount = 0;
  private workerRestarts = 0;
  private permitSequence = 0;
  private readonly now: () => string;
  private readonly permitTtlMs: number;
  private readonly approveHighRisk: boolean;

  constructor(
    private readonly source: UiaSource,
    options: FakeReferenceCompanionOptions = {},
  ) {
    this.approveHighRisk = options.approveHighRisk ?? true;
    this.now = options.now ?? (() => "2026-08-02T00:00:00.000Z");
    this.permitTtlMs = options.permitTtlMs ?? 60_000;
  }

  /** Latch an Emergency Stop: from now on every permit request is refused. */
  emergencyStop(): void {
    this.stopped = true;
    for (const record of this.permits.values()) {
      record.consumed = true;
    }
  }

  /** Pause the session: auto-approval is suspended and prompts time out. */
  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  /** Make the next `capture()` fail as if the UIA worker had died. */
  simulateWorkerHang(): void {
    this.hangNextCapture = true;
  }

  get executedActions(): readonly ExecutedActionRecord[] {
    return this.executed;
  }

  get consumedPermitCount(): number {
    return [...this.permits.values()].filter((record) => record.consumed).length;
  }

  get capturedCount(): number {
    return this.captureCount;
  }

  get workerRestartCount(): number {
    return this.workerRestarts;
  }

  async launch(target: AppTarget): Promise<AppSession> {
    const sessionId = `sess:${target.targetId}`;
    this.launchedSessionId = sessionId;
    return {
      sessionId,
      processId: this.source.nodes[0]?.processId ?? 4242,
      processCreationTime: this.now(),
      processGroupId: `job:${target.targetId}`,
      rootWindowHandle: this.source.nodes[0]?.nativeWindowHandle ?? "0x00010",
      startedAt: this.now(),
    };
  }

  async reset(_sessionId: string): Promise<void> {
    // A reset re-arms the worker but never resurrects consumed permits.
    this.hangNextCapture = false;
  }

  async shutdown(_sessionId: string): Promise<void> {
    this.stopped = true;
  }

  async capture(request: UiaCaptureRequest): Promise<UiaSource> {
    if (this.hangNextCapture) {
      this.hangNextCapture = false;
      this.workerRestarts += 1;
      throw new Error("UiaWorkerUnavailable: the UIA worker did not respond before the deadline");
    }
    this.captureCount += 1;
    return {
      ...this.source,
      sessionId: request.sessionId,
    };
  }

  async requestPermit(request: LocalPermitRequest): Promise<LocalApprovalDecision> {
    const decidedAt = this.now();
    if (this.stopped) {
      return { status: "emergency_stopped", approvalId: request.approvalId, decidedAt };
    }
    if (this.paused) {
      return { status: "timed_out", approvalId: request.approvalId, decidedAt };
    }

    const authorizationClass = classifyLocalAuthorization(request.authorization.risk);
    if (authorizationClass === "forbidden") {
      return { status: "denied", approvalId: request.approvalId, decidedAt };
    }
    if (authorizationClass === "requires-approval" && !this.approveHighRisk) {
      return { status: "denied", approvalId: request.approvalId, decidedAt };
    }

    const permit = this.mintPermit(request);
    this.permits.set(permit.permitToken, { permit, consumed: false });
    return { status: "approved", approvalId: request.approvalId, decidedAt, permit };
  }

  async execute(request: DesktopActionExecuteRequest): Promise<ActionOutcomeReport> {
    if (this.stopped) {
      return { status: "failed", errorCode: "EmergencyStopped" };
    }
    const record = this.permits.get(request.permit.permitToken);
    if (record === undefined) {
      return { status: "failed", errorCode: "LocalPermitUnknown" };
    }
    if (record.consumed) {
      // One-time Permit: a replay fails closed.
      return { status: "failed", errorCode: "LocalPermitConsumed" };
    }
    if (record.permit.actionDigestSha256 !== request.permit.actionDigestSha256) {
      return { status: "failed", errorCode: "LocalPermitBindingMismatch" };
    }
    if (isLocalPermitExpired(record.permit, this.now())) {
      return { status: "failed", errorCode: "LocalPermitTimedOut" };
    }

    record.consumed = true;
    this.executed.push({
      actionId: request.action.actionId,
      nodeId: request.action.nodeId,
      actionDigestSha256: request.permit.actionDigestSha256,
      permitToken: request.permit.permitToken,
    });
    return { status: "ok" };
  }

  private mintPermit(request: LocalPermitRequest): LocalExecutionPermit {
    this.permitSequence += 1;
    const issuedAt = this.now();
    const expiresAt = new Date(Date.parse(issuedAt) + this.permitTtlMs).toISOString();
    return {
      permitToken: `permit:${this.launchedSessionId ?? request.sessionId}:${this.permitSequence}`,
      nonceBase64: Buffer.from(`nonce-${this.permitSequence}`).toString("base64"),
      sessionId: request.sessionId,
      runId: request.runId,
      actionId: request.action.actionId,
      actionDigestSha256: request.authorization.actionDigestSha256,
      graphId: request.action.graphId,
      risk: request.authorization.risk,
      issuedAt,
      expiresAt,
    };
  }
}

// ---------------------------------------------------------------------------
// LS-08 Skill compiler / replay integration leg
// ---------------------------------------------------------------------------

import type { ObservationGraphV1 } from "@qualigence/observation-contracts";
import type {
  ReplayObservation,
  ReplayTarget,
  ResolvedReplayAction,
} from "@qualigence/skill-replay";

/**
 * Project a captured desktop {@link ObservationGraphV1} into the semantic
 * {@link ReplayObservation} the LS-08 Skill replay controller consumes. Only the
 * cross-platform core (role/name/value) crosses the boundary — a secret node
 * exposes no value, exactly as the Graph guarantees. This proves the Desktop
 * Graph v1 feeds the SAME replay pipeline the Web target uses.
 */
export function graphToReplayObservation(
  graph: ObservationGraphV1,
  claims: readonly string[],
): ReplayObservation {
  return {
    urlPath: `app://${graph.target.targetId}`,
    nodes: graph.nodes.map((node) => {
      const base: { role: string; name: string; text?: string } = {
        role: node.role,
        name: node.name ?? "",
      };
      if (node.value !== undefined) {
        base.text = node.value;
      }
      return base;
    }),
    claims: [...claims],
  };
}

/**
 * A live-Target double for Skill replay backed by a desktop Graph v1. Clicking
 * the node named `submitNodeName` satisfies the `submittedClaimId` semantic
 * claim, so a Procedure Skill compiled from a desktop recording can be replayed
 * end to end against the Graph the Companion→adapter pipeline produced.
 */
export class DesktopReferenceReplayTarget implements ReplayTarget {
  private readonly claims = new Set<string>();

  constructor(
    private readonly graph: ObservationGraphV1,
    private readonly submitNodeName: string,
    private readonly submittedClaimId: string,
  ) {}

  async capture(): Promise<ReplayObservation> {
    return graphToReplayObservation(this.graph, [...this.claims]);
  }

  async execute(action: ResolvedReplayAction): Promise<void> {
    if (action.node?.name === this.submitNodeName) {
      this.claims.add(this.submittedClaimId);
    }
  }
}

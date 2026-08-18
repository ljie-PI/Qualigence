import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SqliteRuntime,
  SqliteEvidenceCapsuleStore,
  SqliteReviewStore,
  EvidenceLifecycleError,
} from "@qualigence/sqlite-runtime";
import {
  InvestigationCoordinator,
  type InvestigationCoordinatorConfig,
  type InvestigationModelAgentPort,
  type InvestigationOutcome,
  type ReproductionAttemptDraft,
  type ReproductionPlan,
  type ReproductionRunnerPort,
  type InvestigationBudget,
} from "@qualigence/investigation";
import type {
  IntelligenceJob,
  IntelligenceResult,
} from "@qualigence/intelligence";
import {
  encodeCapsuleEntry,
  decodeCapsuleEntry,
  EvidenceEnvelopeEncryptor,
  type EvidenceCapsuleEntry,
  type EvidenceDecryptionContext,
  type EvidenceEncryptionProfile,
  type EvidenceKeyScope,
} from "@qualigence/evidence";
import { EvidenceCapsuleBuilder } from "@qualigence/evidence-capsule";
import { InMemoryTestKms } from "@qualigence/kms-self-hosted";
import { openReviewTask, type ReviewTask } from "@qualigence/review";
import type { FindingEnvelope } from "@qualigence/runner-protocol";
import {
  PlaywrightBrowserSession,
  PlaywrightObserver,
} from "@qualigence/web-playwright/internal";
import { htmlDocument, startFixtureServer, type FixtureServer } from "../web-execution/fixtures.js";

/**
 * The full LS-10 offline-investigation Gate. A real Finding drives a real,
 * bounded reproduction against Chromium via the existing Playwright adapter. On
 * a confirmed reproduction the Runner captures the ACTUAL evidence bytes
 * (screenshot + semantic graph), an Evidence Capsule is built and RSA/AES
 * encrypted through the real local KMS, and persisted into SQLite. The database
 * file is then closed and REOPENED and the Runner's local source artifacts are
 * deleted, proving that an offline operator can restore the exact evidence bytes
 * from the persisted Capsule alone. A non-reproducing Finding instead exhausts
 * its budget and produces a persisted Human Review Task. The revoke-before-delete
 * lifecycle invariant is exercised against the persisted Capsule.
 */

const FROZEN = "2026-08-01T00:00:00.000Z";

const BUGGY_CART = htmlDocument(
  `
    <h1 data-qualigence-observe>Checkout</h1>
    <p data-qualigence-observe id="total">Cart total: $19</p>
    <button id="pay">Pay now</button>
  `,
  "Checkout",
);

const CORRECT_CART = htmlDocument(
  `
    <h1 data-qualigence-observe>Checkout</h1>
    <p data-qualigence-observe id="total">Cart total: $29</p>
    <button id="pay">Pay now</button>
  `,
  "Checkout",
);

const config: InvestigationCoordinatorConfig = {
  tenantId: "tenant-a",
  modelProfileId: "model-a",
  dataPolicyId: "policy-1",
  jobBudget: { maximumTokens: 100_000, maximumCostMicros: 1_000_000, timeoutMs: 60_000 },
  maxPlanRevisions: 5,
};

const budget: InvestigationBudget = {
  maximumReproductionAttempts: 3,
  maximumPlanningRevisions: 5,
  maximumEnvironmentRetries: 3,
  maximumWallClockMs: 600_000,
  maximumModelTokens: 500_000,
  maximumEnvironmentResets: 5,
  maximumDestructiveActions: 2,
  confirmationConfidenceThreshold: 0.8,
};

const noUsage = {
  reproductionAttempts: 0,
  planningRevisions: 0,
  environmentRetries: 0,
  wallClockMs: 0,
  modelTokens: 0,
  environmentResets: 0,
  destructiveActions: 0,
};

interface CapturedEvidence {
  readonly screenshotBytes: Uint8Array;
  readonly graphBytes: Uint8Array;
  readonly artifactDir: string;
}

/**
 * A real reproduction Runner. It launches Chromium against the fixture, observes
 * the page, decides whether the defect reproduces from the captured semantic
 * graph, and persists the ACTUAL screenshot + graph bytes to a local artifact
 * directory (the Runner's source artifacts). The evidence is keyed by attemptId
 * so the harness can later capsule the real bytes for a confirmed attempt.
 */
class PlaywrightReproductionRunner implements ReproductionRunnerPort {
  readonly captured = new Map<string, CapturedEvidence>();
  private counter = 0;

  constructor(
    private readonly fixtureUrl: string,
    private readonly origin: string,
    private readonly artifactRoot: string,
  ) {}

  async reproduce(_plan: ReproductionPlan): Promise<ReproductionAttemptDraft> {
    this.counter += 1;
    const attemptId = `attempt-${this.counter}`;
    const session = new PlaywrightBrowserSession({
      url: this.fixtureUrl,
      headed: false,
      navigationTimeoutMs: 15_000,
      actionTimeoutMs: 10_000,
      allowedOrigins: [this.origin],
    });
    await session.start();
    try {
      const observer = new PlaywrightObserver(session);
      const graph = await observer.capture({
        jobId: `job-${attemptId}`,
        runId: `run-${attemptId}`,
        target: { kind: "web", url: this.fixtureUrl },
        objective: "Reproduce the cart total defect",
        policy: { policyId: "policy-1", environment: "isolated_test", allowedOrigins: [this.origin], allowedActionKinds: ["click"], maximumRisk: "Normal", explorationAllowed: false, issuedAt: FROZEN, expiresAt: "2026-08-01T00:01:00.000Z" },
      });

      const total = graph.nodes.find((n) => n.text?.includes("Cart total"));
      // The defect reproduces when the checkout total is the wrong $19.
      const reproduced = total?.text?.includes("$19") === true;

      const artifacts = session.artifactsFor(graph.graphId);
      const screenshot = artifacts.find((a) => a.mediaType === "image/png");
      const graphJson = artifacts.find((a) => a.mediaType === "application/json");
      if (screenshot === undefined || graphJson === undefined) {
        throw new Error("Expected screenshot and graph artifacts.");
      }

      const dir = join(this.artifactRoot, attemptId);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "screenshot.png"), screenshot.bytes);
      await writeFile(join(dir, "graph.json"), graphJson.bytes);
      this.captured.set(attemptId, {
        screenshotBytes: screenshot.bytes,
        graphBytes: graphJson.bytes,
        artifactDir: dir,
      });

      return {
        attemptId,
        environmentRef: "chromium",
        startedAt: FROZEN,
        completedAt: FROZEN,
        outcome: reproduced ? "reproduced" : "not_reproduced",
        evidenceRefs: [join(dir, "screenshot.png"), join(dir, "graph.json")],
        budgetConsumed: { ...noUsage, wallClockMs: 5_000, modelTokens: 300 },
      };
    } finally {
      await session.close();
    }
  }
}

function planResult(job: IntelligenceJob): IntelligenceResult {
  return {
    jobId: job.jobId,
    resultSchemaVersion: "intelligence-result/v1",
    proposals: [
      {
        steps: [{ kind: "navigate", path: "/" }],
        rationale: "Reproduce the checkout total defect.",
      },
    ],
    evidenceRefs: ["evidence-1"],
    confidence: 0.9,
    provenance: ["model-a"],
    usage: { inputTokens: 100, outputTokens: 100, costMicros: 200 },
    terminalStatus: "succeeded",
    idempotencyKey: job.idempotencyKey,
  };
}

function analysisResult(
  job: IntelligenceJob,
  confirmedAttemptId: string,
): IntelligenceResult {
  return {
    jobId: job.jobId,
    resultSchemaVersion: "intelligence-result/v1",
    proposals: [
      {
        episodeId: `episode-${confirmedAttemptId}`,
        confirmedAttemptIds: [confirmedAttemptId],
        expectedClaims: ["cart.total==29"],
        observedFacts: ["cart.total==19"],
        minimalSteps: [{ kind: "navigate", path: "/" }],
        environment: { browser: "chromium" },
      },
    ],
    evidenceRefs: ["evidence-1"],
    confidence: 0.95,
    provenance: ["model-a"],
    usage: { inputTokens: 80, outputTokens: 120, costMicros: 200 },
    terminalStatus: "succeeded",
    idempotencyKey: job.idempotencyKey,
  };
}

const scriptedAgent: InvestigationModelAgentPort = {
  async proposeReproductionPlan(job) {
    return planResult(job);
  },
  async analyzeBug(job, context) {
    const reproduced = context.reproducedAttempts.at(-1);
    return analysisResult(job, reproduced?.attemptId ?? "unknown");
  },
};

let caseCounter = 0;
function newId(): string {
  caseCounter += 1;
  return `id-${caseCounter}`;
}

function scopeFor(caseId: string): EvidenceKeyScope {
  return { tenantId: "tenant-a", caseId, region: "eu-local", purpose: "investigation" };
}

function authorizedContext(
  profile: EvidenceEncryptionProfile,
): EvidenceDecryptionContext {
  return {
    actorType: "service",
    actorId: "offline-worker",
    correlationId: "corr-offline",
    tenantId: profile.tenantId,
    caseId: profile.caseId,
    recipient: profile.recipient,
    region: profile.region,
    purpose: "investigation",
    policyId: profile.policyId,
    now: FROZEN,
  };
}

describe("LS-10 offline investigation Gate", () => {
  let dir: string;
  let dbPath: string;
  let runtime: SqliteRuntime;
  let kms: InMemoryTestKms;
  let fixture: FixtureServer;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), ".tmp-ls10-gate-"));
    dbPath = join(dir, "qualigence.db");
    runtime = await SqliteRuntime.open({ filename: dbPath, busyTimeoutMs: 5_000 });
    kms = new InMemoryTestKms({ ttlMs: 60 * 60 * 1000, now: () => FROZEN });
  });

  afterEach(async () => {
    await runtime.close();
    await fixture?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("confirms a bug, persists an encrypted Capsule and restores exact bytes offline", async () => {
    fixture = await startFixtureServer({ "/": BUGGY_CART });
    const artifactRoot = join(dir, "artifacts");
    const runner = new PlaywrightReproductionRunner(fixture.url, fixture.origin, artifactRoot);
    const coordinator = new InvestigationCoordinator(scriptedAgent, runner, config, newId);

    const finding: FindingEnvelope = {
      findingId: "finding-1",
      runId: "run-1",
      title: "Checkout total is wrong",
      summary: "Cart total shows $19 instead of $29.",
      severity: "high",
      evidenceRefs: ["evidence-1"],
    };

    const outcome = await coordinator.investigate({
      caseId: "case-1",
      findingId: finding.findingId,
      projectId: "proj-1",
      budget,
      inputRefs: finding.evidenceRefs,
    });
    expect(outcome.status).toBe("confirmed");
    const episode = outcome.bugEpisode;
    expect(episode).toBeDefined();

    // Capsule the ACTUAL reproduction bytes read from the Runner's source dir.
    const confirmedAttemptId = episode!.confirmedAttemptIds[0];
    const evidence = runner.captured.get(confirmedAttemptId);
    expect(evidence).toBeDefined();

    const store = new SqliteEvidenceCapsuleStore(runtime);
    const encryptor = new EvidenceEnvelopeEncryptor({
      kms,
      audit: store,
      clock: { now: () => FROZEN },
    });
    const builder = new EvidenceCapsuleBuilder(encryptor);
    const profile = await kms.encryptionProfile(scopeFor("case-1"));

    const screenshotBytes = new Uint8Array(
      await readFile(join(evidence!.artifactDir, "screenshot.png")),
    );
    const graphBytes = new Uint8Array(
      await readFile(join(evidence!.artifactDir, "graph.json")),
    );
    const items = [
      { kind: "screenshot" as const, mediaType: "image/png" as const, bytes: screenshotBytes, entryId: "entry-shot" },
      { kind: "semantic_graph" as const, mediaType: "application/json" as const, bytes: graphBytes, entryId: "entry-graph" },
    ];
    const entries: EvidenceCapsuleEntry[] = items.map((item) => encodeCapsuleEntry(item));

    const built = await builder.build({
      disposition: "remote",
      runId: finding.runId,
      profile,
      items,
      context: {
        actorType: "service",
        actorId: "runner-1",
        correlationId: "corr-1",
        capsuleId: "capsule-1",
      },
    });
    expect(built.disposition).toBe("remote_capsule");
    if (built.disposition !== "remote_capsule") {
      throw new Error("expected remote capsule");
    }
    await store.saveRemoteCapsule({
      profile,
      manifest: built.manifest,
      ciphertext: built.ciphertext,
      entries,
    });

    // Go offline: close the DB file and DELETE the Runner's local artifacts.
    await runtime.close();
    await rm(artifactRoot, { recursive: true, force: true });

    // Reopen the persisted DB; an operator with only the DB + KMS restores bytes.
    const reopened = await SqliteRuntime.open({ filename: dbPath, busyTimeoutMs: 5_000 });
    runtime = reopened;
    const offlineStore = new SqliteEvidenceCapsuleStore(reopened);
    const stored = await offlineStore.loadCapsule("capsule-1");
    expect(stored?.ciphertextPresent).toBe(true);

    const offlineDecryptor = new EvidenceEnvelopeEncryptor({
      kms,
      audit: offlineStore,
      clock: { now: () => FROZEN },
    });
    const recovered = await offlineDecryptor.decrypt(
      stored!.encrypted,
      authorizedContext(profile),
    );
    expect(recovered.schemaVersion).toBe("evidence-capsule/v1");

    const recoveredShot = recovered.entries.find((e) => e.kind === "screenshot");
    const recoveredGraph = recovered.entries.find((e) => e.kind === "semantic_graph");
    expect(recoveredShot).toBeDefined();
    // Byte-for-byte equality after encrypt -> persist -> reopen -> decrypt.
    expect(Array.from(decodeCapsuleEntry(recoveredShot!))).toEqual(
      Array.from(screenshotBytes),
    );
    expect(Array.from(decodeCapsuleEntry(recoveredGraph!))).toEqual(
      Array.from(graphBytes),
    );
    expect(screenshotBytes.byteLength).toBeGreaterThan(0);
  });

  it("enforces revoke-before-delete on the persisted Capsule", async () => {
    fixture = await startFixtureServer({ "/": BUGGY_CART });
    const store = new SqliteEvidenceCapsuleStore(runtime);
    const encryptor = new EvidenceEnvelopeEncryptor({
      kms,
      audit: store,
      clock: { now: () => FROZEN },
    });
    const builder = new EvidenceCapsuleBuilder(encryptor);
    const profile = await kms.encryptionProfile(scopeFor("case-1"));
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const items = [
      { kind: "log_summary" as const, mediaType: "text/plain" as const, bytes, entryId: "entry-log" },
    ];
    const built = await builder.build({
      disposition: "remote",
      runId: "run-1",
      profile,
      items,
      context: { actorType: "service", actorId: "runner-1", correlationId: "c", capsuleId: "capsule-1" },
    });
    if (built.disposition !== "remote_capsule") throw new Error("expected remote");
    await store.saveRemoteCapsule({
      profile,
      manifest: built.manifest,
      ciphertext: built.ciphertext,
      entries: items.map((i) => encodeCapsuleEntry(i)),
    });

    // Delete without revoke is rejected.
    await expect(
      store.deleteCiphertext({
        capsuleId: "capsule-1",
        actor: { actorType: "service", actorId: "expiry", correlationId: "c" },
      }),
    ).rejects.toBeInstanceOf(EvidenceLifecycleError);
    expect((await store.loadCapsule("capsule-1"))?.ciphertextPresent).toBe(true);

    // Expiry revokes first, then deletes; a revoked Capsule is undecryptable.
    await store.expireCapsule({
      capsuleId: "capsule-1",
      reason: "ttl_expired",
      kms,
      actor: { actorType: "service", actorId: "expiry", correlationId: "c" },
    });
    const revoked = await store.loadCapsule("capsule-1");
    expect(revoked?.revocationState).toBe("revoked");
    expect(revoked?.ciphertextPresent).toBe(false);

    await expect(
      encryptor.decrypt(built, authorizedContext(profile)),
    ).rejects.toMatchObject({ code: "EvidenceKeyRevoked" });
  });

  it("routes a non-reproducing Finding to a persisted Human Review Task", async () => {
    fixture = await startFixtureServer({ "/": CORRECT_CART });
    const artifactRoot = join(dir, "artifacts");
    const runner = new PlaywrightReproductionRunner(fixture.url, fixture.origin, artifactRoot);
    const smallBudget: InvestigationBudget = { ...budget, maximumReproductionAttempts: 1 };
    const coordinator = new InvestigationCoordinator(scriptedAgent, runner, config, newId);

    const outcome: InvestigationOutcome = await coordinator.investigate({
      caseId: "case-2",
      findingId: "finding-2",
      projectId: "proj-1",
      budget: smallBudget,
      inputRefs: ["evidence-1"],
    });
    expect(outcome.status).toBe("needs_human");
    const handoff = outcome.handoff;
    expect(handoff).toBeDefined();

    const reviewStore = new SqliteReviewStore(runtime);
    const task: ReviewTask = openReviewTask({
      taskId: "review-2",
      caseId: outcome.caseId,
      reason: handoff?.limitationCodes[0] ?? "needs_human",
      priority: "high",
      // No Capsule was prestaged for a non-reproduction: evidence is limited.
      evidenceCompleteness: "limited",
    });
    await reviewStore.create("local", task);

    const persisted = await reviewStore.find("local", "review-2");
    expect(persisted).toMatchObject({
      status: "open",
      caseId: "case-2",
      evidenceCompleteness: "limited",
    });

    // No remote Capsule upload exists for a non-reproduction.
    const capsuleStore = new SqliteEvidenceCapsuleStore(runtime);
    expect(await capsuleStore.listRemoteUploads("case-2")).toEqual([]);
  });
});

import {
  InvestigationCase,
  investigationError,
  type BugEpisode,
  type HumanHandoff,
  type InvestigationBudget,
  type InvestigationBudgetUsage,
  type InvestigationStatus,
  type ReproductionAttempt,
} from "@qualigence/investigation";
import type { SqliteRuntime } from "./database.js";
import { runInImmediateTransaction } from "./transaction.js";

/**
 * SQLite-backed persistence for the LS-10 Investigation aggregate. A case is
 * stored as a single snapshot row carrying its optimistic-concurrency `version`;
 * Reproduction Attempts, the terminal Bug Episode and the Human Handoff are
 * append-only. {@link save} is a single-writer optimistic-concurrency write: a
 * stale `expectedVersion` raises `InvestigationVersionConflict` rather than
 * overwriting a newer state, so a lagging writer can never clobber the aggregate.
 */
export class SqliteInvestigationStore {
  constructor(private readonly runtime: SqliteRuntime) {}

  /**
   * Persist the current aggregate state under optimistic concurrency.
   * `expectedVersion` is the version the caller last observed (0 for a case that
   * has never been persisted). The write is rejected if the stored version has
   * advanced past it.
   */
  async save(
    investigation: InvestigationCase,
    expectedVersion: number,
  ): Promise<void> {
    await runInImmediateTransaction(this.runtime, async () => {
      const db = this.runtime.db;
      const head = await db
        .selectFrom("investigation_cases")
        .select(["version"])
        .where("case_id", "=", investigation.caseId)
        .executeTakeFirst();
      const storedVersion = head?.version ?? 0;
      if (storedVersion !== expectedVersion) {
        throw investigationError(
          "InvestigationVersionConflict",
          `Investigation ${investigation.caseId} expected version ${String(expectedVersion)} but stored version is ${String(storedVersion)}.`,
        );
      }

      const now = new Date().toISOString();
      const episode = investigation.bugEpisode();
      const budgetJson = JSON.stringify(investigation.budget());
      const usageJson = JSON.stringify(investigation.usage());

      if (head === undefined) {
        await db
          .insertInto("investigation_cases")
          .values({
            case_id: investigation.caseId,
            finding_id: investigation.findingId,
            project_id: investigation.projectId,
            status: investigation.status(),
            version: investigation.currentVersion(),
            plan_revision: investigation.planRevision(),
            budget_json: budgetJson,
            usage_json: usageJson,
            bug_episode_id: episode?.episodeId ?? null,
            created_at: now,
            updated_at: now,
          })
          .execute();
      } else {
        await db
          .updateTable("investigation_cases")
          .set({
            status: investigation.status(),
            version: investigation.currentVersion(),
            plan_revision: investigation.planRevision(),
            budget_json: budgetJson,
            usage_json: usageJson,
            bug_episode_id: episode?.episodeId ?? null,
            updated_at: now,
          })
          .where("case_id", "=", investigation.caseId)
          .execute();
      }

      for (const attempt of investigation.reproductionAttempts()) {
        await db
          .insertInto("investigation_attempts")
          .values({
            attempt_id: attempt.attemptId,
            case_id: attempt.caseId,
            ordinal: attempt.ordinal,
            plan_revision: attempt.planRevision,
            outcome: attempt.outcome,
            attempt_json: JSON.stringify(attempt),
            created_at: now,
          })
          .onConflict((oc) => oc.column("attempt_id").doNothing())
          .execute();
      }

      if (episode !== undefined) {
        await db
          .insertInto("investigation_bug_episodes")
          .values({
            episode_id: episode.episodeId,
            case_id: episode.caseId,
            finding_id: episode.findingId,
            confidence: episode.confidence,
            episode_json: JSON.stringify(episode),
            created_at: now,
          })
          .onConflict((oc) => oc.column("episode_id").doNothing())
          .execute();
      }

      const handoff = investigation.handoff();
      if (handoff !== undefined) {
        await db
          .insertInto("investigation_handoffs")
          .values({
            case_id: handoff.caseId,
            handoff_json: JSON.stringify(handoff),
            created_at: now,
          })
          .onConflict((oc) => oc.column("case_id").doNothing())
          .execute();
      }
    });
  }

  /** Rehydrate a persisted case with its append-only attempts and terminals. */
  async load(caseId: string): Promise<InvestigationCase | undefined> {
    const db = this.runtime.db;
    const head = await db
      .selectFrom("investigation_cases")
      .selectAll()
      .where("case_id", "=", caseId)
      .executeTakeFirst();
    if (head === undefined) {
      return undefined;
    }

    const attemptRows = await db
      .selectFrom("investigation_attempts")
      .select("attempt_json")
      .where("case_id", "=", caseId)
      .orderBy("ordinal", "asc")
      .execute();
    const attempts = attemptRows.map(
      (row) => JSON.parse(row.attempt_json) as ReproductionAttempt,
    );

    const episodeRow =
      head.bug_episode_id === null
        ? undefined
        : await db
            .selectFrom("investigation_bug_episodes")
            .select("episode_json")
            .where("episode_id", "=", head.bug_episode_id)
            .executeTakeFirst();
    const bugEpisode =
      episodeRow === undefined
        ? undefined
        : (JSON.parse(episodeRow.episode_json) as BugEpisode);

    const handoffRow = await db
      .selectFrom("investigation_handoffs")
      .select("handoff_json")
      .where("case_id", "=", caseId)
      .executeTakeFirst();
    const handoff =
      handoffRow === undefined
        ? undefined
        : (JSON.parse(handoffRow.handoff_json) as HumanHandoff);

    return InvestigationCase.restore({
      caseId: head.case_id,
      findingId: head.finding_id,
      projectId: head.project_id,
      budget: JSON.parse(head.budget_json) as InvestigationBudget,
      usage: JSON.parse(head.usage_json) as InvestigationBudgetUsage,
      version: head.version,
      status: head.status as InvestigationStatus,
      planRevision: head.plan_revision,
      attempts,
      ...(bugEpisode === undefined ? {} : { bugEpisode }),
      ...(handoff === undefined ? {} : { handoff }),
    });
  }
}

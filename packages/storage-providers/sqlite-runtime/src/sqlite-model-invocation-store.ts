import type {
  ModelInvocationStore,
  ModelInvocationSummary,
} from "@qualigence/evidence";
import type { RunId } from "@qualigence/runner-protocol";
import type { SqliteRuntime } from "./database.js";
import { runInImmediateTransaction } from "./transaction.js";

export class SqliteModelInvocationStore implements ModelInvocationStore {
  constructor(private readonly runtime: SqliteRuntime) {}

  async append(summary: ModelInvocationSummary): Promise<void> {
    await runInImmediateTransaction(this.runtime, async () => {
      const db = this.runtime.db;
      const existing = await db
        .selectFrom("model_invocations")
        .select("invocation_id")
        .where("invocation_id", "=", summary.invocationId)
        .executeTakeFirst();

      if (existing) {
        return;
      }

      await db
        .insertInto("model_invocations")
        .values({
          invocation_id: summary.invocationId,
          run_id: summary.runId,
          operation: summary.operation,
          model: summary.model,
          status: summary.status,
          latency_ms: summary.latencyMs,
          input_tokens: summary.inputTokens ?? null,
          output_tokens: summary.outputTokens ?? null,
          provider_request_id: summary.providerRequestId ?? null,
          error_code: summary.errorCode ?? null,
          occurred_at: summary.occurredAt,
        })
        .execute();
    });
  }

  async listForRun(
    runId: RunId,
  ): Promise<readonly ModelInvocationSummary[]> {
    const rows = await this.runtime.db
      .selectFrom("model_invocations")
      .selectAll()
      .where("run_id", "=", runId)
      .orderBy("occurred_at", "asc")
      .orderBy("invocation_id", "asc")
      .execute();

    return rows.map((row) => ({
      invocationId: row.invocation_id,
      runId: row.run_id,
      operation: row.operation,
      model: row.model,
      status: row.status as "succeeded" | "failed",
      latencyMs: row.latency_ms,
      occurredAt: row.occurred_at,
      ...(row.input_tokens !== null ? { inputTokens: row.input_tokens } : {}),
      ...(row.output_tokens !== null
        ? { outputTokens: row.output_tokens }
        : {}),
      ...(row.provider_request_id !== null
        ? { providerRequestId: row.provider_request_id }
        : {}),
      ...(row.error_code !== null ? { errorCode: row.error_code } : {}),
    }));
  }
}

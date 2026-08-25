import type { Kysely, SqlBool } from "kysely";
import { sql } from "kysely";
import type { Migration } from "../migrations.js";
import type { Database } from "../schema.js";

/**
 * Migration 012: durable Intelligence Worker leases and Result inbox metadata.
 * The migration is additive: the historical `intelligence_results` table remains
 * for pre-012 compatibility only, while `intelligence_result_inbox` is the
 * Server-consumed proposal inbox and records the lease/worker/attempt/base-version
 * fence that authorized each accepted Result.
 */
export const migration012: Migration = {
  version: 12,
  name: "intelligence-leases-results",
  async up(db: Kysely<Database>) {
    await db.schema
      .createTable("intelligence_leases")
      .addColumn("tenant_id", "text", (column) => column.notNull())
      .addColumn("job_id", "text", (column) =>
        column.notNull().references("intelligence_jobs.job_id"),
      )
      .addColumn("attempt", "integer", (column) => column.notNull())
      .addColumn("worker_id", "text", (column) => column.notNull())
      .addColumn("lease_token_hash", "text", (column) => column.notNull())
      .addColumn("lease_started_at", "text", (column) => column.notNull())
      .addColumn("expires_at", "text", (column) => column.notNull())
      .addColumn("last_renewed_at", "text")
      .addColumn("renewal_count", "integer", (column) => column.notNull())
      .addColumn("released_at", "text")
      .addColumn("completed_at", "text")
      .addPrimaryKeyConstraint("intelligence_leases_pk", [
        "tenant_id",
        "job_id",
        "attempt",
      ])
      .addCheckConstraint(
        "intelligence_leases_attempt_check",
        sql`attempt >= 1`,
      )
      .addCheckConstraint(
        "intelligence_leases_renewal_count_check",
        sql`renewal_count >= 0`,
      )
      .execute();

    await db.schema
      .createIndex("intelligence_leases_live_unique")
      .on("intelligence_leases")
      .columns(["tenant_id", "job_id"])
      .where(sql<SqlBool>`released_at IS NULL AND completed_at IS NULL`)
      .unique()
      .execute();

    await db.schema
      .createTable("intelligence_result_inbox")
      .addColumn("tenant_id", "text", (column) => column.notNull())
      .addColumn("idempotency_key", "text", (column) => column.notNull())
      .addColumn("job_id", "text", (column) =>
        column.notNull().references("intelligence_jobs.job_id"),
      )
      .addColumn("worker_id", "text", (column) => column.notNull())
      .addColumn("lease_attempt", "integer", (column) => column.notNull())
      .addColumn("lease_token_hash", "text", (column) => column.notNull())
      .addColumn("lease_expires_at", "text", (column) => column.notNull())
      .addColumn("base_aggregate_version", "integer", (column) =>
        column.notNull(),
      )
      .addColumn("result_hash", "text", (column) => column.notNull())
      .addColumn("result_json", "text", (column) => column.notNull())
      .addColumn("accepted_at", "text", (column) => column.notNull())
      .addPrimaryKeyConstraint("intelligence_result_inbox_pk", [
        "tenant_id",
        "idempotency_key",
      ])
      .addForeignKeyConstraint(
        "intelligence_result_inbox_lease_fk",
        ["tenant_id", "job_id", "lease_attempt"],
        "intelligence_leases",
        ["tenant_id", "job_id", "attempt"],
      )
      .addCheckConstraint(
        "intelligence_result_inbox_lease_attempt_check",
        sql`lease_attempt >= 1`,
      )
      .execute();
  },
};

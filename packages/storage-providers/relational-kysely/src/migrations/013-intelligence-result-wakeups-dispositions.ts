import type { Kysely, SqlBool } from "kysely";
import { sql } from "kysely";
import type { Migration } from "../migrations.js";
import type { Database } from "../schema.js";

/**
 * Migration 013: payload-free tenant wakeups and durable Server-side Result
 * dispositions. Wakeups intentionally carry only tenant-level scheduling state;
 * Result authority remains in the validated inbox rows from migration 012.
 */
export const migration013: Migration = {
  version: 13,
  name: "intelligence-result-wakeups-dispositions",
  async up(db: Kysely<Database>) {
    await db.schema
      .createTable("intelligence_result_wakeups")
      .addColumn("tenant_id", "text", (column) => column.primaryKey().notNull())
      .addColumn("generation", "integer", (column) => column.notNull())
      .addColumn("status", "text", (column) => column.notNull())
      .addColumn("available_at", "text", (column) => column.notNull())
      .addColumn("lease_owner", "text")
      .addColumn("lease_generation", "integer")
      .addColumn("lease_expires_at", "text")
      .addColumn("last_claimed_at", "text")
      .addColumn("last_completed_at", "text")
      .addColumn("failure_count", "integer", (column) => column.notNull())
      .addColumn("last_error", "text")
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("updated_at", "text", (column) => column.notNull())
      .addCheckConstraint(
        "intelligence_result_wakeups_generation_check",
        sql`generation >= 0`,
      )
      .addCheckConstraint(
        "intelligence_result_wakeups_status_check",
        sql`status IN ('pending', 'idle')`,
      )
      .addCheckConstraint(
        "intelligence_result_wakeups_failure_count_check",
        sql`failure_count >= 0`,
      )
      .execute();

    await db.schema
      .createIndex("intelligence_result_wakeups_due")
      .on("intelligence_result_wakeups")
      .columns(["status", "available_at", "tenant_id"])
      .where(sql<SqlBool>`status = 'pending'`)
      .execute();

    await sql`
      insert into intelligence_result_wakeups
        (tenant_id, generation, status, available_at, lease_owner, lease_generation,
         lease_expires_at, last_claimed_at, last_completed_at, failure_count, last_error,
         created_at, updated_at)
      select tenant_id, cast(count(*) as integer), 'pending', min(accepted_at), null, null,
             null, null, null, 0, null, min(accepted_at), min(accepted_at)
        from intelligence_result_inbox
       group by tenant_id
    `.execute(db);

    await db.schema
      .createTable("intelligence_result_dispositions")
      .addColumn("tenant_id", "text", (column) => column.notNull())
      .addColumn("idempotency_key", "text", (column) => column.notNull())
      .addColumn("job_id", "text", (column) => column.notNull())
      .addColumn("result_hash", "text", (column) => column.notNull())
      .addColumn("status", "text", (column) => column.notNull())
      .addColumn("code", "text")
      .addColumn("reason", "text")
      .addColumn("aggregate_type", "text")
      .addColumn("aggregate_id", "text")
      .addColumn("new_version", "integer")
      .addColumn("summary", "text")
      .addColumn("created_at", "text", (column) => column.notNull())
      .addPrimaryKeyConstraint("intelligence_result_dispositions_pk", [
        "tenant_id",
        "idempotency_key",
      ])
      .addForeignKeyConstraint(
        "intelligence_result_dispositions_inbox_fk",
        ["tenant_id", "idempotency_key"],
        "intelligence_result_inbox",
        ["tenant_id", "idempotency_key"],
      )
      .addCheckConstraint(
        "intelligence_result_dispositions_status_check",
        sql`status IN ('applied', 'duplicate', 'rejected', 'recompute')`,
      )
      .execute();
  },
};

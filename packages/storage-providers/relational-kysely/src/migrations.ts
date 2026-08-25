import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Database } from "./schema.js";
import { migration002 } from "./migrations/002-prd-mission.js";
import { migration003 } from "./migrations/003-skill.js";
import { migration004 } from "./migrations/004-exploration-benchmark.js";
import { migration005 } from "./migrations/005-investigation-review.js";
import { migration006 } from "./migrations/006-runner-control.js";
import { migration007 } from "./migrations/007-local-run-intake.js";
import { migration008 } from "./migrations/008-target-test-plan.js";
import { migration009 } from "./migrations/009-mission-scheduling.js";
import { migration010 } from "./migrations/010-skill-lifecycle-commands.js";
import { migration011 } from "./migrations/011-exploration-attempt-progress.js";
import { migration012 } from "./migrations/012-intelligence-leases-results.js";
import { migration013 } from "./migrations/013-intelligence-result-wakeups-dispositions.js";

export const SUPPORTED_SCHEMA_VERSION = 13;

export interface Migration {
  readonly version: number;
  readonly name: string;
  up(db: Kysely<Database>): Promise<void>;
}

const migration001: Migration = {
  version: 1,
  name: "initial-schema",
  async up(db) {
    await db.schema
      .createTable("schema_migrations")
      .addColumn("version", "integer", (column) => column.primaryKey().notNull())
      .addColumn("name", "text", (column) => column.notNull().unique())
      .addColumn("applied_at", "text", (column) => column.notNull())
      .execute();

    await db.schema
      .createTable("execution_runs")
      .addColumn("run_id", "text", (column) => column.primaryKey().notNull())
      .addColumn("job_id", "text", (column) => column.notNull())
      .addColumn("target_kind", "text", (column) => column.notNull())
      .addColumn("objective", "text", (column) => column.notNull())
      .addColumn("status", "text", (column) => column.notNull())
      .addColumn("next_sequence_number", "integer", (column) =>
        column.notNull(),
      )
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("completed_at", "text")
      .addColumn("error_code", "text")
      .addCheckConstraint(
        "execution_runs_status_check",
        sql`status IN ('running', 'passed', 'finding', 'blocked', 'error')`,
      )
      .addCheckConstraint(
        "execution_runs_target_kind_check",
        sql`target_kind IN ('web', 'app')`,
      )
      .execute();

    await db.schema
      .createTable("trace_events")
      .addColumn("run_id", "text", (column) =>
        column.notNull().references("execution_runs.run_id"),
      )
      .addColumn("sequence_number", "integer", (column) => column.notNull())
      .addColumn("message_id", "text", (column) => column.notNull().unique())
      .addColumn("idempotency_key", "text", (column) =>
        column.notNull().unique(),
      )
      .addColumn("stage", "text", (column) => column.notNull())
      .addColumn("occurred_at", "text", (column) => column.notNull())
      .addColumn("payload_hash", "text", (column) => column.notNull())
      .addColumn("envelope_json", "text", (column) => column.notNull())
      .addPrimaryKeyConstraint("trace_events_pk", [
        "run_id",
        "sequence_number",
      ])
      .execute();

    await db.schema
      .createTable("findings")
      .addColumn("finding_id", "text", (column) =>
        column.primaryKey().notNull(),
      )
      .addColumn("run_id", "text", (column) =>
        column.notNull().references("execution_runs.run_id"),
      )
      .addColumn("payload_hash", "text", (column) => column.notNull())
      .addColumn("envelope_json", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .execute();

    await db.schema
      .createTable("artifact_manifests")
      .addColumn("artifact_id", "text", (column) =>
        column.primaryKey().notNull(),
      )
      .addColumn("run_id", "text", (column) =>
        column.notNull().references("execution_runs.run_id"),
      )
      .addColumn("kind", "text", (column) => column.notNull())
      .addColumn("media_type", "text", (column) => column.notNull())
      .addColumn("relative_path", "text", (column) =>
        column.notNull().unique(),
      )
      .addColumn("sha256", "text", (column) => column.notNull())
      .addColumn("size_bytes", "integer", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .execute();

    await db.schema
      .createTable("model_invocations")
      .addColumn("invocation_id", "text", (column) =>
        column.primaryKey().notNull(),
      )
      .addColumn("run_id", "text", (column) =>
        column.notNull().references("execution_runs.run_id"),
      )
      .addColumn("operation", "text", (column) => column.notNull())
      .addColumn("model", "text", (column) => column.notNull())
      .addColumn("status", "text", (column) => column.notNull())
      .addColumn("latency_ms", "integer", (column) => column.notNull())
      .addColumn("input_tokens", "integer")
      .addColumn("output_tokens", "integer")
      .addColumn("provider_request_id", "text")
      .addColumn("error_code", "text")
      .addColumn("occurred_at", "text", (column) => column.notNull())
      .addCheckConstraint(
        "model_invocations_status_check",
        sql`status IN ('succeeded', 'failed')`,
      )
      .execute();
  },
};

export const MIGRATIONS: readonly Migration[] = [
  migration001,
  migration002,
  migration003,
  migration004,
  migration005,
  migration006,
  migration007,
  migration008,
  migration009,
  migration010,
  migration011,
  migration012,
  migration013,
];

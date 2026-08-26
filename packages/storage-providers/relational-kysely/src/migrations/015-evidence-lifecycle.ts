import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Migration } from "../migrations.js";
import type { Database } from "../schema.js";

/** Migration 015: explicit Evidence lifecycle state machine metadata. */
export const migration015: Migration = {
  version: 15,
  name: "evidence-lifecycle",
  async up(db: Kysely<Database>) {
    await sql`
      alter table evidence_capsule_manifests
      add column lifecycle_state text not null default 'active'
      check (lifecycle_state in ('active', 'revoking', 'revoked', 'deleting', 'deleted'))
    `.execute(db);
    await sql`
      alter table evidence_capsule_manifests
      add column lifecycle_updated_at text
    `.execute(db);
    await sql`
      alter table evidence_capsule_manifests
      add column deleted_at text
    `.execute(db);
    await sql`
      alter table evidence_capsule_manifests
      add column last_lifecycle_error text
    `.execute(db);
    await sql`
      update evidence_capsule_manifests
      set lifecycle_state = revocation_state,
          lifecycle_updated_at = coalesce(revoked_at, created_at)
      where lifecycle_state = 'active'
    `.execute(db);
  },
};

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
    await sql`
      create table self_hosted_kms_key_versions (
        tenant_id text not null,
        scope_id text not null,
        key_id text not null,
        revision integer not null,
        public_key_pem text not null,
        wrapped_private_key_base64 text not null,
        private_key_nonce_base64 text not null,
        private_key_tag_base64 text not null,
        status text not null check (status in ('active', 'revoked')),
        created_at text not null,
        is_primary integer not null check (is_primary in (0, 1)),
        primary key (tenant_id, scope_id, key_id),
        unique (tenant_id, scope_id, revision)
      )
    `.execute(db);
    await sql`
      create table self_hosted_kms_capsule_revocations (
        tenant_id text not null,
        capsule_id text not null,
        scope_id text not null,
        reason text not null,
        revoked_at text not null,
        primary key (tenant_id, capsule_id)
      )
    `.execute(db);
  },
};

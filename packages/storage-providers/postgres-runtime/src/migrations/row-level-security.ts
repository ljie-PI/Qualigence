import { type Kysely, sql } from "kysely";
import {
  RELATIONAL_TABLES,
  TENANT_OWNED_TABLES,
  WORKER_ACCESSIBLE_TABLES,
} from "@qualigence/relational-kysely";

/** Names of the least-privilege runtime roles the RLS layer provisions. */
export interface PostgresRuntimeRoles {
  /** Application role: non-owner, no BYPASSRLS, tenant-isolated. */
  readonly server: string;
  /** Worker role: may only lease/append the Intelligence Job tables. */
  readonly worker: string;
}

const SIMPLE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function assertIdentifier(value: string, label: string): void {
  if (!SIMPLE_IDENTIFIER.test(value)) {
    throw new Error(`Unsafe ${label}: ${JSON.stringify(value)}`);
  }
}

/**
 * Enforce tenant isolation at the database level. Every tenant-owned table has
 * RLS enabled AND forced, with a policy that only exposes rows whose
 * `tenant_id` matches the request-scoped `app.tenant_id` GUC. A missing tenant
 * context resolves to NULL and therefore returns zero rows / rejects writes —
 * it can never be caught and bypassed in application code.
 *
 * The Worker role is granted exclusively on the Intelligence Job lease/Result
 * functions so it can lease jobs across tenants and submit proposals without
 * direct write authority over Server-consumed Result rows, aggregate, evidence
 * or review data.
 */
export async function applyRowLevelSecurity(
  db: Kysely<any>,
  roles: PostgresRuntimeRoles,
  tableNames?: readonly string[],
): Promise<void> {
  assertIdentifier(roles.server, "server role");
  assertIdentifier(roles.worker, "worker role");
  const serverRole = sql.ref(roles.server);
  const workerRole = sql.ref(roles.worker);

  await sql`revoke create on schema public from public, ${serverRole}, ${workerRole}`.execute(db);
  await sql`grant usage on schema public to ${serverRole}, ${workerRole}`.execute(
    db,
  );
  await sql`revoke all on table ${sql.table("schema_migrations")} from public, ${serverRole}, ${workerRole}`.execute(db);
  await sql`revoke all on table ${sql.table("schema_components")} from public, ${serverRole}, ${workerRole}`.execute(db);
  await sql`grant select on table ${sql.table("schema_migrations")} to ${serverRole}, ${workerRole}`.execute(
    db,
  );
  await sql`grant select on table ${sql.table("schema_components")} to ${serverRole}, ${workerRole}`.execute(db);
  await sql`revoke all on all functions in schema public from public, ${serverRole}, ${workerRole}`.execute(db);

  const selected = tableNames === undefined ? undefined : new Set(tableNames);
  const hasTable = (table: string): boolean => selected === undefined || selected.has(table);
  for (const table of TENANT_OWNED_TABLES) {
    if (selected !== undefined && !selected.has(table.name)) continue;
    const ref = sql.table(table.name);
    await sql`alter table ${ref} enable row level security`.execute(db);
    await sql`alter table ${ref} force row level security`.execute(db);

    await sql`drop policy if exists tenant_isolation on ${ref}`.execute(db);
    await sql`
      create policy tenant_isolation on ${ref}
        to ${serverRole}
        using (tenant_id = current_setting('app.tenant_id', true))
        with check (tenant_id = current_setting('app.tenant_id', true))
    `.execute(db);

    await sql`revoke all on table ${ref} from public, ${serverRole}, ${workerRole}`.execute(db);
    await sql`grant select, insert, update, delete on table ${ref} to ${serverRole}`.execute(
      db,
    );
  }

  for (const table of WORKER_ACCESSIBLE_TABLES) {
    if (selected !== undefined && !selected.has(table.name)) continue;
    const ref = sql.table(table.name);
    await sql`drop policy if exists worker_access on ${ref}`.execute(db);
    await sql`
      create policy worker_access on ${ref}
        to ${workerRole}
        using (true)
        with check (true)
    `.execute(db);
  }

  if (hasTable("intelligence_jobs")) {
    await sql`drop policy if exists worker_access on ${sql.table("intelligence_jobs")}`.execute(db);
    await sql`revoke all on table ${sql.table("intelligence_jobs")} from ${workerRole}`.execute(db);
    await sql`drop function if exists public.worker_lock_intelligence_job(text[])`.execute(db);
    await sql`drop function if exists public.worker_lock_intelligence_job(text[], text)`.execute(db);
  }

  if (hasTable("intelligence_results")) {
    await sql`revoke all on table ${sql.table("intelligence_results")} from ${workerRole}`.execute(db);
  }
  if (hasTable("intelligence_leases")) {
    await sql`revoke all on table ${sql.table("intelligence_leases")} from ${workerRole}`.execute(db);
  }
  if (hasTable("intelligence_result_inbox")) {
    await sql`revoke all on table ${sql.table("intelligence_result_inbox")} from ${workerRole}`.execute(db);
  }

  if (hasTable("intelligence_jobs") && hasTable("intelligence_leases") && hasTable("intelligence_result_inbox")) {
    await sql`drop function if exists public.worker_claim_intelligence_lease(text[], text, text, text, text)`.execute(db);
    await sql`drop function if exists public.worker_renew_intelligence_lease(text, text, text, text, text)`.execute(db);
    await sql`drop function if exists public.worker_append_intelligence_result(text, text, text, integer, text, integer, text, text, text, text)`.execute(db);
    await sql`drop function if exists public.worker_abandon_intelligence_lease(text, text, text, integer, text, text)`.execute(db);

    await sql`
      create or replace function public.worker_claim_intelligence_lease(
        accepted_types text[],
        input_worker_id text,
        input_lease_token_hash text,
        input_lease_duration_ms integer
      )
      returns table (job_json text, attempt integer, expires_at text)
      language plpgsql
      security definer
      set search_path = pg_catalog
      as $function$
      declare
        checked_at text := to_char(transaction_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
        selected_tenant_id text;
        selected_job_id text;
        selected_job_json text;
        next_attempt integer;
        next_expires_at text := to_char(
          (transaction_timestamp() + (input_lease_duration_ms * interval '1 millisecond')) at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        );
      begin
        select j.tenant_id, j.job_id, j.job_json
          into selected_tenant_id, selected_job_id, selected_job_json
          from public.intelligence_jobs j
         where j.job_type = any(accepted_types)
           and not exists (
             select 1
               from public.intelligence_result_inbox i
              where i.tenant_id = j.tenant_id
                and i.job_id = j.job_id
           )
           and not exists (
             select 1
               from public.intelligence_leases l
              where l.tenant_id = j.tenant_id
                and l.job_id = j.job_id
                and l.released_at is null
                and l.completed_at is null
                and l.expires_at > checked_at
           )
         order by j.created_at asc
         for update of j skip locked
         limit 1;

        if selected_job_id is null then
          return;
        end if;

        update public.intelligence_leases l
           set released_at = checked_at
         where l.tenant_id = selected_tenant_id
           and l.job_id = selected_job_id
           and l.released_at is null
           and l.completed_at is null
           and l.expires_at <= checked_at;

        select (coalesce(max(l.attempt), 0) + 1)::integer
          into next_attempt
          from public.intelligence_leases l
         where l.tenant_id = selected_tenant_id
           and l.job_id = selected_job_id;

        insert into public.intelligence_leases
          (tenant_id, job_id, attempt, worker_id, lease_token_hash, lease_started_at,
           expires_at, last_renewed_at, renewal_count, released_at, completed_at)
        values
          (selected_tenant_id, selected_job_id, next_attempt, input_worker_id,
           input_lease_token_hash, checked_at, next_expires_at, null, 0, null, null);

        job_json := selected_job_json;
        attempt := next_attempt;
        expires_at := next_expires_at;
        return next;
      end
      $function$
    `.execute(db);
    await sql`revoke all on function public.worker_claim_intelligence_lease(text[], text, text, integer) from public`.execute(db);
    await sql`grant execute on function public.worker_claim_intelligence_lease(text[], text, text, integer) to ${workerRole}`.execute(db);

    await sql`
      create or replace function public.worker_renew_intelligence_lease(
        input_job_id text,
        input_worker_id text,
        input_lease_token_hash text,
        input_lease_duration_ms integer
      )
      returns table (status text, attempt integer, expires_at text)
      language plpgsql
      security definer
      set search_path = pg_catalog
      as $function$
      declare
        checked_at text := to_char(transaction_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
        next_expires_at text := to_char(
          (transaction_timestamp() + (input_lease_duration_ms * interval '1 millisecond')) at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        );
        current_lease record;
      begin
        update public.intelligence_leases l
           set expires_at = next_expires_at,
               last_renewed_at = checked_at,
               renewal_count = l.renewal_count + 1
         where l.job_id = input_job_id
           and l.worker_id = input_worker_id
           and l.lease_token_hash = input_lease_token_hash
           and l.released_at is null
           and l.completed_at is null
           and l.expires_at > checked_at
        returning l.attempt, l.expires_at into current_lease;

        if found then
          status := 'renewed';
          attempt := current_lease.attempt;
          expires_at := current_lease.expires_at;
          return next;
          return;
        end if;

        select l.worker_id, l.lease_token_hash, l.expires_at, l.released_at, l.completed_at
          into current_lease
          from public.intelligence_leases l
         where l.job_id = input_job_id
         order by l.attempt desc
         limit 1;

        if not found or current_lease.released_at is not null or current_lease.completed_at is not null then
          status := 'LeaseNotActive';
        elsif current_lease.worker_id <> input_worker_id then
          status := 'WorkerMismatch';
        elsif current_lease.lease_token_hash <> input_lease_token_hash then
          status := 'LeaseTokenMismatch';
        elsif current_lease.expires_at <= checked_at then
          status := 'LeaseExpired';
        else
          status := 'LeaseNotActive';
        end if;
        attempt := null;
        expires_at := null;
        return next;
      end
      $function$
    `.execute(db);
    await sql`revoke all on function public.worker_renew_intelligence_lease(text, text, text, integer) from public`.execute(db);
    await sql`grant execute on function public.worker_renew_intelligence_lease(text, text, text, integer) to ${workerRole}`.execute(db);

    const signalWakeupSql = hasTable("intelligence_result_wakeups")
      ? `
        insert into public.intelligence_result_wakeups
          (tenant_id, generation, status, available_at, lease_owner, lease_generation,
           lease_expires_at, last_claimed_at, last_completed_at, failure_count, last_error,
           created_at, updated_at)
        values
          (input_tenant_id, 1, 'pending', accepted_at, null, null, null, null, null, 0, null,
           accepted_at, accepted_at)
        on conflict (tenant_id) do update
          set generation = public.intelligence_result_wakeups.generation + 1,
              status = 'pending',
              available_at = accepted_at,
              updated_at = accepted_at;
      `
      : "";

    await sql.raw(`
      create or replace function public.worker_append_intelligence_result(
        input_tenant_id text,
        input_job_id text,
        input_worker_id text,
        input_lease_attempt integer,
        input_lease_token_hash text,
        input_base_aggregate_version integer,
        input_idempotency_key text,
        input_result_hash text,
        input_result_json text
      )
      returns table (status text)
      language plpgsql
      security definer
      set search_path = pg_catalog
      as $function$
      declare
        existing_result record;
        job_base_version integer;
        lease_row record;
        inserted_count integer;
        accepted_at text := to_char(transaction_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
      begin
        select i.job_id, i.worker_id, i.lease_attempt, i.lease_token_hash,
               i.base_aggregate_version, i.result_hash, i.result_json
          into existing_result
          from public.intelligence_result_inbox i
         where i.tenant_id = input_tenant_id
           and i.idempotency_key = input_idempotency_key
         limit 1;

        if found then
          if existing_result.job_id = input_job_id
             and existing_result.worker_id = input_worker_id
             and existing_result.lease_attempt = input_lease_attempt
             and existing_result.lease_token_hash = input_lease_token_hash
             and existing_result.base_aggregate_version = input_base_aggregate_version
             and existing_result.result_hash = input_result_hash
             and existing_result.result_json = input_result_json then
            status := 'duplicate';
          else
            status := 'IdempotencyConflict';
          end if;
          return next;
          return;
        end if;

        select j.base_aggregate_version
          into job_base_version
          from public.intelligence_jobs j
         where j.tenant_id = input_tenant_id
           and j.job_id = input_job_id
         limit 1;

        if not found then
          status := 'JobMismatch';
          return next;
          return;
        end if;
        if job_base_version <> input_base_aggregate_version then
          status := 'BaseVersionMismatch';
          return next;
          return;
        end if;

        select l.worker_id, l.lease_token_hash, l.expires_at, l.released_at, l.completed_at
          into lease_row
          from public.intelligence_leases l
         where l.tenant_id = input_tenant_id
           and l.job_id = input_job_id
           and l.attempt = input_lease_attempt
         for update;

        if not found then
          status := 'LeaseNotActive';
          return next;
          return;
        end if;
        if lease_row.worker_id <> input_worker_id then
          status := 'WorkerMismatch';
          return next;
          return;
        end if;
        if lease_row.lease_token_hash <> input_lease_token_hash then
          status := 'LeaseTokenMismatch';
          return next;
          return;
        end if;
        if lease_row.released_at is not null or lease_row.completed_at is not null then
          status := 'LeaseNotActive';
          return next;
          return;
        end if;
        if lease_row.expires_at <= accepted_at then
          status := 'LeaseExpired';
          return next;
          return;
        end if;

        insert into public.intelligence_result_inbox
          (tenant_id, idempotency_key, job_id, worker_id, lease_attempt, lease_token_hash,
           lease_expires_at, base_aggregate_version, result_hash, result_json, accepted_at)
        values
          (input_tenant_id, input_idempotency_key, input_job_id, input_worker_id,
           input_lease_attempt, input_lease_token_hash, lease_row.expires_at,
           input_base_aggregate_version, input_result_hash, input_result_json, accepted_at)
        on conflict (tenant_id, idempotency_key) do nothing;
        get diagnostics inserted_count = row_count;

        if inserted_count = 0 then
          select i.job_id, i.worker_id, i.lease_attempt, i.lease_token_hash,
                 i.base_aggregate_version, i.result_hash, i.result_json
            into existing_result
            from public.intelligence_result_inbox i
           where i.tenant_id = input_tenant_id
             and i.idempotency_key = input_idempotency_key
           limit 1;
          if found
             and existing_result.job_id = input_job_id
             and existing_result.worker_id = input_worker_id
             and existing_result.lease_attempt = input_lease_attempt
             and existing_result.lease_token_hash = input_lease_token_hash
             and existing_result.base_aggregate_version = input_base_aggregate_version
             and existing_result.result_hash = input_result_hash
             and existing_result.result_json = input_result_json then
            status := 'duplicate';
          else
            status := 'IdempotencyConflict';
          end if;
          return next;
          return;
        end if;

        update public.intelligence_leases l
           set completed_at = accepted_at
         where l.tenant_id = input_tenant_id
           and l.job_id = input_job_id
           and l.attempt = input_lease_attempt
           and l.worker_id = input_worker_id
           and l.lease_token_hash = input_lease_token_hash
           and l.released_at is null
           and l.completed_at is null;

        ${signalWakeupSql}

        status := 'accepted';
        return next;
      end
      $function$
    `).execute(db);
    await sql`revoke all on function public.worker_append_intelligence_result(text, text, text, integer, text, integer, text, text, text) from public`.execute(db);
    await sql`grant execute on function public.worker_append_intelligence_result(text, text, text, integer, text, integer, text, text, text) to ${workerRole}`.execute(db);

    await sql`
      create or replace function public.worker_abandon_intelligence_lease(
        input_tenant_id text,
        input_job_id text,
        input_worker_id text,
        input_lease_attempt integer,
        input_lease_token_hash text
      )
      returns table (status text)
      language plpgsql
      security definer
      set search_path = pg_catalog
      as $function$
      declare
        released_at_value text := to_char(transaction_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
      begin
        update public.intelligence_leases l
           set released_at = released_at_value
         where l.tenant_id = input_tenant_id
           and l.job_id = input_job_id
           and l.attempt = input_lease_attempt
           and l.worker_id = input_worker_id
           and l.lease_token_hash = input_lease_token_hash
           and l.released_at is null
           and l.completed_at is null;

        if found then
          status := 'released';
        else
          status := 'not-active';
        end if;
        return next;
      end
      $function$
    `.execute(db);
    await sql`revoke all on function public.worker_abandon_intelligence_lease(text, text, text, integer, text) from public`.execute(db);
    await sql`grant execute on function public.worker_abandon_intelligence_lease(text, text, text, integer, text) to ${workerRole}`.execute(db);

    if (hasTable("intelligence_result_wakeups")) {
      await sql`drop function if exists public.server_claim_intelligence_result_wakeups(text, integer, integer)`.execute(db);
      await sql`drop function if exists public.server_complete_intelligence_result_wakeup(text, integer, text)`.execute(db);
      await sql`drop function if exists public.server_retry_intelligence_result_wakeup(text, integer, text, integer, text)`.execute(db);

      await sql`
        create or replace function public.server_claim_intelligence_result_wakeups(
          input_consumer_id text,
          input_lease_duration_ms integer,
          input_batch_size integer
        )
        returns table (tenant_id text, generation integer, lease_expires_at text)
        language plpgsql
        security definer
        set search_path = pg_catalog
        as $function$
        declare
          checked_at text := to_char(transaction_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
          next_expires_at text := to_char(
            (transaction_timestamp() + (input_lease_duration_ms * interval '1 millisecond')) at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          );
          bounded_batch integer := least(greatest(input_batch_size, 1), 256);
        begin
          return query
          with candidate as (
            select w.tenant_id
              from public.intelligence_result_wakeups w
             where w.status = 'pending'
               and w.available_at <= checked_at
               and (w.lease_owner is null or w.lease_expires_at <= checked_at)
             order by w.available_at asc, w.tenant_id asc
             for update skip locked
             limit bounded_batch
          )
          update public.intelligence_result_wakeups w
             set lease_owner = input_consumer_id,
                 lease_generation = w.generation,
                 lease_expires_at = next_expires_at,
                 last_claimed_at = checked_at,
                 updated_at = checked_at
            from candidate c
           where w.tenant_id = c.tenant_id
          returning w.tenant_id, w.generation, w.lease_expires_at;
        end
        $function$
      `.execute(db);
      await sql`revoke all on function public.server_claim_intelligence_result_wakeups(text, integer, integer) from public`.execute(db);
      await sql`grant execute on function public.server_claim_intelligence_result_wakeups(text, integer, integer) to ${serverRole}`.execute(db);

      await sql`
        create or replace function public.server_complete_intelligence_result_wakeup(
          input_tenant_id text,
          input_generation integer,
          input_consumer_id text
        )
        returns table (status text)
        language plpgsql
        security definer
        set search_path = pg_catalog
        as $function$
        declare
          checked_at text := to_char(transaction_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
          current_generation integer;
        begin
          update public.intelligence_result_wakeups w
             set status = case when w.generation = input_generation then 'idle' else 'pending' end,
                 available_at = checked_at,
                 lease_owner = null,
                 lease_generation = null,
                 lease_expires_at = null,
                 last_completed_at = case when w.generation = input_generation then checked_at else w.last_completed_at end,
                 failure_count = case when w.generation = input_generation then 0 else w.failure_count end,
                 last_error = case when w.generation = input_generation then null else w.last_error end,
                 updated_at = checked_at
           where w.tenant_id = input_tenant_id
             and w.lease_owner = input_consumer_id
             and w.lease_generation = input_generation
          returning w.generation into current_generation;

          if not found then
            status := 'stale';
          elsif current_generation = input_generation then
            status := 'completed';
          else
            status := 'stale-generation';
          end if;
          return next;
        end
        $function$
      `.execute(db);
      await sql`revoke all on function public.server_complete_intelligence_result_wakeup(text, integer, text) from public`.execute(db);
      await sql`grant execute on function public.server_complete_intelligence_result_wakeup(text, integer, text) to ${serverRole}`.execute(db);

      await sql`
        create or replace function public.server_retry_intelligence_result_wakeup(
          input_tenant_id text,
          input_generation integer,
          input_consumer_id text,
          input_retry_after_ms integer,
          input_error text
        )
        returns table (status text)
        language plpgsql
        security definer
        set search_path = pg_catalog
        as $function$
        declare
          checked_at text := to_char(transaction_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
          next_available_at text := to_char(
            (transaction_timestamp() + (input_retry_after_ms * interval '1 millisecond')) at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          );
          current_generation integer;
        begin
          update public.intelligence_result_wakeups w
             set status = 'pending',
                 available_at = case when w.generation = input_generation then next_available_at else checked_at end,
                 lease_owner = null,
                 lease_generation = null,
                 lease_expires_at = null,
                 failure_count = case when w.generation = input_generation then w.failure_count + 1 else w.failure_count end,
                 last_error = case when w.generation = input_generation then left(input_error, 512) else w.last_error end,
                 updated_at = checked_at
           where w.tenant_id = input_tenant_id
             and w.lease_owner = input_consumer_id
             and w.lease_generation = input_generation
          returning w.generation into current_generation;

          if not found then
            status := 'stale';
          elsif current_generation = input_generation then
            status := 'scheduled';
          else
            status := 'stale-generation';
          end if;
          return next;
        end
        $function$
      `.execute(db);
      await sql`revoke all on function public.server_retry_intelligence_result_wakeup(text, integer, text, integer, text) from public`.execute(db);
      await sql`grant execute on function public.server_retry_intelligence_result_wakeup(text, integer, text, integer, text) to ${serverRole}`.execute(db);
    }
  }

  await sql`revoke create on schema public from ${serverRole}, ${workerRole}`.execute(db);
  await sql`revoke create on schema public from public`.execute(db);
}

/** Provision the least-privilege runtime roles. */
export async function createRuntimeRoles(
  db: Kysely<any>,
  input: {
    readonly database: string;
    readonly server: { readonly name: string; readonly password: string };
    readonly worker: { readonly name: string; readonly password: string };
  },
): Promise<void> {
  for (const role of [input.server, input.worker]) {
    assertIdentifier(role.name, "role name");
    if (role.password.includes("'")) {
      throw new Error("Role password must not contain a single quote.");
    }
    const ref = sql.ref(role.name);
    const password = sql.lit(role.password);
    await sql`
      do $role$
      begin
        create role ${ref} login password ${password}
          nosuperuser nobypassrls nocreatedb nocreaterole inherit;
      exception when duplicate_object then
        alter role ${ref} login password ${password}
          nosuperuser nobypassrls nocreatedb nocreaterole inherit;
      end
      $role$
    `.execute(db);
  }
  const dbRef = sql.ref(input.database);
  await sql`revoke temporary on database ${dbRef} from public, ${sql.ref(input.server.name)}, ${sql.ref(input.worker.name)}`.execute(
    db,
  );
  await sql`grant connect on database ${dbRef} to ${sql.ref(input.server.name)}, ${sql.ref(input.worker.name)}`.execute(
    db,
  );
}

/** The list of tables the RLS layer governs, for conformance assertions. */
export function governedTableNames(): readonly string[] {
  return RELATIONAL_TABLES.map((table) => table.name);
}

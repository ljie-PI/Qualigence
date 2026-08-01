import type { Kysely } from "kysely";
import type {
  RunnerEnrollment,
  RunnerEnrollmentStore,
  RunnerPrincipal,
  RunnerPrincipalStore,
} from "@qualigence/runner-identity";
import type { AuxDatabase } from "./aux-schema.js";

/**
 * PostgreSQL-backed {@link RunnerEnrollmentStore} over the `runner_enrollments`
 * aux table. Every operation runs inside the request's tenant-scoped RLS
 * transaction, so an enrollment is only ever visible to its owning tenant. The
 * one-time token is stored only as a hash on the {@link RunnerEnrollment}.
 */
export class PostgresRunnerEnrollmentStore implements RunnerEnrollmentStore {
  constructor(private readonly db: Kysely<AuxDatabase>) {}

  async create(enrollment: RunnerEnrollment): Promise<void> {
    await this.db
      .insertInto("runner_enrollments")
      .values({
        tenant_id: enrollment.tenantId,
        enrollment_id: enrollment.enrollmentId,
        runner_id: enrollment.runnerId,
        project_ids_json: JSON.stringify(enrollment.projectIds),
        token_hash: enrollment.tokenHash,
        expires_at: enrollment.expiresAt,
        consumed_at: enrollment.consumedAt ?? null,
      })
      .execute();
  }

  async findById(enrollmentId: string): Promise<RunnerEnrollment | undefined> {
    const row = await this.db
      .selectFrom("runner_enrollments")
      .selectAll()
      .where("enrollment_id", "=", enrollmentId)
      .executeTakeFirst();
    if (row === undefined) {
      return undefined;
    }
    return {
      enrollmentId: row.enrollment_id,
      tenantId: row.tenant_id,
      runnerId: row.runner_id,
      projectIds: JSON.parse(row.project_ids_json) as string[],
      tokenHash: row.token_hash,
      expiresAt: row.expires_at,
      ...(row.consumed_at !== null ? { consumedAt: row.consumed_at } : {}),
    };
  }

  async consume(enrollmentId: string, consumedAt: string): Promise<boolean> {
    const result = await this.db
      .updateTable("runner_enrollments")
      .set({ consumed_at: consumedAt })
      .where("enrollment_id", "=", enrollmentId)
      .where("consumed_at", "is", null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) === 1;
  }

  async release(enrollmentId: string): Promise<void> {
    await this.db
      .updateTable("runner_enrollments")
      .set({ consumed_at: null })
      .where("enrollment_id", "=", enrollmentId)
      .execute();
  }
}

/**
 * PostgreSQL-backed {@link RunnerPrincipalStore} over the `runner_principals`
 * aux table, keyed by certificate fingerprint within a tenant. Lookups run in
 * the tenant-scoped RLS transaction; the mTLS route derives that tenant from the
 * certificate's SPIFFE SAN before opening the transaction.
 */
export class PostgresRunnerPrincipalStore implements RunnerPrincipalStore {
  constructor(private readonly db: Kysely<AuxDatabase>) {}

  async put(principal: RunnerPrincipal): Promise<void> {
    await this.db
      .insertInto("runner_principals")
      .values({
        tenant_id: principal.tenantId,
        fingerprint_sha256: principal.certificateFingerprintSha256,
        runner_id: principal.runnerId,
        project_ids_json: JSON.stringify(principal.projectIds),
        certificate_uri_san: principal.certificateUriSan,
        enrollment_id: principal.enrollmentId,
        status: principal.status,
        certificate_not_after: principal.certificateNotAfter,
      })
      .onConflict((oc) =>
        oc.columns(["tenant_id", "fingerprint_sha256"]).doUpdateSet({
          runner_id: principal.runnerId,
          project_ids_json: JSON.stringify(principal.projectIds),
          certificate_uri_san: principal.certificateUriSan,
          enrollment_id: principal.enrollmentId,
          status: principal.status,
          certificate_not_after: principal.certificateNotAfter,
        }),
      )
      .execute();
  }

  async findByFingerprint(fingerprintSha256: string): Promise<RunnerPrincipal | undefined> {
    const row = await this.db
      .selectFrom("runner_principals")
      .selectAll()
      .where("fingerprint_sha256", "=", fingerprintSha256)
      .executeTakeFirst();
    return row === undefined ? undefined : this.toPrincipal(row);
  }

  async listByRunner(tenantId: string, runnerId: string): Promise<readonly RunnerPrincipal[]> {
    const rows = await this.db
      .selectFrom("runner_principals")
      .selectAll()
      .where("tenant_id", "=", tenantId)
      .where("runner_id", "=", runnerId)
      .execute();
    return rows.map((row) => this.toPrincipal(row));
  }

  async setStatusForRunner(
    tenantId: string,
    runnerId: string,
    status: RunnerPrincipal["status"],
  ): Promise<readonly RunnerPrincipal[]> {
    await this.db
      .updateTable("runner_principals")
      .set({ status })
      .where("tenant_id", "=", tenantId)
      .where("runner_id", "=", runnerId)
      .execute();
    return this.listByRunner(tenantId, runnerId);
  }

  private toPrincipal(row: {
    tenant_id: string;
    fingerprint_sha256: string;
    runner_id: string;
    project_ids_json: string;
    certificate_uri_san: string;
    enrollment_id: string;
    status: string;
    certificate_not_after: string;
  }): RunnerPrincipal {
    return {
      runnerId: row.runner_id,
      tenantId: row.tenant_id,
      projectIds: JSON.parse(row.project_ids_json) as string[],
      certificateFingerprintSha256: row.fingerprint_sha256,
      certificateUriSan: row.certificate_uri_san,
      enrollmentId: row.enrollment_id,
      status: row.status as RunnerPrincipal["status"],
      certificateNotAfter: row.certificate_not_after,
    };
  }
}

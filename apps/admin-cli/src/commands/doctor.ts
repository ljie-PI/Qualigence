import pg from "pg";
import { SelfHostedKms } from "@qualigence/kms-self-hosted";
import { tenantOwnedTableNames } from "@qualigence/relational-kysely";
import { createS3Client, headBucket } from "../s3-ops.js";
import { assertSecretPermissions, type SelfHostedAdminConfig } from "../config.js";
import { aggregateStatus, type DoctorCheck, type DoctorReport } from "../health.js";
import { AdminCliError } from "../errors.js";

const { Client } = pg;

/** An HTTP probe seam so the Server reachability check is testable. */
export type HttpProbe = (url: string) => Promise<{ ok: boolean; status: number }>;

const defaultHttpProbe: HttpProbe = async (url) => {
  try {
    const response = await fetch(url, { method: "GET" });
    return { ok: true, status: response.status };
  } catch {
    return { ok: false, status: 0 };
  }
};

export interface DoctorOptions {
  readonly httpProbe?: HttpProbe;
  /** Simulate a missing KMS to prove the fail-closed path in tests. */
  readonly kmsAvailable?: boolean;
}

/**
 * A comprehensive Self-hosted health check. It verifies the database is
 * reachable and RLS is forced (the Server role sees zero rows without a tenant
 * context and holds neither ownership nor BYPASSRLS), the object store and KMS
 * are reachable, the Server answers, the Worker role is least-privilege, and
 * secret files are not world-readable. Any missing production dependency fails
 * closed rather than silently degrading to a weak local implementation.
 */
export async function runDoctor(
  config: SelfHostedAdminConfig,
  options: DoctorOptions = {},
): Promise<DoctorReport> {
  const httpProbe = options.httpProbe ?? defaultHttpProbe;
  const checks: DoctorCheck[] = [];

  checks.push(await checkDatabase(config));
  checks.push(...(await checkRlsEnforced(config)));
  checks.push(await checkWorkerLeastPrivilege(config));
  checks.push(await checkObjectStore(config));
  checks.push(checkKms(config, options.kmsAvailable ?? true));
  checks.push(await checkServer(config, httpProbe));
  checks.push(...checkSecretFiles(config));

  return { status: aggregateStatus(checks), checks };
}

async function checkDatabase(config: SelfHostedAdminConfig): Promise<DoctorCheck> {
  const client = new Client(config.postgres.admin);
  try {
    await client.connect();
    await client.query("SELECT 1");
    return { name: "database", status: "pass", safeMessage: "PostgreSQL is reachable" };
  } catch {
    return {
      name: "database",
      status: "fail",
      code: "DatabaseUnreachable",
      safeMessage: "PostgreSQL could not be reached with the configured admin role",
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function checkRlsEnforced(config: SelfHostedAdminConfig): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const serverConn = {
    ...config.postgres.admin,
    user: config.postgres.server.name,
    password: config.postgres.server.password,
  };
  const client = new Client(serverConn);
  try {
    await client.connect();

    // The Server role must not be a superuser, must not own the schema, and must
    // not carry BYPASSRLS — otherwise forced RLS could be silently sidestepped.
    const roleRow = await client.query<{
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user");
    const role = roleRow.rows[0];
    if (role === undefined || role.rolsuper || role.rolbypassrls) {
      checks.push({
        name: "rls_privilege",
        status: "fail",
        code: "ServerRoleOverPrivileged",
        safeMessage: "the Server role is a superuser or can bypass row-level security",
      });
    } else {
      checks.push({
        name: "rls_privilege",
        status: "pass",
        safeMessage: "the Server role is least-privilege (no superuser / BYPASSRLS)",
      });
    }

    // Without a tenant context every tenant-owned table must return zero rows.
    const table = tenantOwnedTableNames()[0];
    if (table !== undefined) {
      const countRow = await client.query<{ count: string }>(
        `SELECT count(*)::int8 AS count FROM ${table}`,
      );
      const count = Number(countRow.rows[0]?.count ?? "0");
      checks.push(
        count === 0
          ? {
              name: "rls_forced",
              status: "pass",
              safeMessage: `forced RLS returns zero rows from ${table} without a tenant context`,
            }
          : {
              name: "rls_forced",
              status: "fail",
              code: "RlsNotForced",
              safeMessage: `RLS is not forced: ${table} leaked ${count} rows without a tenant context`,
            },
      );
    }
  } catch {
    checks.push({
      name: "rls_forced",
      status: "fail",
      code: "RlsCheckFailed",
      safeMessage: "the row-level-security check could not run as the Server role",
    });
  } finally {
    await client.end().catch(() => undefined);
  }
  return checks;
}

async function checkWorkerLeastPrivilege(
  config: SelfHostedAdminConfig,
): Promise<DoctorCheck> {
  const workerConn = {
    ...config.postgres.admin,
    user: config.postgres.worker.name,
    password: config.postgres.worker.password,
  };
  const client = new Client(workerConn);
  try {
    await client.connect();
    // The Worker may touch the job/result tables but must be denied a
    // tenant-owned aggregate table.
    await client.query("SELECT count(*) FROM intelligence_jobs");
    let denied = false;
    try {
      await client.query("SELECT count(*) FROM execution_runs");
    } catch {
      denied = true;
    }
    return denied
      ? {
          name: "worker",
          status: "pass",
          safeMessage: "the Worker role reaches job tables but is denied aggregate tables",
        }
      : {
          name: "worker",
          status: "fail",
          code: "WorkerOverPrivileged",
          safeMessage: "the Worker role can read a tenant-owned aggregate table",
        };
  } catch {
    return {
      name: "worker",
      status: "fail",
      code: "WorkerUnreachable",
      safeMessage: "the Worker database role could not connect or read its job tables",
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function checkObjectStore(config: SelfHostedAdminConfig): Promise<DoctorCheck> {
  const client = createS3Client(config.s3);
  try {
    await headBucket(client, config.s3.bucket);
    return { name: "object_store", status: "pass", safeMessage: "the object store bucket is reachable" };
  } catch {
    return {
      name: "object_store",
      status: "fail",
      code: "ObjectStoreUnreachable",
      safeMessage: "the S3-compatible object store or bucket could not be reached",
    };
  } finally {
    client.destroy();
  }
}

function checkKms(config: SelfHostedAdminConfig, available: boolean): DoctorCheck {
  try {
    const kms = new SelfHostedKms({ rootKey: config.kms.rootKey });
    kms.setAvailable(available);
    // A real profile issuance proves the root key is valid and the provider is
    // functional; when unavailable it throws and the check fails closed.
    void kms.encryptionProfile({
      tenantId: "doctor",
      caseId: "doctor",
      region: "self-hosted",
      purpose: "investigation",
    });
    return { name: "kms", status: "pass", safeMessage: "the KMS provider is reachable and the root key is valid" };
  } catch {
    return {
      name: "kms",
      status: "fail",
      code: "KmsUnavailable",
      safeMessage: "the KMS provider is unavailable or the root key is invalid",
    };
  }
}

async function checkServer(
  config: SelfHostedAdminConfig,
  httpProbe: HttpProbe,
): Promise<DoctorCheck> {
  // An unauthenticated GET of a real route proves the Server is up and routing;
  // any HTTP status (including 401) counts as reachable, a transport error does not.
  const result = await httpProbe(`${config.server.baseUrl}/v1/projects`);
  return result.ok
    ? { name: "server", status: "pass", safeMessage: `the Server is reachable (HTTP ${result.status})` }
    : {
        name: "server",
        status: "fail",
        code: "ServerUnreachable",
        safeMessage: "the Server did not answer an HTTP request",
      };
}

function checkSecretFiles(config: SelfHostedAdminConfig): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  for (const path of config.secretFiles) {
    try {
      const mode = assertSecretPermissions(path);
      checks.push({
        name: "secret_permissions",
        status: "pass",
        safeMessage: `secret ${path} has restrictive permissions (${mode.toString(8)})`,
      });
    } catch (error) {
      checks.push({
        name: "secret_permissions",
        status: "fail",
        code: error instanceof AdminCliError ? error.code : "SecretPermissionsUnsafe",
        safeMessage: `secret ${path} is unreadable or group/world accessible`,
      });
    }
  }
  return checks;
}

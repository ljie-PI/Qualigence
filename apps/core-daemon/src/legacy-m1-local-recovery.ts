import { canonicalPayloadHash, parseExecutionJob, parseExecutionPolicySnapshot } from "@qualigence/runner-protocol";
import type { AcceptedExecutionJob, ExecutionPolicySnapshot } from "@qualigence/runner-protocol";
import type { SqliteRuntime } from "@qualigence/sqlite-runtime";
import { parsePolicylessExecutionJobForRecovery, parseProjectlessExecutionJobForRecovery } from "@qualigence/runner-control";

interface RecoveryManifestRecord {
  readonly jobId: string;
  readonly runId: string;
  readonly canonicalJobSha256: string;
  readonly policy: ExecutionPolicySnapshot;
}

interface RecoveryManifest {
  readonly format: "legacy-m1-local-recovery/v1";
  readonly records: readonly RecoveryManifestRecord[];
}

const verifiedRecoveryBrand: unique symbol = Symbol("verifiedLegacyM1LocalRecovery");

interface VerifiedRecoveryRecord {
  readonly jobId: string;
  readonly runId: string;
  readonly originalJson: string;
  readonly recoveredJob: AcceptedExecutionJob;
}

/** Opaque authority created only after both Local recovery validation phases pass. */
export interface VerifiedLegacyM1LocalRecovery {
  readonly [verifiedRecoveryBrand]: readonly VerifiedRecoveryRecord[];
}

/** Validates the bounded Local-only recovery declaration before SQLite opens. */
export function validateLegacyM1LocalRecoveryCandidate(
  candidate: unknown,
  config: { readonly deploymentMode?: string; readonly host?: string } = {},
): RecoveryManifest {
  if (config.deploymentMode !== "local") throw new Error("Legacy recovery requires Local deployment mode.");
  if (config.host !== "127.0.0.1" && config.host !== "::1") throw new Error("Legacy recovery requires exact loopback host.");
  if (typeof candidate !== "object" || candidate === null) throw new Error("Legacy recovery manifest is malformed.");
  const manifest = candidate as { readonly format?: unknown; readonly records?: unknown };
  if (manifest.format !== "legacy-m1-local-recovery/v1" || !Array.isArray(manifest.records) || manifest.records.length === 0) {
    throw new Error("Legacy recovery manifest format is invalid.");
  }
  const identities = new Set<string>();
  const records = manifest.records.map((record) => validateRecord(record, identities));
  return { format: "legacy-m1-local-recovery/v1", records };
}

export function verifyLegacyM1LocalRecoveryRows(
  manifest: RecoveryManifest,
  rows: ReadonlyMap<string, string>,
): VerifiedLegacyM1LocalRecovery {
  const verified: VerifiedRecoveryRecord[] = [];
  for (const record of manifest.records) {
    const raw = rows.get(`${record.jobId}:${record.runId}`);
    if (raw === undefined) throw new Error("Legacy recovery lease row is missing.");
    let persisted: unknown;
    try {
      persisted = JSON.parse(raw);
    } catch {
      throw new Error("Legacy recovery lease row does not match the manifest.");
    }
    let recoveredJob: AcceptedExecutionJob;
    try {
      const job = parsePolicylessExecutionJobForRecovery(persisted);
      recoveredJob = parseExecutionJob({ ...job, projectId: "local", policy: record.policy });
    } catch {
      try {
        const projectless = parseProjectlessExecutionJobForRecovery(persisted);
        if (canonicalPayloadHash(projectless.policy) !== canonicalPayloadHash(record.policy)) {
          throw new Error("Legacy recovery lease row does not match the manifest.");
        }
        recoveredJob = parseExecutionJob({ ...projectless, projectId: "local" });
      } catch {
        throw new Error("Legacy recovery lease row does not match the manifest.");
      }
    }
    if (recoveredJob.jobId !== record.jobId || recoveredJob.runId !== record.runId || canonicalPayloadHash(persisted) !== record.canonicalJobSha256) {
      throw new Error("Legacy recovery lease row does not match the manifest.");
    }
    if (new URL(recoveredJob.target.url).origin !== record.policy.allowedOrigins[0]) {
      throw new Error("Legacy recovery target origin does not match the manifest policy.");
    }
    verified.push({ jobId: record.jobId, runId: record.runId, originalJson: raw, recoveredJob });
  }
  return { [verifiedRecoveryBrand]: verified };
}

/** Applies every verified Local recovery record before Core composes or binds. */
export async function applyVerifiedLegacyM1LocalRecovery(
  runtime: SqliteRuntime,
  recovery: VerifiedLegacyM1LocalRecovery,
): Promise<void> {
  await runtime.db.transaction().execute(async (db) => {
    for (const record of recovery[verifiedRecoveryBrand]) {
      const result = await db
        .updateTable("execution_leases")
        .set({ job_json: JSON.stringify(record.recoveredJob) })
        .where("run_id", "=", record.runId)
        .where("job_id", "=", record.jobId)
        .where("job_json", "=", record.originalJson)
        .executeTakeFirst();
      if (result.numUpdatedRows !== 1n) {
        throw new Error("Legacy recovery lease row changed before migration.");
      }
    }
  });
}

function validateRecord(value: unknown, identities: Set<string>): RecoveryManifestRecord {
  if (typeof value !== "object" || value === null) throw new Error("Legacy recovery record is malformed.");
  const record = value as Partial<RecoveryManifestRecord>;
  if (typeof record.jobId !== "string" || typeof record.runId !== "string" || typeof record.canonicalJobSha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.canonicalJobSha256) || record.policy === undefined) {
    throw new Error("Legacy recovery record identity is malformed.");
  }
  let policy;
  try {
    policy = parseExecutionPolicySnapshot(record.policy);
  } catch {
    throw new Error("Legacy recovery policy is not constrained.");
  }
  if (
    policy.policyId !== "legacy-m1-local" || policy.environment !== "isolated_test" ||
    policy.allowedActionKinds.length !== 1 || policy.allowedActionKinds[0] !== "click" ||
    policy.maximumRisk !== "Normal" || policy.explorationAllowed || policy.allowedOrigins.length !== 1 ||
    !Number.isFinite(Date.parse(policy.issuedAt)) || !Number.isFinite(Date.parse(policy.expiresAt)) ||
    Date.parse(policy.issuedAt) >= Date.parse(policy.expiresAt)
  ) throw new Error("Legacy recovery policy is not constrained.");
  const origin = new URL(policy.allowedOrigins[0]!);
  if ((origin.protocol !== "http:" && origin.protocol !== "https:") || origin.origin !== policy.allowedOrigins[0]) throw new Error("Legacy recovery origin is invalid.");
  const identity = `${record.jobId}:${record.runId}:${record.canonicalJobSha256}`;
  if (identities.has(identity)) throw new Error("Legacy recovery record is duplicated.");
  identities.add(identity);
  return record as RecoveryManifestRecord;
}

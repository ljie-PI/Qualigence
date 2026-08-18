import { canonicalPayloadHash, parseExecutionPolicySnapshot } from "@qualigence/runner-protocol";
import type { LegacyM1LocalRecoveryRecord } from "@qualigence/sqlite-runtime";
import { parsePolicylessExecutionJobForRecovery } from "@qualigence/runner-control";

interface RecoveryManifestRecord extends LegacyM1LocalRecoveryRecord {}

interface RecoveryManifest {
  readonly format: "legacy-m1-local-recovery/v1";
  readonly records: readonly RecoveryManifestRecord[];
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
): readonly LegacyM1LocalRecoveryRecord[] {
  for (const record of manifest.records) {
    const raw = rows.get(`${record.jobId}:${record.runId}`);
    if (raw === undefined) throw new Error("Legacy recovery lease row is missing.");
    let job;
    try {
      job = parsePolicylessExecutionJobForRecovery(JSON.parse(raw));
    } catch {
      throw new Error("Legacy recovery lease row does not match the manifest.");
    }
    if (job.jobId !== record.jobId || job.runId !== record.runId || canonicalPayloadHash(job) !== record.canonicalJobSha256) {
      throw new Error("Legacy recovery lease row does not match the manifest.");
    }
    if (new URL(job.target.url).origin !== record.policy.allowedOrigins[0]) {
      throw new Error("Legacy recovery target origin does not match the manifest policy.");
    }
  }
  return manifest.records;
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

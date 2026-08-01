export {
  RunnerSpoolError,
  type RunnerSpoolErrorCode,
} from "./errors.js";

export {
  loadOrCreateSpoolKey,
  readSpoolKey,
  SPOOL_KEY_BYTES,
} from "./spool-key.js";

export {
  AesGcmSpoolCrypto,
  SPOOL_LEASE_SCHEMA_VERSION,
  type EncryptedLeaseSecret,
  type LeaseAssociatedData,
  type LeaseSecretInput,
  type SpoolCrypto,
} from "./spool-crypto.js";

export {
  migrateSpool,
  SPOOL_SCHEMA_VERSION,
  type SpoolMigration,
} from "./migrations.js";

export {
  DEFAULT_HARD_LIMIT_BYTES,
  DEFAULT_SOFT_LIMIT_BYTES,
  SqliteRunnerSpool,
  type RunnerSpool,
  type SpoolBatchLimit,
  type SpoolCapacityState,
  type SpoolLeaseRecord,
  type SpoolUsage,
  type SqliteRunnerSpoolOptions,
} from "./sqlite-runner-spool.js";

export { AdminCliError, type AdminCliErrorCode } from "./errors.js";
export {
  loadAdminConfig,
  readSecretFile,
  assertSecretPermissions,
  normalizeRootKey,
  type SelfHostedAdminConfig,
  type RoleCredential,
} from "./config.js";
export {
  aggregateStatus,
  type CheckStatus,
  type DoctorCheck,
  type DoctorReport,
  type ReportStatus,
} from "./health.js";
export {
  SpawnPgToolRunner,
  type PgConnectionInfo,
  type PgDumpOptions,
  type PgRestoreOptions,
  type PgToolRunner,
} from "./pg-tools.js";
export {
  createS3Client,
  enumerateObjects,
  getObjectBytes,
  putObjectBytes,
  emptyBucket,
  headBucket,
  type S3Config,
  type S3ObjectSummary,
} from "./s3-ops.js";
export {
  BackupLease,
  tryAcquireGcLock,
  BACKUP_LEASE_LOCK_KEY,
} from "./backup/backup-lease.js";
export {
  BACKUP_COMPLETE_MARKER,
  BACKUP_DATABASE_DUMP,
  BACKUP_INDEX_FILE,
  BACKUP_OBJECTS_DIR,
  canonicalizeIndex,
  objectRelativePath,
  parseIndex,
  sha256Hex,
  tenantsFromKeys,
  verifyBackupDirectory,
  type BackupIndexV1,
  type BackupObjectRecord,
  type BackupDatabaseRecord,
  type MigrationBackupBinding,
} from "./backup/backup-index.js";
export {
  runMigrate,
  type MigrateResult,
  type MigrateDeps,
  type MigrationBackupInput,
} from "./commands/migrate.js";
export { runDoctor, type DoctorOptions, type HttpProbe } from "./commands/doctor.js";
export { runBackup, type BackupDeps, type BackupResult } from "./commands/backup.js";
export {
  runRestore,
  type RestoreDeps,
  type RestoreResult,
  type RestoreVerification,
} from "./commands/restore.js";
export {
  runMigrateObservation,
  DirectoryObservationMigrationSource,
  type ObservationMigrationSource,
  type MigrateObservationOptions,
  type MigrateObservationDeps,
  type MigrateObservationResult,
} from "./commands/migrate-observation.js";

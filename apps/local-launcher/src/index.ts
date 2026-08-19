export { BackupManager } from "./backup-manager.js";
export type {
  ArtifactInventoryEntry,
  BackupFile,
  BackupManagerOptions,
  BackupManifest,
} from "./backup-manager.js";

export {
  ChildProcessUnit,
  isPidAlive,
  terminateProcess,
} from "./child-process-unit.js";
export type {
  ChildProcessUnitOptions,
  RestartPolicy,
} from "./child-process-unit.js";

export { certPathsFor, certsExist, ensureLocalCerts } from "./certs.js";
export type { LocalCertPaths } from "./certs.js";

export {
  LocalConfigError,
  loadLocalConfig,
  loadYaml,
  redactSecrets,
} from "./config.js";
export type { ConfigSources, LocalConfigErrorCode } from "./config.js";

export { LocalDoctor } from "./doctor.js";
export type { DoctorCertPaths, LocalDoctorInput } from "./doctor.js";

export { LauncherError, isLauncherError } from "./errors.js";
export type { LauncherErrorCode, LauncherErrorOptions } from "./errors.js";

export { HealthClient } from "./health-client.js";
export type { HealthTarget } from "./health-client.js";

export { MigrationGuard } from "./migration-guard.js";
export { createBootstrapCredentialHandoff } from "./bootstrap-credential-handoff.js";

export { ProcessSupervisor } from "./process-supervisor.js";
export type {
  DataDirLock,
  ProcessSupervisorOptions,
  ProcessUnit,
} from "./process-supervisor.js";

export {
  clearRuntimeState,
  isTopologyRunning,
  readRuntimeState,
  writeRuntimeState,
} from "./runtime-state.js";
export type { RuntimeState } from "./runtime-state.js";

export { run } from "./main.js";
export type { LauncherIo } from "./main.js";

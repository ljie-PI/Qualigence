export {
  OBSERVATION_MIGRATOR_VERSION,
  PreV1TraceProjector,
} from "./pre-v1-projector.js";

export type {
  PreV1ObservationAsset,
  ProjectionRecord,
} from "./pre-v1-projector.js";

export {
  ObservationMigrationRunner,
  InMemoryObservationMigrationStore,
} from "./migration-runner.js";

export { FileObservationMigrationStore } from "./file-migration-store.js";

export { ObservationCandidateInventoryRunner } from "./candidate-inventory.js";

export type {
  ActivePreV1InventoryAsset,
  CandidateInventoryRunOptions,
  PreV1SkillInventoryAsset,
} from "./candidate-inventory.js";

export {
  OBSERVATION_FREEZE_REPORT_VERSION,
  buildFreezeReport,
} from "./freeze-report.js";

export type {
  ObservationGraphLifecycle,
  ObservationFreezeCounts,
  ObservationFreezeGate,
  ObservationFreezeReportV1,
} from "./freeze-report.js";

export {
  FREEZE_DECISION_VERSION,
  WINDOWS_M3_CHECKLIST_VERSION,
  REQUIRED_SECURITY_VETO_ITEM_IDS,
  REQUIRED_SHARED_CORE_FIELDS,
  GRAPH_FREEZE_DECISION_VERSION,
  GraphFreezeFinalizationError,
  decideGraphFreeze,
} from "./freeze-decision.js";

export type {
  WindowsChecklistItemResult,
  WindowsChecklistItemEvidence,
  WindowsChecklistEvidence,
  SchemaConformanceEvidence,
  FreezeDecisionStatus,
  FreezeDecisionInputs,
  FreezeDecisionSignoff,
  FreezeDecision,
  GraphFreezeEvidenceId,
  GraphFreezeEvidenceReference,
  GraphFreezeEvidencePaths,
  GraphFreezeCapabilityStatus,
  GraphFreezeCapabilityDecision,
  GraphFreezeDecisionV1,
  FinalizeGraphFreezeInput,
  GraphFreezeFinalizationResult,
  GraphFreezeFinalizationErrorCode,
} from "./freeze-decision.js";

export {
  OBSERVATION_FREEZE_GATE_REPORT_VERSION,
  buildFreezeGateReport,
  generateAutomatedFreezeGateReport,
  finalizeGraphFreezeFromEvidence,
} from "./freeze-gate.js";

export type {
  FreezeGateEnvironment,
  BuildFreezeGateReportInput,
  FreezeGateReportV1,
} from "./freeze-gate.js";

export type {
  ObservationMigrationStatus,
  ObservationMigrationResult,
  ObservationMigrationLookupIdentity,
  StoredObservationMigration,
  ObservationMigrationStore,
  ObservationMigrationRunnerOptions,
} from "./migration-runner.js";

export { SkillRecompiler, migrateRecordingToV1 } from "./skill-recompiler.js";

export type {
  PreV1SkillReference,
  PreV1SkillAsset,
  RecompiledSkillReverifier,
  RecompileStatus,
  RecompileOutcome,
  SkillSourceVerification,
} from "./skill-recompiler.js";

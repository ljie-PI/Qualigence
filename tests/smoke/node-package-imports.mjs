const packages = [
  ["@qualigence/application-model", "TestPlanProposalValidator"],
  ["@qualigence/context-intake", "PrdIntakeService"],
  ["@qualigence/runner-protocol", "canonicalPayloadHash"],
  ["@qualigence/runner-spool", "SqliteRunnerSpool"],
  ["@qualigence/runner-kernel", "ExecutionRuntime"],
  ["@qualigence/runner-identity", "RunnerEnrollmentService"],
  ["@qualigence/runner-mtls", "SelfHostedRunnerAuthenticator"],
  ["@qualigence/public-api", "IDEMPOTENCY_KEY_HEADER"],
  ["@qualigence/oidc", "OidcAuthenticator"],
  ["@qualigence/core-application", "PostgresIntelligenceQueue"],
  ["@qualigence/evidence", "TraceIngestor"],
  ["@qualigence/mission", "MissionCompiler"],
  ["@qualigence/in-memory-runner-protocol", "InMemoryProtocolTraceRecorder"],
  ["@qualigence/local-control", "healthReportSchema"],
  ["@qualigence/testkit", "ScriptedDecisionProvider"],
  ["@qualigence/shared-kernel", "SystemClock"],
  ["@qualigence/artifact-fs", "LocalArtifactStore"],
  ["@qualigence/artifact-s3", "S3ArtifactStore"],
  ["@qualigence/relational-kysely", "MIGRATIONS"],
  ["@qualigence/postgres-runtime", "createTenantSchema"],
  ["@qualigence/sqlite-runtime", "SqliteRuntime"],
  ["@qualigence/recording", "RecordingRecorder"],
  ["@qualigence/skill", "TestSkill"],
  ["@qualigence/skill-replay", "SkillReplayController"],
  ["@qualigence/exploration", "ExplorationController"],
  ["@qualigence/benchmarking-detection", "scoreBenchmark"],
  ["@qualigence/kms-local", "LocalSkillSigner"],
  ["@qualigence/kms-self-hosted", "InMemoryTestKms"],
  ["@qualigence/evidence-capsule", "EvidenceCapsuleBuilder"],
  ["@qualigence/web-playwright", "PlaywrightWebTargetAdapter"],
  ["@qualigence/execution-application", "RunExecutionUseCaseImpl"],
  ["@qualigence/grpc-runner-protocol", "GrpcRunnerProtocolClient"],
  ["@qualigence/core-daemon", "RunnerBackedRunResourceFactory"],
  ["@qualigence/runner", "RunnerClient"],
  ["@qualigence/investigation", "InvestigationCase"],
  ["@qualigence/intelligence", "IntelligenceResultApplier"],
  ["@qualigence/review", "ClaimReviewTaskHandler"],
];

for (const [packageName, exportName] of packages) {
  const imported = await import(packageName);
  if (!(exportName in imported)) {
    throw new Error(`${packageName} did not export ${exportName}`);
  }
}

const packages = [
  ["@qualigence/application-model", "TestPlanProposalValidator"],
  ["@qualigence/context-intake", "PrdIntakeService"],
  ["@qualigence/runner-protocol", "canonicalPayloadHash"],
  ["@qualigence/runner-kernel", "ExecutionRuntime"],
  ["@qualigence/evidence", "TraceIngestor"],
  ["@qualigence/mission", "MissionCompiler"],
  ["@qualigence/in-memory-runner-protocol", "InMemoryProtocolTraceRecorder"],
  ["@qualigence/testkit", "ScriptedDecisionProvider"],
  ["@qualigence/shared-kernel", "SystemClock"],
  ["@qualigence/artifact-fs", "LocalArtifactStore"],
  ["@qualigence/sqlite-runtime", "SqliteRuntime"],
  ["@qualigence/web-playwright", "PlaywrightWebTargetAdapter"],
  ["@qualigence/execution-application", "RunExecutionUseCaseImpl"],
  ["@qualigence/grpc-runner-protocol", "GrpcRunnerProtocolClient"],
];

for (const [packageName, exportName] of packages) {
  const imported = await import(packageName);
  if (!(exportName in imported)) {
    throw new Error(`${packageName} did not export ${exportName}`);
  }
}

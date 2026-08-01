const packages = [
  ["@qualigence/runner-protocol", "canonicalPayloadHash"],
  ["@qualigence/runner-kernel", "ExecutionRuntime"],
  ["@qualigence/evidence", "TraceIngestor"],
  ["@qualigence/in-memory-runner-protocol", "InMemoryProtocolTraceRecorder"],
  ["@qualigence/testkit", "ScriptedDecisionProvider"],
  ["@qualigence/shared-kernel", "SystemClock"],
  ["@qualigence/artifact-fs", "LocalArtifactStore"],
  ["@qualigence/sqlite-runtime", "SqliteRuntime"],
  ["@qualigence/web-playwright", "PlaywrightWebTargetAdapter"],
];

for (const [packageName, exportName] of packages) {
  const imported = await import(packageName);
  if (!(exportName in imported)) {
    throw new Error(`${packageName} did not export ${exportName}`);
  }
}

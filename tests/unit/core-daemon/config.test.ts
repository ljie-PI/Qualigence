import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadCoreDaemonConfig } from "@qualigence/core-daemon";

describe("CoreDaemonConfig", () => {
  it("requires an explicitly declared deployment mode", () => {
    expect(() => loadCoreDaemonConfig({ CORE_DEPLOYMENT_MODE: undefined })).toThrow(/CORE_DEPLOYMENT_MODE/);
    expect(() => loadCoreDaemonConfig({ CORE_DEPLOYMENT_MODE: "preview" })).toThrow(/CORE_DEPLOYMENT_MODE/);
  });

  it("preserves manifest absence and rejects malformed manifest JSON", async () => {
    const directory = await mkdtemp(join(process.cwd(), ".tmp-core-config-"));
    try {
      const ca = join(directory, "ca.pem");
      const cert = join(directory, "cert.pem");
      const key = join(directory, "key.pem");
      await Promise.all([writeFile(ca, "ca"), writeFile(cert, "cert"), writeFile(key, "key")]);
      const env: NodeJS.ProcessEnv = { CORE_TLS_CA: ca, CORE_TLS_CERT: cert, CORE_TLS_KEY: key, CORE_DEPLOYMENT_MODE: "local" };
      expect(loadCoreDaemonConfig(env)).not.toHaveProperty("legacyM1LocalRecoveryCandidate");
      const manifest = join(directory, "manifest.json");
      await writeFile(manifest, "not json");
      expect(() => loadCoreDaemonConfig({ ...env, CORE_LEGACY_M1_LOCAL_RECOVERY_MANIFEST: manifest })).toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses every nondefault validated Local reconciliation and session value", async () => {
    const directory = await mkdtemp(join(process.cwd(), ".tmp-core-config-values-"));
    try {
      const ca = join(directory, "ca.pem"); const cert = join(directory, "cert.pem"); const key = join(directory, "key.pem");
      await Promise.all([writeFile(ca, "ca"), writeFile(cert, "cert"), writeFile(key, "key")]);
      const config = loadCoreDaemonConfig({ CORE_TLS_CA: ca, CORE_TLS_CERT: cert, CORE_TLS_KEY: key, CORE_DEPLOYMENT_MODE: "local", CORE_USER_SESSION_TTL_MS: "1234", CORE_COMPLETION_RETRY_BASE_MS: "400", CORE_COMPLETION_RETRY_MAXIMUM_MS: "800", CORE_COMPLETION_MAXIMUM_ATTEMPTS: "5", CORE_COMPLETION_POLL_INTERVAL_MS: "200", CORE_COMPLETION_BATCH_SIZE: "7" });
      expect(config).toMatchObject({ userSessionTtlMs: 1_234, completionReconciliationRetryBaseMs: 400, completionReconciliationRetryMaximumMs: 800, completionReconciliationMaximumAttempts: 5, completionReconciliationPollIntervalMs: 200, completionReconciliationBatchSize: 7 });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

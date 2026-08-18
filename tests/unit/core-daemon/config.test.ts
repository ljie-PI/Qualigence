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
});

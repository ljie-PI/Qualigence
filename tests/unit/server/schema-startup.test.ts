import { describe, expect, it, vi } from "vitest";
import { PostgresSchemaError } from "@qualigence/postgres-runtime";
import { main } from "../../../apps/server/src/main.js";

describe("Server schema startup guard", () => {
  for (const code of ["SchemaMalformed", "SchemaAhead", "SchemaBehind"] as const) {
    it(`refuses startup before constructing runtime dependencies when schema validation reports ${code}`, async () => {
      const assertSchema = vi.fn(async () => {
        throw new PostgresSchemaError(code, "schema is not safe for runtime startup", 6);
      });
      await expect(main({}, assertSchema, () => serverConfig())).rejects.toMatchObject({ code });
      expect(assertSchema).toHaveBeenCalledOnce();
      expect(assertSchema).toHaveBeenCalledWith(serverConfig().postgres, "server");
    });
  }
});

function serverConfig() {
  return {
    host: "127.0.0.1",
    port: 8080,
    postgres: { host: "127.0.0.1", port: 5432, database: "qualigence", user: "server", password: "secret" },
    intelligenceResultConsumer: {
      enabled: false,
      consumerId: "server-test",
      tenantBatchSize: 1,
      resultBatchSize: 1,
      leaseDurationMs: 30_000,
      idleBackoffMs: 1_000,
      errorBackoffMs: 1_000,
      maximumBackoffMs: 30_000,
    },
    oidc: {
      issuer: "https://issuer.example",
      audience: "qualigence",
      allowedAlgorithms: ["RS256" as const],
      jwksJson: "[]",
      claimMapper: {
        tenantClaim: "tenant",
        rolesClaim: "roles",
        allowedTenants: ["tenant-a"],
        roleMap: { admin: "admin" as const },
      },
    },
    runnerCa: { certificatePem: "unused", privateKeyPem: "unused" },
    artifactDataDir: ".tmp-test-artifacts",
  };
}

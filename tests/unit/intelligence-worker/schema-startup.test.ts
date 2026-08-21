import { describe, expect, it, vi } from "vitest";
import { PostgresSchemaError } from "@qualigence/postgres-runtime";
import { main } from "../../../apps/intelligence-worker/src/main.js";

describe("Intelligence Worker schema startup guard", () => {
  for (const code of ["SchemaMalformed", "SchemaAhead", "SchemaBehind"] as const) {
    it(`refuses startup before constructing queue/model dependencies when schema validation reports ${code}`, async () => {
      const assertSchema = vi.fn(async () => {
        throw new PostgresSchemaError(code, "schema is not safe for runtime startup", 6);
      });
      await expect(main(workerEnv(), assertSchema)).rejects.toMatchObject({ code });
      expect(assertSchema).toHaveBeenCalledOnce();
      expect(assertSchema).toHaveBeenCalledWith(
        {
          host: "127.0.0.1",
          port: 5432,
          database: "qualigence",
          user: "worker",
          password: "secret",
        },
        "server",
      );
    });
  }

  it("requires the Server database role explicitly", async () => {
    const env = workerEnv();
    delete env.WORKER_PG_SERVER_ROLE;
    const assertSchema = vi.fn();

    await expect(main(env, assertSchema)).rejects.toThrow(
      "Missing required environment variable WORKER_PG_SERVER_ROLE",
    );
    expect(assertSchema).not.toHaveBeenCalled();
  });
});

function workerEnv(): NodeJS.ProcessEnv {
  return {
    WORKER_PG_HOST: "127.0.0.1",
    WORKER_PG_DATABASE: "qualigence",
    WORKER_PG_USER: "worker",
    WORKER_PG_PASSWORD: "secret",
    WORKER_PG_SERVER_ROLE: "server",
    WORKER_S3_BUCKET: "artifacts",
    WORKER_S3_ACCESS_KEY_ID: "access",
    WORKER_S3_SECRET_ACCESS_KEY: "secret",
    WORKER_MODEL_BASE_URL: "https://model.example",
    WORKER_MODEL_API_KEY: "secret",
    WORKER_MODEL_NAME: "model",
  };
}

import { randomUUID } from "node:crypto";
import type { SqliteRuntime } from "./database.js";
import { runInImmediateTransaction } from "./transaction.js";

export class SqliteLocalReadinessProbe {
  constructor(private readonly runtime: SqliteRuntime) {}

  async probe(): Promise<void> {
    const marker = randomUUID();
    await runInImmediateTransaction(this.runtime, async () => {
      await this.runtime.db.insertInto("execution_runs").values({ run_id: marker, job_id: marker, target_kind: "web", objective: "readiness", status: "running", next_sequence_number: 1, created_at: new Date(0).toISOString(), completed_at: null, error_code: null }).execute();
      await this.runtime.db.insertInto("trace_events").values({ run_id: marker, sequence_number: 1, message_id: marker, idempotency_key: marker, stage: "observation", occurred_at: new Date(0).toISOString(), payload_hash: "0".repeat(64), envelope_json: "{}" }).execute();
      await this.runtime.db.insertInto("artifact_manifests").values({ artifact_id: marker, run_id: marker, kind: "other", media_type: "application/octet-stream", relative_path: `${marker}/probe`, sha256: "0".repeat(64), size_bytes: 0, created_at: new Date(0).toISOString() }).execute();
      throw new RollbackProbe();
    }).catch((error: unknown) => { if (!(error instanceof RollbackProbe)) throw error; });
    const leaked = await this.runtime.db.selectFrom("execution_runs").select("run_id").where("run_id", "=", marker).executeTakeFirst();
    if (leaked !== undefined) throw new Error("SQLite readiness rollback probe leaked state.");
  }
}

class RollbackProbe extends Error {}

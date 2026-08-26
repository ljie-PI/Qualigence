import BetterSqlite3 from "better-sqlite3";
import { createHash } from "node:crypto";
import type { ArtifactUploadAck, ArtifactUploadChunk, ArtifactUploadManifest, TraceEvent } from "@qualigence/runner-protocol";
import type { Clock } from "@qualigence/shared-kernel";
import { SystemClock } from "@qualigence/shared-kernel";
import { RunnerSpoolError } from "./errors.js";
import { migrateSpool } from "./migrations.js";
import {
  SPOOL_LEASE_SCHEMA_VERSION,
  type EncryptedLeaseSecret,
  type SpoolCrypto,
} from "./spool-crypto.js";

/**
 * Default soft capacity limit (512 MiB). Past it the Runner stops queuing
 * non-critical Artifacts but keeps writing Trace.
 */
export const DEFAULT_SOFT_LIMIT_BYTES = 512 * 1024 * 1024;

/**
 * Default hard capacity limit (1 GiB). An append that would cross it is rejected
 * with {@link RunnerSpoolError} `SpoolCapacityExceeded`; unacknowledged Trace is
 * never discarded to make room.
 */
export const DEFAULT_HARD_LIMIT_BYTES = 1024 * 1024 * 1024;

const DEFAULT_BUSY_TIMEOUT_MS = 5000;

/**
 * The outbound batch limit a Runner enforces when draining the spool: a batch is
 * capped by both event count and total encoded bytes. It mirrors the frozen
 * design's `SpoolBatchLimit`; it is declared here because the runner-protocol
 * contract does not export it.
 */
export interface SpoolBatchLimit {
  readonly maximumEvents: number;
  readonly maximumBytes: number;
}

/**
 * Durable, disk-backed queue of Trace events (plus encrypted lease state) that a
 * Runner writes before attempting network submission. Acknowledged events are
 * removed; everything else survives a Runner restart and replays in order.
 */
export interface RunnerSpool {
  append(event: TraceEvent): Promise<void>;
  pending(
    runId: string,
    fromSequence: number,
    limit: SpoolBatchLimit,
  ): Promise<readonly TraceEvent[]>;
  acknowledge(runId: string, nextExpectedSequenceNumber: number): Promise<void>;
  saveArtifactManifest?(manifest: ArtifactUploadManifest): Promise<void>;
  saveArtifactChunk?(chunk: ArtifactUploadChunk): Promise<void>;
  pendingArtifactManifests?(runId: string): Promise<readonly ArtifactUploadManifest[]>;
  pendingArtifactChunks?(runId: string, artifactId: string, missingRanges: readonly { readonly offset: number; readonly length: number }[]): Promise<readonly ArtifactUploadChunk[]>;
  acknowledgeArtifactProgress?(progress: ArtifactUploadAck): Promise<void>;
  usage(): Promise<{ readonly bytes: number; readonly events: number }>;
}

export interface SqliteRunnerSpoolOptions {
  readonly databaseFile: string;
  readonly crypto?: SpoolCrypto;
  readonly clock?: Clock;
  readonly softLimitBytes?: number;
  readonly hardLimitBytes?: number;
  readonly busyTimeoutMs?: number;
  readonly measureEventBytes?: (event: TraceEvent) => number;
}

export interface SpoolLeaseRecord {
  readonly jobId: string;
  readonly runId: string;
  readonly leaseEpoch: number;
  readonly expiresAt: string;
  readonly leaseToken: string;
}

export interface SpoolUsage {
  readonly bytes: number;
  readonly events: number;
}

export interface SpoolCapacityState extends SpoolUsage {
  readonly soft: boolean;
  readonly hard: boolean;
  readonly softLimitBytes: number;
  readonly hardLimitBytes: number;
}

interface EventRow {
  readonly sequence_number: number;
  readonly payload_hash: string;
  readonly envelope_json: string;
  readonly size_bytes: number;
}

interface LeaseRow {
  readonly run_id: string;
  readonly lease_epoch: number;
  readonly expires_at: string;
  readonly schema_version: string;
  readonly encrypted_token: Buffer;
  readonly token_nonce: Buffer;
  readonly token_tag: Buffer;
}

interface ArtifactManifestRow {
  readonly manifest_json: string;
}

interface ArtifactChunkRow {
  readonly artifact_id: string;
  readonly tenant_id: string;
  readonly project_id: string;
  readonly run_id: string;
  readonly offset_bytes: number;
  readonly bytes: Buffer;
  readonly sha256: string;
}

function defaultMeasureEventBytes(event: TraceEvent): number {
  return Buffer.byteLength(JSON.stringify(event), "utf8");
}

/**
 * A local, disk-backed Runner Spool.
 *
 * Trace events are written durably to a private SQLite file before the Runner
 * attempts any network submission, and acknowledged rows are deleted only once
 * the server confirms them, so spooled Trace survives a Runner restart and is
 * replayed in its original order. Lease secrets are encrypted at rest with
 * AES-256-GCM; if the spool key is lost the lease metadata is dropped while the
 * Trace is preserved.
 */
export class SqliteRunnerSpool implements RunnerSpool {
  private closed = false;

  private constructor(
    private readonly connection: BetterSqlite3.Database,
    private readonly crypto: SpoolCrypto | undefined,
    private readonly clock: Clock,
    private readonly softLimitBytes: number,
    private readonly hardLimitBytes: number,
    private readonly measureEventBytes: (event: TraceEvent) => number,
  ) {}

  static async open(options: SqliteRunnerSpoolOptions): Promise<SqliteRunnerSpool> {
    let connection: BetterSqlite3.Database;
    try {
      connection = new BetterSqlite3(options.databaseFile);
    } catch (cause) {
      throw new RunnerSpoolError(
        "SpoolOpenFailed",
        `Failed to open spool database at ${options.databaseFile}`,
        { cause },
      );
    }

    try {
      connection.pragma("journal_mode = WAL");
      connection.pragma("foreign_keys = ON");
      connection.pragma(
        `busy_timeout = ${Math.trunc(options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS)}`,
      );
      migrateSpool(connection);
    } catch (cause) {
      connection.close();
      throw new RunnerSpoolError(
        "SpoolOpenFailed",
        "Failed to initialise the spool database",
        { cause },
      );
    }

    const spool = new SqliteRunnerSpool(
      connection,
      options.crypto,
      options.clock ?? new SystemClock(),
      options.softLimitBytes ?? DEFAULT_SOFT_LIMIT_BYTES,
      options.hardLimitBytes ?? DEFAULT_HARD_LIMIT_BYTES,
      options.measureEventBytes ?? defaultMeasureEventBytes,
    );

    // A lost or absent key means the local lease secrets can never be decrypted
    // again; drop the unreadable metadata but keep the Trace intact.
    if (options.crypto === undefined) {
      connection.prepare("DELETE FROM spool_leases").run();
    }

    return spool;
  }

  async append(event: TraceEvent): Promise<void> {
    this.assertOpen();
    const size = this.measureEventBytes(event);

    const existing = this.connection
      .prepare(
        "SELECT payload_hash FROM spool_events WHERE run_id = ? AND sequence_number = ?",
      )
      .get(event.runId, event.sequenceNumber) as
      | { readonly payload_hash: string }
      | undefined;
    if (existing !== undefined) {
      if (existing.payload_hash === event.payloadHash) {
        return;
      }
      throw new RunnerSpoolError(
        "SpoolIntegrityViolation",
        `Sequence ${event.sequenceNumber} for run ${event.runId} already spooled with a different payload hash`,
      );
    }

    const usedBytes = this.currentBytes();
    if (usedBytes + size > this.hardLimitBytes) {
      throw new RunnerSpoolError(
        "SpoolCapacityExceeded",
        `Appending ${size} bytes would exceed the hard spool limit of ${this.hardLimitBytes} bytes`,
      );
    }

    this.connection
      .prepare(
        `INSERT INTO spool_events
           (run_id, sequence_number, payload_hash, envelope_json, size_bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.runId,
        event.sequenceNumber,
        event.payloadHash,
        JSON.stringify(event),
        size,
        this.clock.now(),
      );
  }

  async pending(
    runId: string,
    fromSequence: number,
    limit: SpoolBatchLimit,
  ): Promise<readonly TraceEvent[]> {
    this.assertOpen();
    const rows = this.connection
      .prepare(
        `SELECT sequence_number, payload_hash, envelope_json, size_bytes
           FROM spool_events
          WHERE run_id = ? AND sequence_number >= ?
          ORDER BY sequence_number ASC`,
      )
      .all(runId, fromSequence) as EventRow[];

    const events: TraceEvent[] = [];
    let accumulatedBytes = 0;
    for (const row of rows) {
      if (events.length >= limit.maximumEvents) {
        break;
      }
      if (events.length > 0 && accumulatedBytes + row.size_bytes > limit.maximumBytes) {
        break;
      }
      events.push(JSON.parse(row.envelope_json) as TraceEvent);
      accumulatedBytes += row.size_bytes;
    }
    return events;
  }

  async acknowledge(runId: string, nextExpectedSequenceNumber: number): Promise<void> {
    this.assertOpen();
    const now = this.clock.now();
    const acknowledge = this.connection.transaction(() => {
      const cursor = this.connection
        .prepare("SELECT next_ack_sequence FROM spool_cursors WHERE run_id = ?")
        .get(runId) as { readonly next_ack_sequence: number } | undefined;
      const next = Math.max(cursor?.next_ack_sequence ?? 1, nextExpectedSequenceNumber);
      this.connection
        .prepare(
          `INSERT INTO spool_cursors (run_id, next_ack_sequence, updated_at)
             VALUES (?, ?, ?)
           ON CONFLICT(run_id)
             DO UPDATE SET next_ack_sequence = excluded.next_ack_sequence, updated_at = excluded.updated_at`,
        )
        .run(runId, next, now);
      this.connection
        .prepare("DELETE FROM spool_events WHERE run_id = ? AND sequence_number < ?")
        .run(runId, nextExpectedSequenceNumber);
    });
    acknowledge();
  }

  async saveArtifactManifest(manifest: ArtifactUploadManifest): Promise<void> {
    this.assertOpen();
    const existing = this.connection
      .prepare("SELECT manifest_json FROM spool_artifact_manifests WHERE artifact_id = ?")
      .get(manifest.artifactId) as ArtifactManifestRow | undefined;
    const manifestJson = JSON.stringify(manifest);
    if (existing !== undefined) {
      if (existing.manifest_json === manifestJson) return;
      throw new RunnerSpoolError("SpoolIntegrityViolation", `Artifact ${manifest.artifactId} already has a different manifest`);
    }
    this.connection
      .prepare(
        `INSERT INTO spool_artifact_manifests
          (artifact_id, run_id, manifest_json, size_bytes, chunk_size_bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(manifest.artifactId, manifest.runId, manifestJson, manifest.sizeBytes, manifest.chunkSizeBytes, this.clock.now());
  }

  async saveArtifactChunk(chunk: ArtifactUploadChunk): Promise<void> {
    this.assertOpen();
    if (sha256Hex(chunk.bytes) !== chunk.sha256) {
      throw new RunnerSpoolError("SpoolIntegrityViolation", `Artifact ${chunk.artifactId} chunk hash does not match bytes`);
    }
    const existing = this.connection
      .prepare("SELECT sha256, bytes FROM spool_artifact_chunks WHERE artifact_id = ? AND offset_bytes = ?")
      .get(chunk.artifactId, chunk.offset) as { readonly sha256: string; readonly bytes: Buffer } | undefined;
    if (existing !== undefined) {
      if (existing.sha256 === chunk.sha256 && Buffer.from(existing.bytes).equals(Buffer.from(chunk.bytes))) return;
      throw new RunnerSpoolError("SpoolIntegrityViolation", `Artifact ${chunk.artifactId} chunk ${chunk.offset} already has different bytes`);
    }
    if (this.currentBytes() + chunk.bytes.length > this.hardLimitBytes) {
      throw new RunnerSpoolError(
        "SpoolCapacityExceeded",
        `Appending ${chunk.bytes.length} artifact bytes would exceed the hard spool limit of ${this.hardLimitBytes} bytes`,
      );
    }
    this.connection
      .prepare(
        `INSERT INTO spool_artifact_chunks
          (artifact_id, tenant_id, project_id, run_id, offset_bytes, bytes, sha256, size_bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        chunk.artifactId,
        chunk.tenantId,
        chunk.projectId,
        chunk.runId,
        chunk.offset,
        Buffer.from(chunk.bytes),
        chunk.sha256,
        chunk.bytes.length,
        this.clock.now(),
      );
  }

  async pendingArtifactManifests(runId: string): Promise<readonly ArtifactUploadManifest[]> {
    this.assertOpen();
    const rows = this.connection
      .prepare(
        `SELECT manifest_json FROM spool_artifact_manifests
          WHERE run_id = ? ORDER BY created_at, artifact_id`,
      )
      .all(runId) as ArtifactManifestRow[];
    return rows.map((row) => JSON.parse(row.manifest_json) as ArtifactUploadManifest);
  }

  async pendingArtifactChunks(
    runId: string,
    artifactId: string,
    missingRanges: readonly { readonly offset: number; readonly length: number }[],
  ): Promise<readonly ArtifactUploadChunk[]> {
    this.assertOpen();
    if (missingRanges.length === 0) return [];
    const rows = this.connection
      .prepare(
        `SELECT artifact_id, tenant_id, project_id, run_id, offset_bytes, bytes, sha256
           FROM spool_artifact_chunks
          WHERE run_id = ? AND artifact_id = ?
          ORDER BY offset_bytes`,
      )
      .all(runId, artifactId) as ArtifactChunkRow[];
    return rows
      .filter((row) => missingRanges.some((range) => row.offset_bytes >= range.offset && row.offset_bytes < range.offset + range.length))
      .map((row) => ({
        artifactId: row.artifact_id,
        tenantId: row.tenant_id,
        projectId: row.project_id,
        runId: row.run_id,
        offset: row.offset_bytes,
        bytes: new Uint8Array(row.bytes),
        sha256: row.sha256,
      }));
  }

  async acknowledgeArtifactProgress(progress: ArtifactUploadAck): Promise<void> {
    this.assertOpen();
    if (progress.acknowledged) {
      const remove = this.connection.transaction(() => {
        this.connection.prepare("DELETE FROM spool_artifact_chunks WHERE run_id = ? AND artifact_id = ?").run(progress.runId, progress.artifactId);
        this.connection.prepare("DELETE FROM spool_artifact_manifests WHERE run_id = ? AND artifact_id = ?").run(progress.runId, progress.artifactId);
      });
      remove();
      return;
    }
    const rows = this.connection
      .prepare("SELECT offset_bytes FROM spool_artifact_chunks WHERE run_id = ? AND artifact_id = ?")
      .all(progress.runId, progress.artifactId) as Array<{ readonly offset_bytes: number }>;
    const acknowledgedOffsets = rows
      .map((row) => row.offset_bytes)
      .filter((offset) => !progress.missingRanges.some((range) => offset >= range.offset && offset < range.offset + range.length));
    const remove = this.connection.transaction(() => {
      for (const offset of acknowledgedOffsets) {
        this.connection.prepare("DELETE FROM spool_artifact_chunks WHERE run_id = ? AND artifact_id = ? AND offset_bytes = ?")
          .run(progress.runId, progress.artifactId, offset);
      }
    });
    remove();
  }

  async usage(): Promise<SpoolUsage> {
    this.assertOpen();
    const row = this.connection
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM spool_events) AS events,
           (SELECT COALESCE(SUM(size_bytes), 0) FROM spool_events) +
           (SELECT COALESCE(SUM(size_bytes), 0) FROM spool_artifact_chunks) AS bytes`,
      )
      .get() as { readonly events: number; readonly bytes: number };
    return { bytes: Number(row.bytes), events: Number(row.events) };
  }

  async capacityState(): Promise<SpoolCapacityState> {
    const { bytes, events } = await this.usage();
    return {
      bytes,
      events,
      soft: bytes >= this.softLimitBytes,
      hard: bytes >= this.hardLimitBytes,
      softLimitBytes: this.softLimitBytes,
      hardLimitBytes: this.hardLimitBytes,
    };
  }

  async saveLease(record: SpoolLeaseRecord): Promise<void> {
    this.assertOpen();
    const crypto = this.requireCrypto();
    const encrypted = await crypto.encryptLease({
      schemaVersion: SPOOL_LEASE_SCHEMA_VERSION,
      jobId: record.jobId,
      runId: record.runId,
      leaseEpoch: record.leaseEpoch,
      expiresAt: record.expiresAt,
      secret: record.leaseToken,
    });
    this.connection
      .prepare(
        `INSERT INTO spool_leases
           (job_id, run_id, lease_epoch, expires_at, schema_version, encrypted_token, token_nonce, token_tag, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(job_id) DO UPDATE SET
           run_id = excluded.run_id,
           lease_epoch = excluded.lease_epoch,
           expires_at = excluded.expires_at,
           schema_version = excluded.schema_version,
           encrypted_token = excluded.encrypted_token,
           token_nonce = excluded.token_nonce,
           token_tag = excluded.token_tag,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.jobId,
        record.runId,
        record.leaseEpoch,
        record.expiresAt,
        encrypted.schemaVersion,
        encrypted.ciphertext,
        encrypted.nonce,
        encrypted.tag,
        this.clock.now(),
      );
  }

  async loadLease(jobId: string): Promise<SpoolLeaseRecord | undefined> {
    this.assertOpen();
    const crypto = this.requireCrypto();
    const row = this.connection
      .prepare(
        `SELECT run_id, lease_epoch, expires_at, schema_version, encrypted_token, token_nonce, token_tag
           FROM spool_leases WHERE job_id = ?`,
      )
      .get(jobId) as LeaseRow | undefined;
    if (row === undefined) {
      return undefined;
    }
    const encrypted: EncryptedLeaseSecret = {
      schemaVersion: row.schema_version,
      jobId,
      runId: row.run_id,
      leaseEpoch: row.lease_epoch,
      expiresAt: row.expires_at,
      nonce: row.token_nonce,
      ciphertext: row.encrypted_token,
      tag: row.token_tag,
    };
    const leaseToken = await crypto.decryptLease(encrypted);
    return {
      jobId,
      runId: row.run_id,
      leaseEpoch: row.lease_epoch,
      expiresAt: row.expires_at,
      leaseToken,
    };
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.connection.pragma("wal_checkpoint(TRUNCATE)");
    this.connection.close();
  }

  private currentBytes(): number {
    const row = this.connection
      .prepare(
        `SELECT
           (SELECT COALESCE(SUM(size_bytes), 0) FROM spool_events) +
           (SELECT COALESCE(SUM(size_bytes), 0) FROM spool_artifact_chunks) AS bytes`,
      )
      .get() as { readonly bytes: number };
    return Number(row.bytes);
  }

  private requireCrypto(): SpoolCrypto {
    if (this.crypto === undefined) {
      throw new RunnerSpoolError(
        "SpoolKeyUnavailable",
        "The spool key is unavailable; lease secrets cannot be read or written",
      );
    }
    return this.crypto;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new RunnerSpoolError("SpoolOpenFailed", "The runner spool has been closed");
    }
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

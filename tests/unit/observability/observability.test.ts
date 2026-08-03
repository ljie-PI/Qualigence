import { describe, expect, it } from "vitest";
import {
  MetricsRegistry,
  StructuredLogger,
  REDACTED,
  type LogRecord,
} from "@qualigence/observability";

describe("StructuredLogger", () => {
  function capture(): { records: LogRecord[]; logger: StructuredLogger } {
    const records: LogRecord[] = [];
    const logger = new StructuredLogger({
      service: "admin-cli",
      sink: (record) => records.push(record),
      now: () => "2026-08-02T00:00:00.000Z",
    });
    return { records, logger };
  }

  it("emits a structured JSON record with level, service, time and message", () => {
    const { records, logger } = capture();
    logger.info("backup started", { backupId: "b-1" });
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record).toMatchObject({
      level: "info",
      service: "admin-cli",
      time: "2026-08-02T00:00:00.000Z",
      msg: "backup started",
      backupId: "b-1",
    });
  });

  it("redacts sensitive fields by key name at any depth", () => {
    const { records, logger } = capture();
    logger.info("connecting", {
      user: "server_role",
      password: "hunter2",
      nested: { apiKey: "sk-live-123", token: "tok_abc" },
      list: [{ secretAccessKey: "aws-secret" }],
    });
    const record = records[0]!;
    expect(record.password).toBe(REDACTED);
    expect((record.nested as Record<string, unknown>).apiKey).toBe(REDACTED);
    expect((record.nested as Record<string, unknown>).token).toBe(REDACTED);
    const list = record.list as Array<Record<string, unknown>>;
    expect(list[0]!.secretAccessKey).toBe(REDACTED);
    // Non-sensitive fields survive.
    expect(record.user).toBe("server_role");
  });

  it("redacts PEM private key material found in string values", () => {
    const { records, logger } = capture();
    logger.warn("cert", {
      pem: "-----BEGIN PRIVATE KEY-----\nMIIB...\n-----END PRIVATE KEY-----",
    });
    expect(records[0]!.pem).toBe(REDACTED);
  });

  it("serializes to a single JSON line without secrets", () => {
    const { logger } = capture();
    const line = logger.stringify("done", { password: "hunter2", ok: true });
    expect(line).not.toContain("hunter2");
    expect(line.split("\n")).toHaveLength(1);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.password).toBe(REDACTED);
    expect(parsed.ok).toBe(true);
  });
});

describe("MetricsRegistry", () => {
  it("increments counters and renders Prometheus text exposition", () => {
    const registry = new MetricsRegistry();
    const counter = registry.counter("backup_objects_total", "objects copied by backup");
    counter.inc();
    counter.inc(4);
    const text = registry.render();
    expect(text).toContain("# HELP backup_objects_total objects copied by backup");
    expect(text).toContain("# TYPE backup_objects_total counter");
    expect(text).toContain("backup_objects_total 5");
  });

  it("supports labelled series and gauges", () => {
    const registry = new MetricsRegistry();
    const gauge = registry.gauge("doctor_check_status", "1 pass, 0 fail");
    gauge.set(1, { check: "database" });
    gauge.set(0, { check: "s3" });
    const text = registry.render();
    expect(text).toContain('doctor_check_status{check="database"} 1');
    expect(text).toContain('doctor_check_status{check="s3"} 0');
  });

  it("rejects high-cardinality / disallowed label names", () => {
    const registry = new MetricsRegistry();
    const counter = registry.counter("jobs_total", "jobs");
    expect(() => counter.inc(1, { url: "https://x/y?secret=1" })).toThrow(
      /disallowed metric label/i,
    );
    expect(() => counter.inc(1, { prompt: "hi" })).toThrow(/disallowed metric label/i);
    expect(() => counter.inc(1, { artifactId: "abc" })).toThrow(/disallowed metric label/i);
  });
});

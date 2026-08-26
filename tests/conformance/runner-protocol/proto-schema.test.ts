import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { capabilities } from "@qualigence/runner-protocol";
import type {
  ExecutionEventAck,
  ExecutionEventBatch,
  ExecutionJobLease,
  ExecutionJobOffer,
  RunnerHello,
  RunnerWelcome,
} from "@qualigence/runner-protocol";

const protoPath = fileURLToPath(
  new URL(
    "../../../packages/contracts/runner-protocol/proto/qualigence/runner/v1/runner.proto",
    import.meta.url,
  ),
);

const protoSource = readFileSync(protoPath, "utf8");

interface ParsedMessage {
  readonly name: string;
  readonly fields: ReadonlyMap<string, number>;
  readonly reservedNumbers: ReadonlySet<number>;
  readonly reservedNames: ReadonlySet<string>;
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

function parseMessages(source: string): ReadonlyMap<string, ParsedMessage> {
  const clean = stripComments(source);
  const messages = new Map<string, ParsedMessage>();
  const messageHeader = /\bmessage\s+(\w+)\s*\{/g;

  let header: RegExpExecArray | null;
  while ((header = messageHeader.exec(clean)) !== null) {
    const name = header[1]!;
    const bodyStart = messageHeader.lastIndex;
    let depth = 1;
    let index = bodyStart;
    while (index < clean.length && depth > 0) {
      const char = clean[index];
      if (char === "{") depth += 1;
      else if (char === "}") depth -= 1;
      index += 1;
    }
    const body = clean.slice(bodyStart, index - 1);

    const fields = new Map<string, number>();
    const reservedNumbers = new Set<number>();
    const reservedNames = new Set<string>();

    // Field declarations, including those nested inside a `oneof` block. Flatten
    // oneof wrappers so their member fields are attributed to the message, then
    // read one statement at a time.
    const flattened = body.replace(/\boneof\s+\w+\s*\{/g, "").replace(/\}/g, "");
    for (const statement of flattened.split(";")) {
      const trimmed = statement.trim();
      if (trimmed === "" || trimmed.startsWith("reserved")) continue;
      const field = trimmed.match(
        /^(?:repeated\s+|optional\s+)?[\w.]+\s+(\w+)\s*=\s*(\d+)\s*(?:\[[^\]]*\])?$/,
      );
      if (!field) continue;
      const fieldName = field[1]!;
      const fieldNumber = Number.parseInt(field[2]!, 10);
      if (fields.has(fieldName)) {
        throw new Error(`message ${name} declares field ${fieldName} more than once`);
      }
      fields.set(fieldName, fieldNumber);
    }

    const reservedPattern = /reserved\s+([^;]+);/g;
    let reserved: RegExpExecArray | null;
    while ((reserved = reservedPattern.exec(body)) !== null) {
      const spec = reserved[1]!.trim();
      if (spec.includes('"')) {
        for (const match of spec.matchAll(/"([^"]+)"/g)) {
          reservedNames.add(match[1]!);
        }
        continue;
      }
      for (const part of spec.split(",")) {
        const range = part.trim().match(/^(\d+)\s+to\s+(\d+)$/);
        if (range) {
          const start = Number.parseInt(range[1]!, 10);
          const end = Number.parseInt(range[2]!, 10);
          for (let value = start; value <= end; value += 1) reservedNumbers.add(value);
          continue;
        }
        const single = part.trim().match(/^\d+$/);
        if (single) reservedNumbers.add(Number.parseInt(part.trim(), 10));
      }
    }

    messages.set(name, { name, fields, reservedNumbers, reservedNames });
  }

  return messages;
}

function camelToSnake(value: string): string {
  return value.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
}

const messages = parseMessages(protoSource);

describe("runner protocol v1 proto schema", () => {
  it("declares the versioned package and streaming service", () => {
    const clean = stripComments(protoSource);
    expect(clean).toMatch(/package\s+qualigence\.runner\.v1\s*;/);
    expect(clean).toMatch(/syntax\s*=\s*"proto3"\s*;/);
    expect(clean).toMatch(/service\s+RunnerService\s*\{/);
    expect(clean).toMatch(
      /rpc\s+Connect\s*\(\s*stream\s+RunnerFrame\s*\)\s*returns\s*\(\s*stream\s+ServerFrame\s*\)\s*;/,
    );
  });

  it("assigns unique field numbers within every message", () => {
    expect(messages.size).toBeGreaterThan(0);
    for (const message of messages.values()) {
      const numbers = [...message.fields.values()];
      const unique = new Set(numbers);
      expect(unique.size, `duplicate field number in ${message.name}`).toBe(numbers.length);
    }
  });

  it("never reuses a reserved field number or name", () => {
    let sawReservation = false;
    for (const message of messages.values()) {
      if (message.reservedNumbers.size > 0 || message.reservedNames.size > 0) {
        sawReservation = true;
      }
      for (const [fieldName, fieldNumber] of message.fields) {
        expect(
          message.reservedNumbers.has(fieldNumber),
          `${message.name}.${fieldName} reuses reserved number ${fieldNumber}`,
        ).toBe(false);
        expect(
          message.reservedNames.has(fieldName),
          `${message.name}.${fieldName} reuses a reserved name`,
        ).toBe(false);
      }
    }
    expect(sawReservation, "the schema must reserve field numbers for forward evolution").toBe(true);
  });

  it("carries a wire field for every domain message field", () => {
    const hello: RunnerHello = {
      runnerId: "runner-1",
      runnerVersion: "0.1.0",
      supportedProtocolMajors: [1],
      capabilities: capabilities({ targetAdapters: ["web-playwright"] }),
      resumeToken: "resume-secret",
    };
    const welcome: RunnerWelcome = {
      sessionId: "session-1",
      resumeToken: "rotated",
      selectedProtocolMajor: 1,
      serverVersion: "0.1.0",
      heartbeatIntervalMs: 5_000,
      leaseDurationMs: 30_000,
      traceBatchMaximumEvents: 128,
      traceBatchMaximumBytes: 262_144,
      maximumInFlightBatches: 4,
      maximumPendingWriteBytes: 1_048_576,
    };
    const offer: ExecutionJobOffer = {
      offerId: "offer-1",
      job: {
        jobId: "job-1",
        runId: "run-attempt-1",
        projectId: "project-1",
        target: { kind: "web", url: "https://example.test/" },
        objective: "add the item to the cart",
        policy: { policyId: "policy-1", environment: "isolated_test", allowedOrigins: ["https://example.test"], allowedActionKinds: ["click"], maximumRisk: "Normal", explorationAllowed: false, issuedAt: "2026-08-18T00:00:00.000Z", expiresAt: "2026-08-18T00:01:00.000Z" },
      },
      requiredCapabilities: ["target:web-playwright"],
      leaseDurationMs: 30_000,
    };
    const lease: ExecutionJobLease = {
      jobId: "job-1",
      runId: "run-attempt-1",
      leaseToken: "secret",
      leaseEpoch: 3,
      expiresAt: "2026-08-01T10:00:00.000Z",
    };
    const batch: ExecutionEventBatch = {
      batchId: "batch-1",
      runId: "run-attempt-1",
      firstSequenceNumber: 1,
      events: [],
    };
    const ack: ExecutionEventAck = {
      batchId: "batch-1",
      runId: "run-attempt-1",
      nextExpectedSequenceNumber: 2,
    };

    const expectations: ReadonlyArray<readonly [string, object]> = [
      ["RunnerHello", hello],
      ["RunnerWelcome", welcome],
      ["ExecutionJobOffer", offer],
      ["ExecutionJobLease", lease],
      ["ExecutionEventBatch", batch],
      ["ExecutionEventAck", ack],
    ];

    for (const [messageName, sample] of expectations) {
      const message = messages.get(messageName);
      expect(message, `proto is missing message ${messageName}`).toBeDefined();
      for (const domainField of Object.keys(sample)) {
        const wireField = camelToSnake(domainField);
        expect(
          message!.fields.has(wireField),
          `${messageName} is missing wire field ${wireField} for domain field ${domainField}`,
        ).toBe(true);
      }
    }
  });

  it("carries the exact domain lease token on RenewLease", () => {
    const renewLease = messages.get("RenewLease");
    expect(renewLease, "proto is missing message RenewLease").toBeDefined();
    expect(renewLease!.fields.get("lease_token")).toBe(4);
  });

  it("freezes every ExecutionPolicySnapshot field and tag", () => {
    const policy = messages.get("ExecutionPolicySnapshot");
    expect(policy?.fields).toEqual(new Map([
      ["policy_id", 1], ["environment", 2], ["allowed_origins", 3], ["allowed_action_kinds", 4],
      ["maximum_risk", 5], ["exploration_allowed", 6], ["issued_at", 7], ["expires_at", 8],
    ]));
    expect(messages.get("AcceptedExecutionJob")?.fields.get("policy")).toBe(6);
    expect(messages.get("AcceptedExecutionJob")?.fields.get("project_id")).toBe(7);
  });

  it("adds indexed select and bounded scroll plan variants without reusing tags", () => {
    expect(messages.get("ExecutionPlanStep")?.fields).toEqual(new Map([
      ["step_index", 7], ["navigate", 1], ["click", 2], ["input", 3],
      ["verify", 4], ["select", 5], ["scroll", 6],
    ]));
    expect(messages.get("ExecutionPlanSelect")?.fields).toEqual(new Map([
      ["target", 1], ["value_ref", 2],
    ]));
    expect(messages.get("ExecutionPlanScroll")?.fields).toEqual(new Map([
      ["target", 1], ["direction", 2], ["amount", 3],
    ]));
    expect(messages.get("TraceEventEnvelope")?.fields.get("step_index")).toBe(11);
  });

  it("adds Desktop TargetRef structured AppTarget fields without changing the Web tag", () => {
    expect(messages.get("TargetRef")?.fields).toEqual(new Map([
      ["web", 1],
      ["desktop", 2],
    ]));
    expect(messages.get("DesktopTarget")?.fields).toEqual(new Map([["app", 1]]));
    expect(messages.get("AppTarget")?.fields).toEqual(new Map([
      ["target_id", 1],
      ["platform", 2],
      ["launch", 3],
      ["process", 4],
      ["window", 5],
      ["reset", 6],
      ["shutdown", 7],
    ]));
    expect(messages.get("AppTargetLaunch")?.fields).toEqual(new Map([
      ["executable", 1],
      ["args", 2],
      ["working_directory", 3],
    ]));
    expect(messages.get("AppTargetProcess")?.fields).toEqual(new Map([
      ["expected_image_name", 1],
      ["allowed_child_image_names", 2],
    ]));
    expect(messages.get("AppTargetWindow")?.fields).toEqual(new Map([
      ["title_pattern", 1],
      ["automation_id", 2],
    ]));
    expect(messages.get("AppTargetReset")?.fields).toEqual(new Map([
      ["command", 1],
      ["args", 2],
      ["timeout_ms", 3],
    ]));
    expect(messages.get("AppTargetShutdown")?.fields).toEqual(new Map([
      ["graceful_timeout_ms", 1],
      ["force_after_timeout", 2],
    ]));
  });
});

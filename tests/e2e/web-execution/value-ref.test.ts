import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryTraceStore, TraceIngestor } from "@qualigence/evidence";
import { InMemoryProtocolTraceRecorder } from "@qualigence/in-memory-runner-protocol";
import type { AcceptedExecutionJob, ObservationGraph } from "@qualigence/runner-protocol";
import {
  DeterministicRunnerPolicyGate,
  ExecutionRuntime,
  type VerificationContext,
} from "@qualigence/runner-kernel";
import { PlaywrightWebTargetAdapter, WebTargetError } from "@qualigence/web-playwright";
import { FileActionValueProvider } from "../../../apps/runner/src/action-value-provider.js";
import { htmlDocument, startFixtureServer, type FixtureServer } from "../../component/web-execution/fixtures.js";

const INPUT_VALUE = "e2e-private@example.test";
const SELECT_VALUE = "e2e-private-country-code";
const roots: string[] = [];
let fixture: FixtureServer | undefined;
let target: PlaywrightWebTargetAdapter | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  await target?.close();
  await fixture?.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  target = undefined;
  fixture = undefined;
});

function job(runId: string, actionKind: "input" | "select"): AcceptedExecutionJob {
  const origin = fixture!.origin;
  return {
    jobId: `job-${actionKind}`,
    runId,
    projectId: "project-value-ref-e2e",
    target: { kind: "web", url: fixture!.url },
    objective: `Exercise ${actionKind} through a valueRef`,
    policy: {
      policyId: `policy-${actionKind}`,
      environment: "isolated_test",
      allowedOrigins: [origin],
      allowedActionKinds: [actionKind],
      maximumRisk: "ExternalSideEffect",
      explorationAllowed: false,
      issuedAt: "2026-08-21T00:00:00.000Z",
      expiresAt: "2099-08-21T00:00:00.000Z",
    },
  };
}

function nodeId(graph: ObservationGraph, name: string): string {
  const node = graph.nodes.find((candidate) => candidate.name === name);
  if (node === undefined) throw new Error(`Expected visible node named ${name}.`);
  return node.id;
}

describe("production valueRef browser execution", () => {
  it("drives real Chromium input and select without exposing either plaintext value", async () => {
    fixture = await startFixtureServer({
      "/": htmlDocument(`
        <label>Email <input aria-label="Email" /></label>
        <label>Country
          <select aria-label="Country">
            <option value="">Choose a country</option>
            <option value="${SELECT_VALUE}">Canada</option>
          </select>
        </label>
        <p data-qualigence-observe id="status">Waiting for profile</p>
        <script>
          const email = document.querySelector('input');
          const country = document.querySelector('select');
          const status = document.getElementById('status');
          const update = () => {
            status.textContent = email.value !== '' && country.value !== ''
              ? 'Profile ready'
              : 'Waiting for profile';
          };
          email.addEventListener('input', update);
          country.addEventListener('change', update);
        </script>
      `, "ValueRef acceptance"),
    });

    const root = await mkdtemp(join(tmpdir(), "qualigence-value-ref-e2e-"));
    roots.push(root);
    await writeFile(join(root, "email.txt"), INPUT_VALUE, { mode: 0o600 });
    await writeFile(join(root, "country.txt"), SELECT_VALUE, { mode: 0o600 });
    if (process.platform !== "win32") {
      await chmod(join(root, "email.txt"), 0o600);
      await chmod(join(root, "country.txt"), 0o600);
    }
    const configFile = join(root, "values.json");
    await writeFile(configFile, JSON.stringify({
      "profile.email": "email.txt",
      "profile.country": "country.txt",
    }));
    const valueProvider = await FileActionValueProvider.open({ root, configFile });
    target = new PlaywrightWebTargetAdapter({
      url: fixture.url,
      headed: false,
      navigationTimeoutMs: 15_000,
      actionTimeoutMs: 10_000,
      allowedOrigins: [fixture.origin],
      valueProvider,
    });

    try {
      await target.start();
    } catch (error) {
      if (error instanceof WebTargetError && error.code === "BrowserLaunchFailed") {
        throw new Error("ChromiumUnavailable", { cause: error });
      }
      throw error;
    }

    const logs: string[] = [];
    const errors: unknown[] = [];
    const publicProjections: unknown[] = [];
    const verifierContexts: VerificationContext[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      logs.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      logs.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    const traces = new InMemoryTraceStore();
    const traceRecorder = new InMemoryProtocolTraceRecorder(new TraceIngestor(traces));

    const run = async (
      acceptedJob: AcceptedExecutionJob,
      kind: "input" | "select",
      accessibleName: string,
      valueRef: string,
    ) => {
      const runtime = new ExecutionRuntime({
        observer: target!,
        decisionProvider: {
          decide: async ({ observation }) => ({
            kind,
            target: { nodeId: nodeId(observation, accessibleName) },
            valueRef,
            reason: "ticket 18 browser acceptance",
          }) as never,
        },
        resolver: target!,
        policyGate: new DeterministicRunnerPolicyGate(acceptedJob.policy!),
        actionExecutor: target!,
        verifier: {
          verify: async (context) => {
            verifierContexts.push(context);
            return { status: "passed", summary: "visible state captured", claims: [] };
          },
        },
        traceRecorder,
        objectiveOnlyMaximumWallClockMs: 15_000,
        objectiveOnlyMaximumModelTokens: 100,
      });
      try {
        const completion = await runtime.run(acceptedJob);
        publicProjections.push(completion);
        return completion;
      } catch (error) {
        errors.push(error instanceof Error ? { name: error.name, message: error.message } : String(error));
        throw error;
      }
    };

    const inputJob = job("run-value-ref-input", "input");
    const selectJob = job("run-value-ref-select", "select");
    await expect(run(inputJob, "input", "Email", "profile.email")).resolves.toMatchObject({ status: "passed" });
    await expect(run(selectJob, "select", "Country", "profile.country")).resolves.toMatchObject({ status: "passed" });
    stdout.mockRestore();
    stderr.mockRestore();

    const inputTrace = traces.eventsFor(inputJob.runId);
    const selectTrace = traces.eventsFor(selectJob.runId);
    const finalObservation = selectTrace.filter((event) => event.stage === "observation").at(-1)?.payload;
    publicProjections.push(finalObservation);

    expect(inputTrace.find((event) => event.stage === "action_resolved")?.payload).toMatchObject({
      kind: "input",
      valueRef: "profile.email",
    });
    expect(selectTrace.find((event) => event.stage === "action_resolved")?.payload).toMatchObject({
      kind: "select",
      valueRef: "profile.country",
    });
    expect((finalObservation as ObservationGraph).nodes.some((node) => node.text === "Profile ready")).toBe(true);

    const serializedSecuritySurface = JSON.stringify({
      trace: [...inputTrace, ...selectTrace],
      findings: [...traces.findingsFor(inputJob.runId), ...traces.findingsFor(selectJob.runId)],
      errors,
      logs,
      publicProjections,
      verifierContexts,
    });
    expect(serializedSecuritySurface).not.toContain(INPUT_VALUE);
    expect(serializedSecuritySurface).not.toContain(SELECT_VALUE);
  }, 60_000);
});

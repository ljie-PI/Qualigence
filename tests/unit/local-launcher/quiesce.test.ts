import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseStopRequest, publishStopRequest, readRuntimeState, stopRequestMatchesTopology } from "../../../apps/local-launcher/src/runtime-state.js";

describe("detached stop marker", () => {
  it("accepts only the exact non-secret v1 topology tuple", () => {
    const marker = {
      version: "local-stop-request/v1",
      supervisorPid: 10,
      corePid: 11,
      runnerPid: 12,
      startedAt: "2026-08-19T00:00:00.000Z",
      requestedAt: "2026-08-19T00:00:01.000Z",
    };
    expect(parseStopRequest(marker)).toEqual(marker);
    expect(() => parseStopRequest({ ...marker, credential: "secret" })).toThrow();
    expect(() => parseStopRequest({ ...marker, runnerPid: 0 })).toThrow();
  });

  it("requires the exact topology tuple and bounded non-future freshness", () => {
    const marker = parseStopRequest({ version: "local-stop-request/v1", supervisorPid: 10, corePid: 11, runnerPid: 12, startedAt: "2026-08-19T00:00:00.000Z", requestedAt: "2026-08-19T00:00:10.000Z" });
    const topology = { supervisorPid: 10, corePid: 11, runnerPid: 12, startedAt: "2026-08-19T00:00:00.000Z" };
    expect(stopRequestMatchesTopology(marker, topology, Date.parse("2026-08-19T00:00:20.000Z"), 10_000)).toBe(true);
    expect(stopRequestMatchesTopology(marker, { ...topology, corePid: 99 }, Date.parse("2026-08-19T00:00:20.000Z"), 10_000)).toBe(false);
    expect(stopRequestMatchesTopology(marker, topology, Date.parse("2026-08-19T00:00:20.001Z"), 10_000)).toBe(false);
    expect(stopRequestMatchesTopology(marker, topology, Date.parse("2026-08-19T00:00:09.999Z"), 10_000)).toBe(false);
  });

  it("atomically replaces malformed or mismatched markers and makes concurrent matching callers idempotent", async () => {
    const directory = await mkdtemp(join(process.cwd(), ".tmp-stop-marker-"));
    const canonical = join(directory, "local-stop-request.json");
    const marker = parseStopRequest({ version: "local-stop-request/v1", supervisorPid: 10, corePid: 11, runnerPid: 12, startedAt: "2026-08-19T00:00:00.000Z", requestedAt: "2026-08-19T00:00:10.000Z" });
    try {
      await writeFile(canonical, "not json");
      await publishStopRequest(directory, marker);
      expect(parseStopRequest(JSON.parse(await readFile(canonical, "utf8")))).toEqual(marker);

      await writeFile(canonical, JSON.stringify({ ...marker, corePid: 99 }));
      await Promise.all([publishStopRequest(directory, marker), publishStopRequest(directory, marker)]);
      expect(parseStopRequest(JSON.parse(await readFile(canonical, "utf8")))).toEqual(marker);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects malformed runtime state instead of using it as stop topology authority", async () => {
    const directory = await mkdtemp(join(process.cwd(), ".tmp-runtime-state-"));
    try {
      await writeFile(join(directory, "runtime-state.json"), JSON.stringify({ supervisorPid: 10, corePid: 11, runnerPid: 12, corePort: 50555, dataDir: directory, startedAt: "2026-08-19T00:00:00.000Z", credential: "forbidden" }));
      await expect(readRuntimeState(directory)).resolves.toBeUndefined();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

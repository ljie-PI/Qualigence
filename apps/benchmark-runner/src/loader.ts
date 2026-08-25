import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  assertGroundTruthConsistent,
  parseGroundTruth,
  parseManifest,
  type DetectionBenchmarkManifest,
  type GroundTruth,
} from "@qualigence/benchmarking-detection";
import { parseScenario, type ScenarioDefinition } from "./scenario.js";

/** A fully-loaded, validated benchmark ready to run. */
export interface LoadedBenchmark {
  readonly manifest: DetectionBenchmarkManifest;
  readonly groundTruth: GroundTruth;
  readonly scenarios: readonly ScenarioDefinition[];
}

async function readJson(path: string): Promise<unknown> {
  const contents = await readFile(path, "utf8");
  return JSON.parse(contents);
}

function resolveRef(baseDir: string, ref: string): string {
  return isAbsolute(ref) ? ref : join(baseDir, ref);
}

/**
 * Load and validate a benchmark from a directory containing `manifest.json`, the
 * per-scenario fixtures referenced by each scenario's `missionRef`, and the
 * ground-truth file referenced by `groundTruthRef`. Every input is strictly
 * parsed; a malformed manifest, scenario or ground truth throws before any run.
 */
export async function loadBenchmark(benchmarkDir: string): Promise<LoadedBenchmark> {
  const baseDir = resolve(benchmarkDir);
  const manifest = parseManifest(await readJson(join(baseDir, "manifest.json")));

  const groundTruthRefs = new Set(manifest.scenarios.map((scenario) => scenario.groundTruthRef));
  if (groundTruthRefs.size !== 1) {
    throw new Error("Detection Benchmark v1 expects every scenario to share one ground-truth file.");
  }
  const [groundTruthRef] = [...groundTruthRefs];
  const groundTruth = parseGroundTruth(await readJson(resolveRef(baseDir, groundTruthRef!)));
  assertGroundTruthConsistent(manifest, groundTruth);

  const scenarios: ScenarioDefinition[] = [];
  for (const scenario of manifest.scenarios) {
    const definition = parseScenario(await readJson(resolveRef(baseDir, scenario.missionRef)));
    if (definition.scenarioId !== scenario.scenarioId) {
      throw new Error(
        `Scenario fixture "${scenario.missionRef}" declares id "${definition.scenarioId}" ` +
          `but the manifest references "${scenario.scenarioId}".`,
      );
    }
    if (definition.mode !== scenario.mode) {
      throw new Error(
        `Scenario "${scenario.scenarioId}" mode "${definition.mode}" does not match manifest mode "${scenario.mode}".`,
      );
    }
    scenarios.push(definition);
  }

  return { manifest, groundTruth, scenarios };
}

/** Resolve the directory that contains a given manifest path. */
export function benchmarkDirOfManifest(manifestPath: string): string {
  return dirname(resolve(manifestPath));
}

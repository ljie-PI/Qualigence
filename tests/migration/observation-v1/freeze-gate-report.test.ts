import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildFreezeReport,
  buildFreezeGateReport,
  finalizeGraphFreezeFromEvidence,
  generateAutomatedFreezeGateReport,
  OBSERVATION_FREEZE_GATE_REPORT_VERSION,
  REQUIRED_SECURITY_VETO_ITEM_IDS,
  REQUIRED_SHARED_CORE_FIELDS,
  WINDOWS_M3_CHECKLIST_VERSION,
  type ObservationFreezeReportV1,
  type ObservationMigrationResult,
  type SchemaConformanceEvidence,
  type WindowsChecklistEvidence,
} from "@qualigence/observation-migration";

const NOW = () => "2026-08-02T00:00:00.000Z";
const fixtureRoots: string[] = [];
const FINALIZER_FIXTURE_ROOT = join(
  process.cwd(),
  "tests",
  "fixtures",
  "migration",
  "observation-v1",
  "freeze-finalizer",
);
const FINALIZER_COMMIT = "aca8a487268ef6baab644ff47401efc85b1d1a26";
const CLOSURE_ISSUES = [
  140, 145, 143, 136, 139, 138, 141, 135, 137, 144, 134, 142, 157, 147, 155,
  150, 152, 153, 156, 149, 148, 151, 146, 154, 163, 159, 160, 167, 168, 161,
  164, 158, 166, 169, 165,
] as const;
const CLOSURE_DEPENDENCIES = [
  [],
  [1],
  [2, 36],
  [3, 38],
  [4],
  [3],
  [5, 6, 20],
  [7],
  [8],
  [9],
  [10, 16],
  [11],
  [12],
  [13],
  [14],
  [1],
  [16],
  [17, 37],
  [18],
  [6, 19],
  [20],
  [19],
  [22],
  [21, 23],
  [24],
  [25],
  [26],
  [27],
  [28],
  [29],
  [],
  [],
  [32],
  [33],
  [34],
] as const;
const REMEDIATION_ISSUES = [
  162, 176, 172, 170, 177, 174, 173, 175, 178, 180, 179, 171,
] as const;
const NESTED_EVIDENCE_FIXTURES: Readonly<Record<string, readonly string[]>> = {
  "graph-conformance.json": [
    "graph-web-report.json",
    "graph-desktop-report.json",
    "graph-negotiation-report.json",
  ],
  "native-reports.json": [
    "native-ticket-29-report.json",
    "native-ticket-30-report.json",
  ],
  "provider.json": [
    "provider-smoke-report.json",
    "provider-redaction-stdout.json",
    "provider-redaction-stderr.json",
    "provider-redaction-summaries.json",
    "provider-redaction-artifacts.json",
    "provider-redaction-local-files.json",
  ],
};

function finalizerInput(
  repositoryRoot: string,
  overrides: Partial<{
    decidedAt: string;
    evidence: Record<string, { path: string; sha256: string }>;
    signal: AbortSignal;
  }> = {},
) {
  return {
    repositoryRoot,
    repository: "ljie-PI/Qualigence",
    version: "v0.1.0-candidate",
    commit: FINALIZER_COMMIT,
    decidedAt: overrides.decidedAt ?? "2026-08-30T08:00:00.000Z",
    evidence: overrides.evidence ?? {},
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
  };
}

function mutableRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

async function readFixtureObject(
  filename: string,
): Promise<Record<string, unknown>> {
  return mutableRecord(
    JSON.parse(await readFile(join(FINALIZER_FIXTURE_ROOT, filename), "utf8")),
    filename,
  );
}

function gitSha(index: number): string {
  return index.toString(16).padStart(40, "0");
}

function closurePullRequest(legacyTicket: number, pullRequestNumber: number) {
  const head = gitSha(100 + legacyTicket);
  return {
    number: pullRequestNumber,
    url: `https://github.com/ljie-PI/Qualigence/pull/${pullRequestNumber}`,
    state: "closed",
    mergedAt: "2026-08-29T00:00:00.000Z",
    reviewedHead: head,
    remoteHead: head,
    mergeCommit: gitSha(200 + legacyTicket),
    changedFiles: ["packages/observation-migration/src/index.ts"],
    requiredChecks: ["focused-gate"],
    checks: [
      {
        name: "focused-gate",
        conclusion: "success",
        commit: head,
      },
    ],
  };
}

function githubClosureFixture() {
  const tickets = CLOSURE_ISSUES.map((issueNumber, index) => {
    const legacyTicket = index + 1;
    if (legacyTicket === 31) {
      return {
        legacyTicket,
        issue: {
          number: issueNumber,
          parentIssue: 67,
          state: "closed",
          status: "superseded",
          todoTotal: 10,
          todoCompleted: 0,
          blockedBy: CLOSURE_DEPENDENCIES[index],
          supersededBy: 48,
        },
      };
    }
    return {
      legacyTicket,
      issue: {
        number: issueNumber,
        parentIssue: 67,
        state: "closed",
        status: "resolved",
        todoTotal: 4,
        todoCompleted: 4,
        blockedBy: CLOSURE_DEPENDENCIES[index],
      },
      pullRequest: closurePullRequest(legacyTicket, 300 + legacyTicket),
    };
  });
  const closurePullRequests = tickets.flatMap((item) =>
    "pullRequest" in item && item.pullRequest !== undefined
      ? [item.pullRequest]
      : [],
  );
  const remediation = REMEDIATION_ISSUES.map((issueNumber, index) => {
    const legacyTicket = index + 36;
    if (legacyTicket === 46) {
      return {
        legacyTicket,
        issue: {
          number: issueNumber,
          parentIssue: 67,
          state: "closed",
          status: "superseded",
        },
        classification: "superseded",
        parentLegacyTicket: 35,
        supersededBy: 48,
        blocking: false,
      };
    }
    return {
      legacyTicket,
      issue: {
        number: issueNumber,
        parentIssue: 67,
        state: "closed",
        status: "resolved",
      },
      classification: "resolved-remediation",
      parentLegacyTicket: 35,
      blocking: false,
      pullRequest: closurePullRequest(legacyTicket, 400 + legacyTicket),
    };
  });
  const remediationPullRequests = remediation.flatMap((item) =>
    "pullRequest" in item && item.pullRequest !== undefined
      ? [item.pullRequest]
      : [],
  );
  return {
    schemaVersion: "qualigence-github-closure-evidence/v1",
    repository: "ljie-PI/Qualigence",
    version: "v0.1.0-candidate",
    commit: FINALIZER_COMMIT,
    generatedAt: "2026-08-30T07:30:00.000Z",
    evidenceClass: "real",
    umbrellaIssue: 67,
    tickets,
    remediation,
    integratedAcceptance: {
      legacyTicket: 48,
      issue: {
        number: 181,
        parentIssue: 67,
        state: "open",
        status: "claimed",
        blockedBy: [35],
      },
      authority: "integrated-human-acceptance",
      blocking: false,
    },
    commitGraph: [
      {
        sha: FINALIZER_COMMIT,
        parents: [
          ...closurePullRequests.map((pullRequest) => pullRequest.mergeCommit),
          ...remediationPullRequests.map(
            (pullRequest) => pullRequest.mergeCommit,
          ),
        ],
      },
      ...closurePullRequests.flatMap((pullRequest) => [
        {
          sha: pullRequest.mergeCommit,
          parents: [pullRequest.remoteHead],
        },
        {
          sha: pullRequest.remoteHead,
          parents: [],
        },
      ]),
      ...remediationPullRequests.flatMap((pullRequest) => [
        {
          sha: pullRequest.mergeCommit,
          parents: [pullRequest.remoteHead],
        },
        {
          sha: pullRequest.remoteHead,
          parents: [],
        },
      ]),
    ],
  };
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipStore(entries: Readonly<Record<string, string>>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [path, content] of Object.entries(entries)) {
    const name = Buffer.from(path, "utf8");
    const data = Buffer.from(content, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralSize = centrals.reduce((sum, chunk) => sum + chunk.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

function attestationBundle(
  subjectName: string,
  digest: string,
  predicateType: string,
): string {
  const payload = {
    _type: "https://in-toto.io/Statement/v1",
    predicateType,
    subject: [
      {
        name: subjectName,
        digest: { sha256: digest.slice("sha256:".length) },
      },
    ],
    predicate: {
      buildDefinition: {
        externalParameters: {
          repository: "ljie-PI/Qualigence",
          commit: FINALIZER_COMMIT,
        },
      },
    },
  };
  return `${JSON.stringify(
    {
      dsseEnvelope: {
        payload: Buffer.from(JSON.stringify(payload), "utf8").toString(
          "base64",
        ),
        signatures: [{ sig: "fixture" }],
      },
    },
    null,
    2,
  )}\n`;
}

async function writeEvidenceObject(
  repositoryRoot: string,
  version: string,
  filename: string,
  value: unknown,
  copyDependencies = true,
  refreshDependencyHashes = copyDependencies,
) {
  const path = `artifacts/release/${version}/${filename}`;
  const materializedValue = structuredClone(value);
  await mkdir(join(repositoryRoot, "artifacts", "release", version), {
    recursive: true,
  });
  const dependencyHashes = new Map<string, string>();
  if (copyDependencies) {
    for (const dependency of NESTED_EVIDENCE_FIXTURES[filename] ?? []) {
      const dependencyBytes = await readFile(
        join(FINALIZER_FIXTURE_ROOT, dependency),
      );
      await writeFile(
        join(repositoryRoot, "artifacts", "release", version, dependency),
        dependencyBytes,
      );
      dependencyHashes.set(dependency, sha256(dependencyBytes));
    }
  }
  if (refreshDependencyHashes) {
    const refresh = (candidate: unknown): void => {
      if (Array.isArray(candidate)) {
        candidate.forEach(refresh);
        return;
      }
      if (candidate === null || typeof candidate !== "object") {
        return;
      }
      const record = candidate as Record<string, unknown>;
      if (typeof record["path"] === "string") {
        const dependency = record["path"].split("/").at(-1);
        const hash =
          dependency === undefined
            ? undefined
            : dependencyHashes.get(dependency);
        if (hash !== undefined) {
          record["sha256"] = hash;
        }
      }
      Object.values(record).forEach(refresh);
    };
    refresh(materializedValue);
  }
  const bytes = Buffer.from(
    `${JSON.stringify(materializedValue, null, 2)}\n`,
    "utf8",
  );
  await writeFile(join(repositoryRoot, ...path.split("/")), bytes);
  return {
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function writeReleaseFixture(
  repositoryRoot: string,
  version: string,
): Promise<{ path: string; sha256: string }> {
  const releaseRoot = join(repositoryRoot, "artifacts", "release", version);
  const gateRoot = join(releaseRoot, "gate-artifacts");
  await mkdir(gateRoot, { recursive: true });
  await mkdir(join(repositoryRoot, "scripts"), { recursive: true });
  await writeFile(
    join(repositoryRoot, "scripts", "verify-release-manifest.mjs"),
    await readFile(
      join(process.cwd(), "scripts", "verify-release-manifest.mjs"),
    ),
  );

  const digestA = `sha256:${"a".repeat(64)}`;
  const digestB = `sha256:${"b".repeat(64)}`;
  const applicationName = "ghcr.io/ljie-pi/qualigence/self-hosted";
  const consoleName = "ghcr.io/ljie-pi/qualigence/self-hosted-console";
  const applicationReference = `${applicationName}@${digestA}`;
  const consoleReference = `${consoleName}@${digestB}`;
  const sbomPath = `artifacts/release/${version}/sbom.spdx.json`;
  const windowsPath = `artifacts/release/${version}/windows-checklist.signed.json`;
  const sbom = `${JSON.stringify(
    {
      spdxVersion: "SPDX-2.3",
      SPDXID: "SPDXRef-DOCUMENT",
      name: "freeze finalizer fixture",
      documentComment: JSON.stringify({
        repository: "ljie-PI/Qualigence",
        commit: FINALIZER_COMMIT,
        applicationReference,
        consoleReference,
      }),
      creationInfo: {
        created: "1970-01-01T00:00:00.000Z",
        creators: ["Tool: fixture"],
      },
    },
    null,
    2,
  )}\n`;
  await writeFile(join(repositoryRoot, ...sbomPath.split("/")), sbom);

  const operatorSignature = "fixture-signature-human-a";
  const reviewerSignature = "fixture-signature-human-b";
  const windows = `${JSON.stringify(
    {
      WindowsChecklistEvidence: {
        checklistVersion: "windows-m3-manual-checklist/v1",
        commit: FINALIZER_COMMIT,
        productVersion: version,
        runnerProtocolVersion: "runner-protocol/v1",
        windowsBuild: "Windows 11 23H2 22631",
        interactiveSessionType: "local",
        operatorName: "human-a",
        reviewerName: "human-b",
        executedAt: "2026-08-29T00:00:00.000Z",
        evidenceRefs: [
          "run:windows-native-local",
          "run:windows-native-rdp",
          "artifact:windows-native-1",
        ],
        sessionEvidence: {
          local: ["run:windows-native-local"],
          rdp: ["run:windows-native-rdp"],
        },
        securityVetoItemIds: [...REQUIRED_SECURITY_VETO_ITEM_IDS],
        items: REQUIRED_SECURITY_VETO_ITEM_IDS.map((id) => ({
          section: "16",
          id,
          description: id,
          result: "pass",
          note: "fixture evidence ref",
        })),
      },
      WindowsChecklistSignatures: [
        {
          signer: "human-a",
          signedAt: "2026-08-29T00:00:00.000Z",
          signature: operatorSignature,
          signatureSha256: sha256(operatorSignature),
        },
        {
          signer: "human-b",
          signedAt: "2026-08-29T00:00:00.000Z",
          signature: reviewerSignature,
          signatureSha256: sha256(reviewerSignature),
        },
      ],
    },
    null,
    2,
  )}\n`;
  await writeFile(join(repositoryRoot, ...windowsPath.split("/")), windows);

  const gates = [
    "gate-linux",
    "gate-windows-rust",
    "gate-self-hosted",
    "browser-e2e",
  ] as const;
  const gateArchives = new Map<
    string,
    {
      path: string;
      sha256: string;
      reportSha256: string;
      vitestSha256: string;
      receiptSha256: string;
    }
  >();
  for (const name of gates) {
    const vitest = `${JSON.stringify({
      numPassedTests: 1,
      numFailedTests: 0,
      numPendingTests: 0,
      numTodoTests: 0,
    })}\n`;
    const report = `${JSON.stringify(
      {
        schemaVersion: "qualigence-gate-report/v1",
        gate: name,
        commit: FINALIZER_COMMIT,
        command: ["pnpm", "vitest", "run"],
        selection: ["tests"],
        counts: { passed: 1, failed: 0, skipped: 0, todo: 0 },
        status: "passed",
        environment: {},
        files: [
          {
            path: "vitest.json",
            sha256: sha256(vitest),
            bytes: Buffer.byteLength(vitest),
          },
        ],
      },
      null,
      2,
    )}\n`;
    const marker = `${JSON.stringify(
      {
        schemaVersion: "qualigence-gate-accepted/v1",
        gate: name,
        commit: FINALIZER_COMMIT,
        report: "report.json",
        reportSha256: sha256(report),
        status: "accepted",
      },
      null,
      2,
    )}\n`;
    const hashManifest =
      `${sha256(report)}  ${name}/report.json\n` +
      `${sha256(marker)}  ${name}/accepted.json\n` +
      `${sha256(vitest)}  ${name}/vitest.json\n`;
    const receipt = `${JSON.stringify(
      {
        schemaVersion: "qualigence-gate-artifact-receipt/v1",
        gate: name,
        commit: FINALIZER_COMMIT,
        report: `${name}/report.json`,
        reportSha256: sha256(report),
        marker: `${name}/accepted.json`,
        markerSha256: sha256(marker),
        hashManifest: "sha256.txt",
        hashManifestSha256: sha256(hashManifest),
      },
      null,
      2,
    )}\n`;
    const archive = zipStore({
      "receipt.json": receipt,
      [`${name}/report.json`]: report,
      [`${name}/accepted.json`]: marker,
      [`${name}/vitest.json`]: vitest,
      "sha256.txt": hashManifest,
    });
    const path = `artifacts/release/${version}/gate-artifacts/${name}.zip`;
    await writeFile(join(repositoryRoot, ...path.split("/")), archive);
    gateArchives.set(name, {
      path,
      sha256: sha256(archive),
      reportSha256: sha256(report),
      vitestSha256: sha256(vitest),
      receiptSha256: sha256(receipt),
    });
  }

  const deliveries = gates.map((name, index) => {
    const archive = gateArchives.get(name);
    if (archive === undefined) {
      throw new Error(`missing ${name} fixture archive`);
    }
    return {
      gate: name,
      artifactName: `${name}.zip`,
      artifactId: String(index + 100),
      runId: String(index + 200),
      commit: FINALIZER_COMMIT,
      reportSha256: archive.reportSha256,
      vitestSha256: archive.vitestSha256,
      receiptSha256: archive.receiptSha256,
    };
  });
  const provenance = (name: string, digest: string, label: string) => {
    const bundle = attestationBundle(
      name,
      digest,
      "https://slsa.dev/provenance/v1",
    );
    const sbomBundle = attestationBundle(
      name,
      digest,
      "https://spdx.dev/Document",
    );
    return {
      attestationId: `https://github.com/ljie-PI/Qualigence/attestations/${label}`,
      bundle,
      bundleSha256: sha256(bundle),
      sbomAttestationId: `https://github.com/ljie-PI/Qualigence/attestations/${label}-sbom`,
      sbomBundle,
      sbomBundleSha256: sha256(sbomBundle),
    };
  };
  const manifest = {
    schemaVersion: "qualigence-release-manifest/v1",
    version,
    repository: "ljie-PI/Qualigence",
    commit: FINALIZER_COMMIT,
    generatedAt: "2026-08-29T00:00:00.000Z",
    images: {
      application: {
        name: applicationName,
        digest: digestA,
        reference: applicationReference,
        provenance: provenance(applicationName, digestA, "application"),
      },
      console: {
        name: consoleName,
        digest: digestB,
        reference: consoleReference,
        provenance: provenance(consoleName, digestB, "console"),
      },
    },
    sbom: { path: sbomPath, sha256: sha256(sbom), format: "spdx-json" },
    gateEvidence: {
      schemaVersion: "qualigence-release-gate-evidence/v1",
      commit: FINALIZER_COMMIT,
      status: "verified",
      deliveries,
      rejectedDeliveries: [],
    },
    gates: deliveries.map((delivery) => {
      const archive = gateArchives.get(delivery.gate);
      if (archive === undefined) {
        throw new Error(`missing ${delivery.gate} fixture archive`);
      }
      return {
        name: delivery.gate,
        artifactName: delivery.artifactName,
        artifactPath: archive.path,
        artifactSha256: archive.sha256,
        artifactId: delivery.artifactId,
        runId: delivery.runId,
        commit: FINALIZER_COMMIT,
        reportSha256: delivery.reportSha256,
        vitestSha256: delivery.vitestSha256,
        receiptSha256: delivery.receiptSha256,
      };
    }),
    windowsEvidence: {
      path: windowsPath,
      sha256: sha256(windows),
      commit: FINALIZER_COMMIT,
      signatures: [
        {
          signer: "human-a",
          signedAt: "2026-08-29T00:00:00.000Z",
          signatureSha256: sha256(operatorSignature),
        },
        {
          signer: "human-b",
          signedAt: "2026-08-29T00:00:00.000Z",
          signatureSha256: sha256(reviewerSignature),
        },
      ],
    },
  };
  return writeEvidenceObject(
    repositoryRoot,
    version,
    "release-manifest.json",
    manifest,
  );
}

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((root) =>
      rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      }),
    ),
  );
});

function migratedResult(assetId: string): ObservationMigrationResult {
  return {
    assetId,
    sourceHash: `hash-${assetId}`,
    status: "migrated",
    outputRef: `ref-${assetId}`,
    migratorVersion: "observation-migrator/v1",
  };
}

function cleanCandidateReport(): ObservationFreezeReportV1 {
  return buildFreezeReport([migratedResult("a"), migratedResult("b")], NOW);
}

function validSchemaConformanceEvidence(): SchemaConformanceEvidence {
  return {
    schemaVersion: "observation-graph/v1",
    webValidatesV1: true,
    desktopValidatesV1: true,
    sharedCoreFields: [...REQUIRED_SHARED_CORE_FIELDS],
  };
}

function validWindowsChecklistEvidence(): WindowsChecklistEvidence {
  return {
    checklistVersion: WINDOWS_M3_CHECKLIST_VERSION,
    productVersion: "2026.08.02",
    runnerProtocolVersion: "runner-protocol/1",
    windowsBuild: "26100.1742",
    interactiveSessionType: "local",
    operatorName: "Grace Hopper",
    reviewerName: "Alan Turing",
    executedAt: "2026-08-02T09:30:00.000Z",
    evidenceRefs: ["run://win-m3/2026-08-02"],
    securityVetoItemIds: [...REQUIRED_SECURITY_VETO_ITEM_IDS],
    items: REQUIRED_SECURITY_VETO_ITEM_IDS.map((id) => ({
      section: "16",
      id,
      description: `security veto ${id}`,
      result: "pass" as const,
    })),
  };
}

describe("generateAutomatedFreezeGateReport (this automated PR / Linux sandbox)", () => {
  it("honestly reports candidate — there is no real Windows sign-off here", () => {
    const report = generateAutomatedFreezeGateReport(
      cleanCandidateReport(),
      validSchemaConformanceEvidence(),
      NOW,
    );

    expect(report.version).toBe(OBSERVATION_FREEZE_GATE_REPORT_VERSION);
    expect(report.environment).toBe("automated-linux-ci");
    expect(report.status).toBe("candidate");
    expect(report.decision.status).toBe("candidate");
    expect(report.decision.inputs.windowsChecklistValid).toBe(false);
    expect(report.decision.signoff).toBeUndefined();
    expect(report.limitations.length).toBeGreaterThan(0);
    expect(report.limitations.join(" ")).toMatch(/Windows/i);
  });

  it("CANNOT LIE about being frozen — even with perfect automated evidence", () => {
    // The automated generator structurally has no way to supply signed Windows
    // evidence, so its output can never be `frozen`, no matter the other inputs.
    const report = generateAutomatedFreezeGateReport(
      cleanCandidateReport(),
      validSchemaConformanceEvidence(),
      NOW,
    );

    expect(report.status).not.toBe("frozen");
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('"status":"frozen"');
  });
});

describe("buildFreezeGateReport (the full evidence-driven generator)", () => {
  it("stays candidate when Windows evidence is absent", () => {
    const report = buildFreezeGateReport(
      {
        environment: "manual-windows-signoff",
        candidateReport: cleanCandidateReport(),
        webConformanceEvidence: validSchemaConformanceEvidence(),
      },
      NOW,
    );

    expect(report.status).toBe("candidate");
  });

  it("only reports frozen when a real signed manual checklist is supplied", () => {
    // This proves the report machinery is genuine, not hardcoded to candidate:
    // a fully-evidenced manual sign-off (which a human produces on real Windows
    // hardware) DOES yield frozen.
    const report = buildFreezeGateReport(
      {
        environment: "manual-windows-signoff",
        candidateReport: cleanCandidateReport(),
        windowsChecklistEvidence: validWindowsChecklistEvidence(),
        webConformanceEvidence: validSchemaConformanceEvidence(),
      },
      NOW,
    );

    expect(report.status).toBe("frozen");
    expect(report.decision.status).toBe("frozen");
    expect(report.decision.signoff?.operatorName).toBe("Grace Hopper");
    expect(report.limitations).toEqual([]);
  });
});

describe("finalizeGraphFreezeFromEvidence", () => {
  it("atomically writes an honest candidate artifact when Ticket 48 evidence is absent", async () => {
    const fixturePath = join(
      process.cwd(),
      "tests",
      "fixtures",
      "migration",
      "observation-v1",
      "freeze-finalizer",
      "missing-ticket-48.json",
    );
    const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as {
      readonly repository: string;
      readonly version: string;
      readonly commit: string;
      readonly decidedAt: string;
      readonly evidence: {};
    };
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "qualigence-freeze-candidate-"),
    );
    fixtureRoots.push(repositoryRoot);

    const result = await finalizeGraphFreezeFromEvidence({
      ...fixture,
      repositoryRoot,
    });

    expect(result.path).toBe(
      join(
        repositoryRoot,
        "artifacts",
        "release",
        fixture.version,
        "graph-freeze-decision.json",
      ),
    );
    expect(result.decision.status).toBe("candidate");
    expect(result.decision.signoff).toBeUndefined();
    expect(result.decision.blockingReasons).toEqual([
      "EvidenceMissing: benchmark",
      "EvidenceMissing: candidate-migration",
      "EvidenceMissing: github-closure",
      "EvidenceMissing: graph-conformance",
      "EvidenceMissing: native-reports",
      "EvidenceMissing: provider",
      "EvidenceMissing: release-manifest",
      "EvidenceMissing: required-ci",
      "EvidenceMissing: sbom-provenance",
      "EvidenceMissing: windows-checklist",
    ]);
    expect(JSON.parse(await readFile(result.path, "utf8"))).toEqual(
      result.decision,
    );
  });

  it("validates a serialized candidate migration report from confined hashed bytes", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "qualigence-freeze-migration-"),
    );
    fixtureRoots.push(repositoryRoot);
    const version = "v0.1.0-candidate";
    const relativePath = `artifacts/release/${version}/candidate-migration.json`;
    const target = join(repositoryRoot, ...relativePath.split("/"));
    await mkdir(join(repositoryRoot, "artifacts", "release", version), {
      recursive: true,
    });
    const fixture = await readFile(
      join(
        process.cwd(),
        "tests",
        "fixtures",
        "migration",
        "observation-v1",
        "freeze-finalizer",
        "candidate-migration.json",
      ),
    );
    await writeFile(target, fixture);

    const result = await finalizeGraphFreezeFromEvidence({
      repositoryRoot,
      repository: "ljie-PI/Qualigence",
      version,
      commit: "aca8a487268ef6baab644ff47401efc85b1d1a26",
      decidedAt: "2026-08-30T08:00:00.000Z",
      evidence: {
        candidateMigration: {
          path: relativePath,
          sha256: createHash("sha256").update(fixture).digest("hex"),
        },
      },
    });

    expect(result.decision.status).toBe("candidate");
    expect(result.decision.blockingReasons).not.toContain(
      "EvidenceMissing: candidate-migration",
    );
    expect(
      result.decision.capabilities.find(
        (capability) => capability.id === "candidate-migration",
      ),
    ).toMatchObject({
      status: "verified",
      blockers: [],
      evidence: [{ path: relativePath }],
    });
  });

  it("validates shared Web/Desktop Graph v1 and both native Windows reports", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "qualigence-freeze-native-"),
    );
    fixtureRoots.push(repositoryRoot);
    const version = "v0.1.0-candidate";
    const evidence: Record<string, { path: string; sha256: string }> = {};
    await mkdir(join(repositoryRoot, "artifacts", "release", version), {
      recursive: true,
    });
    for (const [key, filename] of [
      ["graphConformance", "graph-conformance.json"],
      ["nativeReports", "native-reports.json"],
    ] as const) {
      evidence[key] = await writeEvidenceObject(
        repositoryRoot,
        version,
        filename,
        await readFixtureObject(filename),
      );
    }

    const result = await finalizeGraphFreezeFromEvidence({
      repositoryRoot,
      repository: "ljie-PI/Qualigence",
      version,
      commit: "aca8a487268ef6baab644ff47401efc85b1d1a26",
      decidedAt: "2026-08-30T08:00:00.000Z",
      evidence,
    });

    for (const id of ["graph-conformance", "native-reports"]) {
      expect(
        result.decision.capabilities.find((capability) => capability.id === id),
      ).toMatchObject({ status: "verified", blockers: [] });
    }
  });

  it("rejects an unsupported Graph schema major in the hashed target report", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "qualigence-freeze-graph-major-"),
    );
    fixtureRoots.push(repositoryRoot);
    const version = "v0.1.0-candidate";
    const webReport = await readFixtureObject("graph-web-report.json");
    webReport["graphSchemaVersion"] = "observation-graph/v2";
    const webReference = await writeEvidenceObject(
      repositoryRoot,
      version,
      "graph-web-report.json",
      webReport,
    );
    const graphEvidence = await readFixtureObject("graph-conformance.json");
    graphEvidence["web"] = webReference;
    const reference = await writeEvidenceObject(
      repositoryRoot,
      version,
      "graph-conformance.json",
      graphEvidence,
      false,
    );

    const result = await finalizeGraphFreezeFromEvidence(
      finalizerInput(repositoryRoot, {
        evidence: { graphConformance: reference },
      }),
    );

    expect(result.decision.blockingReasons).toContain(
      "GraphConformanceInvalid: graph-conformance",
    );
  });

  it("rejects a Graph target index whose report hash does not match bytes", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "qualigence-freeze-graph-report-hash-"),
    );
    fixtureRoots.push(repositoryRoot);
    const graphEvidence = await readFixtureObject("graph-conformance.json");
    mutableRecord(graphEvidence["web"], "Graph web report reference")[
      "sha256"
    ] = "f".repeat(64);
    const reference = await writeEvidenceObject(
      repositoryRoot,
      "v0.1.0-candidate",
      "graph-conformance.json",
      graphEvidence,
      true,
      false,
    );

    const result = await finalizeGraphFreezeFromEvidence(
      finalizerInput(repositoryRoot, {
        evidence: { graphConformance: reference },
      }),
    );

    expect(result.decision.blockingReasons).toContain(
      "EvidenceHashMismatch: graph-conformance",
    );
  });

  it("rejects a portable substitute in the hashed native report", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "qualigence-freeze-native-portable-"),
    );
    fixtureRoots.push(repositoryRoot);
    const version = "v0.1.0-candidate";
    const nativeReport = await readFixtureObject(
      "native-ticket-29-report.json",
    );
    nativeReport["environment"] = "portable-test";
    const nativeReference = await writeEvidenceObject(
      repositoryRoot,
      version,
      "native-ticket-29-report.json",
      nativeReport,
    );
    const nativeEvidence = await readFixtureObject("native-reports.json");
    const reports = nativeEvidence["reports"];
    if (!Array.isArray(reports) || reports[0] === undefined) {
      throw new Error("native fixture has no report");
    }
    mutableRecord(reports[0], "native report reference")["report"] =
      nativeReference;
    const reference = await writeEvidenceObject(
      repositoryRoot,
      version,
      "native-reports.json",
      nativeEvidence,
      false,
    );

    const result = await finalizeGraphFreezeFromEvidence(
      finalizerInput(repositoryRoot, {
        evidence: { nativeReports: reference },
      }),
    );

    expect(result.decision.blockingReasons).toContain(
      "NativeReportInvalid: native-reports",
    );
  });

  it("validates the complete serialized GitHub ticket graph, merged PRs, checks, and ancestry", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "qualigence-freeze-github-"),
    );
    fixtureRoots.push(repositoryRoot);
    const version = "v0.1.0-candidate";
    const githubClosure = await writeEvidenceObject(
      repositoryRoot,
      version,
      "github-closure.json",
      githubClosureFixture(),
    );

    const result = await finalizeGraphFreezeFromEvidence({
      repositoryRoot,
      repository: "ljie-PI/Qualigence",
      version,
      commit: FINALIZER_COMMIT,
      decidedAt: "2026-08-30T08:00:00.000Z",
      evidence: { githubClosure },
    });

    expect(
      result.decision.capabilities.find(
        (capability) => capability.id === "github-closure",
      ),
    ).toMatchObject({ status: "verified", blockers: [] });
  });

  it("rejects contradictory GitHub ticket status evidence", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "qualigence-freeze-github-invalid-"),
    );
    fixtureRoots.push(repositoryRoot);
    const githubClosure = githubClosureFixture();
    githubClosure.tickets[0]!.issue.state = "open";
    const reference = await writeEvidenceObject(
      repositoryRoot,
      "v0.1.0-candidate",
      "github-closure.json",
      githubClosure,
    );

    const result = await finalizeGraphFreezeFromEvidence(
      finalizerInput(repositoryRoot, {
        evidence: { githubClosure: reference },
      }),
    );

    expect(result.decision.blockingReasons).toContain(
      "GithubTicketStatusInvalid: github-closure",
    );
  });

  it("rejects a non-canonical but otherwise valid GitHub dependency edge", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "qualigence-freeze-github-dependency-"),
    );
    fixtureRoots.push(repositoryRoot);
    const githubClosure = githubClosureFixture();
    const ticketThree = mutableRecord(
      githubClosure.tickets[2],
      "legacy Ticket 03",
    );
    mutableRecord(ticketThree["issue"], "legacy Ticket 03 issue")["blockedBy"] =
      [1];
    const reference = await writeEvidenceObject(
      repositoryRoot,
      "v0.1.0-candidate",
      "github-closure.json",
      githubClosure,
    );

    const result = await finalizeGraphFreezeFromEvidence(
      finalizerInput(repositoryRoot, {
        evidence: { githubClosure: reference },
      }),
    );

    expect(result.decision.blockingReasons).toContain(
      "GithubTicketDependencyInvalid: github-closure",
    );
  });

  it("rejects resolved remediation without merged PR evidence", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "qualigence-freeze-github-remediation-pr-"),
    );
    fixtureRoots.push(repositoryRoot);
    const githubClosure = githubClosureFixture();
    delete mutableRecord(githubClosure.remediation[0], "resolved remediation")[
      "pullRequest"
    ];
    const reference = await writeEvidenceObject(
      repositoryRoot,
      "v0.1.0-candidate",
      "github-closure.json",
      githubClosure,
    );

    const result = await finalizeGraphFreezeFromEvidence(
      finalizerInput(repositoryRoot, {
        evidence: { githubClosure: reference },
      }),
    );

    expect(result.decision.blockingReasons).toContain(
      "GithubPullRequestNotMerged: github-closure",
    );
  });

  it("accepts truthful superseded-ticket history bound to its replacement authority", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "qualigence-freeze-github-superseded-"),
    );
    fixtureRoots.push(repositoryRoot);
    const githubClosure = githubClosureFixture();
    const ticket31 = mutableRecord(
      githubClosure.tickets[30],
      "legacy Ticket 31",
    );
    const issue31 = mutableRecord(ticket31["issue"], "legacy Ticket 31 issue");
    issue31["status"] = "superseded";
    issue31["todoTotal"] = 10;
    issue31["todoCompleted"] = 0;
    issue31["supersededBy"] = 48;
    delete ticket31["pullRequest"];
    const reference = await writeEvidenceObject(
      repositoryRoot,
      "v0.1.0-candidate",
      "github-closure.json",
      githubClosure,
    );

    const result = await finalizeGraphFreezeFromEvidence(
      finalizerInput(repositoryRoot, {
        evidence: { githubClosure: reference },
      }),
    );

    expect(
      result.decision.capabilities.find(
        (capability) => capability.id === "github-closure",
      ),
    ).toMatchObject({ status: "verified", blockers: [] });
  });

  it("validates real-provider and complete Reference Model benchmark evidence", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "qualigence-freeze-model-"),
    );
    fixtureRoots.push(repositoryRoot);
    const version = "v0.1.0-candidate";
    const evidence: Record<string, { path: string; sha256: string }> = {};
    for (const [key, filename] of [
      ["provider", "provider.json"],
      ["benchmark", "benchmark.json"],
    ] as const) {
      evidence[key] = await writeEvidenceObject(
        repositoryRoot,
        version,
        filename,
        await readFixtureObject(filename),
      );
    }

    const result = await finalizeGraphFreezeFromEvidence({
      repositoryRoot,
      repository: "ljie-PI/Qualigence",
      version,
      commit: FINALIZER_COMMIT,
      decidedAt: "2026-08-30T08:00:00.000Z",
      evidence,
    });

    for (const id of ["provider", "benchmark"]) {
      expect(
        result.decision.capabilities.find((capability) => capability.id === id),
      ).toMatchObject({ status: "verified", blockers: [] });
    }
  });

  it("rejects provider evidence that does not match the benchmark Reference Profile", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "qualigence-freeze-model-mismatch-"),
    );
    fixtureRoots.push(repositoryRoot);
    const provider = await readFixtureObject("provider.json");
    mutableRecord(provider["provider"], "provider identity")["model"] =
      "different-model";
    await writeEvidenceObject(
      repositoryRoot,
      "v0.1.0-candidate",
      "provider.json",
      await readFixtureObject("provider.json"),
    );
    const smokeReport = await readFixtureObject("provider-smoke-report.json");
    mutableRecord(smokeReport["provider"], "smoke report provider identity")[
      "model"
    ] = "different-model";
    provider["smokeReport"] = await writeEvidenceObject(
      repositoryRoot,
      "v0.1.0-candidate",
      "provider-smoke-report.json",
      smokeReport,
    );
    const evidence = {
      provider: await writeEvidenceObject(
        repositoryRoot,
        "v0.1.0-candidate",
        "provider.json",
        provider,
        false,
      ),
      benchmark: await writeEvidenceObject(
        repositoryRoot,
        "v0.1.0-candidate",
        "benchmark.json",
        await readFixtureObject("benchmark.json"),
      ),
    };

    const result = await finalizeGraphFreezeFromEvidence(
      finalizerInput(repositoryRoot, { evidence }),
    );

    expect(result.decision.blockingReasons).toEqual(
      expect.arrayContaining([
        "ProviderBenchmarkIdentityMismatch: benchmark",
        "ProviderBenchmarkIdentityMismatch: provider",
      ]),
    );
  });

  it("rejects provider evidence without the exact Ticket 48 environment contract", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "qualigence-freeze-provider-environment-"),
    );
    fixtureRoots.push(repositoryRoot);
    const provider = await readFixtureObject("provider.json");
    mutableRecord(provider["environment"], "provider environment")[
      "requiredVariables"
    ] = ["OPENAI_API_KEY"];
    const reference = await writeEvidenceObject(
      repositoryRoot,
      "v0.1.0-candidate",
      "provider.json",
      provider,
    );

    const result = await finalizeGraphFreezeFromEvidence(
      finalizerInput(repositoryRoot, {
        evidence: { provider: reference },
      }),
    );

    expect(result.decision.blockingReasons).toContain(
      "EvidenceSetInvalid: provider",
    );
  });

  it("rejects failed hashed provider redaction-scan evidence", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "qualigence-freeze-provider-redaction-"),
    );
    fixtureRoots.push(repositoryRoot);
    const version = "v0.1.0-candidate";
    const provider = await readFixtureObject("provider.json");
    await writeEvidenceObject(
      repositoryRoot,
      version,
      "provider.json",
      provider,
    );
    const scan = await readFixtureObject("provider-redaction-stdout.json");
    scan["status"] = "credential-found";
    const scanReference = await writeEvidenceObject(
      repositoryRoot,
      version,
      "provider-redaction-stdout.json",
      scan,
    );
    const scans = provider["redactionScans"];
    if (!Array.isArray(scans) || scans[0] === undefined) {
      throw new Error("provider fixture has no redaction scan");
    }
    mutableRecord(scans[0], "provider stdout redaction scan")["report"] =
      scanReference;
    const reference = await writeEvidenceObject(
      repositoryRoot,
      version,
      "provider.json",
      provider,
      false,
    );

    const result = await finalizeGraphFreezeFromEvidence(
      finalizerInput(repositoryRoot, {
        evidence: { provider: reference },
      }),
    );

    expect(result.decision.blockingReasons).toContain(
      "ProviderRedactionEvidenceInvalid: provider",
    );
  });

  it("rejects a benchmark invocation reused by another attempt", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "qualigence-freeze-benchmark-invocation-reuse-"),
    );
    fixtureRoots.push(repositoryRoot);
    const benchmark = await readFixtureObject("benchmark.json");
    const attempts = benchmark["attempts"];
    if (
      !Array.isArray(attempts) ||
      attempts[0] === undefined ||
      attempts[1] === undefined
    ) {
      throw new Error("benchmark fixture has no complete attempts");
    }
    mutableRecord(attempts[1], "benchmark attempt 1")["invocationIds"] =
      structuredClone(
        mutableRecord(attempts[0], "benchmark attempt 0")["invocationIds"],
      );
    const reference = await writeEvidenceObject(
      repositoryRoot,
      "v0.1.0-candidate",
      "benchmark.json",
      benchmark,
    );

    const result = await finalizeGraphFreezeFromEvidence(
      finalizerInput(repositoryRoot, {
        evidence: { benchmark: reference },
      }),
    );

    expect(result.decision.blockingReasons).toContain(
      "BenchmarkAttemptMatrixIncomplete: benchmark",
    );
  });

  it("rejects one serialized artifact reused under conflicting evidence identities", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "qualigence-freeze-duplicate-"),
    );
    fixtureRoots.push(repositoryRoot);
    const reference = await writeEvidenceObject(
      repositoryRoot,
      "v0.1.0-candidate",
      "provider.json",
      await readFixtureObject("provider.json"),
    );

    const result = await finalizeGraphFreezeFromEvidence(
      finalizerInput(repositoryRoot, {
        evidence: { provider: reference, benchmark: reference },
      }),
    );

    expect(result.decision.blockingReasons).toEqual(
      expect.arrayContaining([
        "EvidenceDuplicate: benchmark",
        "EvidenceDuplicate: provider",
      ]),
    );
  });

  it("reuses the Ticket 34 verifier and freezes only a complete serialized fixture set", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "qualigence-freeze-complete-"),
    );
    fixtureRoots.push(repositoryRoot);
    const version = "v0.1.0-candidate";
    const evidence: Record<string, { path: string; sha256: string }> = {
      githubClosure: await writeEvidenceObject(
        repositoryRoot,
        version,
        "github-closure.json",
        githubClosureFixture(),
      ),
      releaseManifest: await writeReleaseFixture(repositoryRoot, version),
    };
    for (const [key, filename] of [
      ["candidateMigration", "candidate-migration.json"],
      ["graphConformance", "graph-conformance.json"],
      ["nativeReports", "native-reports.json"],
      ["provider", "provider.json"],
      ["benchmark", "benchmark.json"],
    ] as const) {
      evidence[key] = await writeEvidenceObject(
        repositoryRoot,
        version,
        filename,
        await readFixtureObject(filename),
      );
    }

    const previousOfflineMode =
      process.env["QUALIGENCE_ALLOW_OFFLINE_ATTESTATION_FIXTURES"];
    process.env["QUALIGENCE_ALLOW_OFFLINE_ATTESTATION_FIXTURES"] = "true";
    try {
      const result = await finalizeGraphFreezeFromEvidence({
        repositoryRoot,
        repository: "ljie-PI/Qualigence",
        version,
        commit: FINALIZER_COMMIT,
        decidedAt: "2026-08-30T08:00:00.000Z",
        evidence,
      });

      expect(result.decision.blockingReasons).toEqual([]);
      expect(result.decision.status).toBe("frozen");
      expect(result.decision.signoff).toMatchObject({
        operatorName: "human-a",
        reviewerName: "human-b",
        checklistVersion: WINDOWS_M3_CHECKLIST_VERSION,
        productVersion: version,
      });
      expect(
        result.decision.capabilities.every(
          (capability) => capability.status === "verified",
        ),
      ).toBe(true);
    } finally {
      if (previousOfflineMode === undefined) {
        delete process.env["QUALIGENCE_ALLOW_OFFLINE_ATTESTATION_FIXTURES"];
      } else {
        process.env["QUALIGENCE_ALLOW_OFFLINE_ATTESTATION_FIXTURES"] =
          previousOfflineMode;
      }
    }
  });

  it.each([
    {
      name: "stale provider evidence",
      key: "provider",
      filename: "provider.json",
      code: "EvidenceStale",
      mutate: (evidence: Record<string, unknown>) => {
        evidence["generatedAt"] = "2026-08-30T09:00:00.000Z";
      },
    },
    {
      name: "synthetic provider evidence",
      key: "provider",
      filename: "provider.json",
      code: "SyntheticEvidenceRejected",
      mutate: (evidence: Record<string, unknown>) => {
        evidence["evidenceClass"] = "synthetic";
      },
    },
    {
      name: "cross-commit provider evidence",
      key: "provider",
      filename: "provider.json",
      code: "EvidenceCommitMismatch",
      mutate: (evidence: Record<string, unknown>) => {
        evidence["commit"] = "f".repeat(40);
      },
    },
    {
      name: "duplicate provider invocation",
      key: "provider",
      filename: "provider.json",
      code: "EvidenceDuplicate",
      mutate: (evidence: Record<string, unknown>) => {
        const invocations = evidence["invocations"];
        if (!Array.isArray(invocations) || invocations[0] === undefined) {
          throw new Error("provider fixture has no invocation");
        }
        invocations.push(structuredClone(invocations[0]));
        evidence["invocationCount"] = 2;
      },
    },
    {
      name: "failed provider result",
      key: "provider",
      filename: "provider.json",
      code: "ProviderResultInvalid",
      mutate: (evidence: Record<string, unknown>) => {
        mutableRecord(evidence["result"], "provider result")["status"] =
          "failed";
      },
    },
    {
      name: "unexplained migration failure",
      key: "candidateMigration",
      filename: "candidate-migration.json",
      code: "MigrationUnexplainedFailure",
      mutate: (evidence: Record<string, unknown>) => {
        const report = mutableRecord(evidence["report"], "migration report");
        const results = report["results"];
        if (!Array.isArray(results) || results[0] === undefined) {
          throw new Error("migration fixture has no result");
        }
        mutableRecord(results[0], "migration result")["status"] = "failed";
      },
    },
    {
      name: "omitted active migration inventory",
      key: "candidateMigration",
      filename: "candidate-migration.json",
      code: "MigrationInventoryMismatch",
      mutate: (evidence: Record<string, unknown>) => {
        const inventory = evidence["inventory"];
        if (!Array.isArray(inventory) || inventory.length < 2) {
          throw new Error("migration fixture has no complete inventory");
        }
        inventory.pop();
      },
    },
    {
      name: "unsupported migrator version prefix",
      key: "candidateMigration",
      filename: "candidate-migration.json",
      code: "MigrationInventoryMismatch",
      mutate: (evidence: Record<string, unknown>) => {
        const report = mutableRecord(evidence["report"], "migration report");
        const results = report["results"];
        if (!Array.isArray(results) || results[0] === undefined) {
          throw new Error("migration fixture has no result");
        }
        mutableRecord(results[0], "migration result")["migratorVersion"] =
          "observation-migrator/v10";
      },
    },
    {
      name: "duplicate native report",
      key: "nativeReports",
      filename: "native-reports.json",
      code: "NativeReportMissing",
      mutate: (evidence: Record<string, unknown>) => {
        const reports = evidence["reports"];
        if (!Array.isArray(reports) || reports[0] === undefined) {
          throw new Error("native fixture has no report");
        }
        reports.push(structuredClone(reports[0]));
      },
    },
    {
      name: "failed benchmark Gate",
      key: "benchmark",
      filename: "benchmark.json",
      code: "BenchmarkGateFailed",
      mutate: (evidence: Record<string, unknown>) => {
        const report = mutableRecord(evidence["report"], "benchmark report");
        mutableRecord(report["gate"], "benchmark gate")["status"] = "failed";
      },
    },
    {
      name: "modified benchmark threshold",
      key: "benchmark",
      filename: "benchmark.json",
      code: "BenchmarkManifestInvalid",
      mutate: (evidence: Record<string, unknown>) => {
        const manifest = mutableRecord(
          evidence["manifest"],
          "benchmark manifest",
        );
        mutableRecord(manifest["thresholds"], "benchmark thresholds")[
          "knownBugRecallMinimum"
        ] = 0.1;
      },
    },
  ])("fails closed for $name", async ({ key, filename, code, mutate }) => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "qualigence-freeze-invalid-"),
    );
    fixtureRoots.push(repositoryRoot);
    const evidenceValue = await readFixtureObject(filename);
    mutate(evidenceValue);
    const reference = await writeEvidenceObject(
      repositoryRoot,
      "v0.1.0-candidate",
      filename,
      evidenceValue,
    );

    const result = await finalizeGraphFreezeFromEvidence(
      finalizerInput(repositoryRoot, {
        evidence: { [key]: reference },
      }),
    );

    const capabilityId =
      key === "candidateMigration"
        ? "candidate-migration"
        : key === "graphConformance"
          ? "graph-conformance"
          : key === "nativeReports"
            ? "native-reports"
            : key;
    expect(result.decision.status).toBe("candidate");
    expect(result.decision.signoff).toBeUndefined();
    expect(result.decision.blockingReasons).toContain(
      `${code}: ${capabilityId}`,
    );
  });

  it("rejects malformed, hash-mismatched, and path-escaping evidence", async () => {
    for (const [name, reference, blocker] of [
      [
        "malformed",
        {
          path: "artifacts/release/v0.1.0-candidate/malformed.json",
          sha256: sha256("{not-json"),
        },
        "EvidenceJsonInvalid: candidate-migration",
      ],
      [
        "hash-mismatch",
        {
          path: "artifacts/release/v0.1.0-candidate/hash-mismatch.json",
          sha256: "0".repeat(64),
        },
        "EvidenceHashMismatch: candidate-migration",
      ],
      [
        "path-escape",
        {
          path: "../candidate-migration.json",
          sha256: "0".repeat(64),
        },
        "EvidencePathInvalid: candidate-migration",
      ],
    ] as const) {
      const repositoryRoot = await mkdtemp(
        join(tmpdir(), `qualigence-freeze-${name}-`),
      );
      fixtureRoots.push(repositoryRoot);
      if (name !== "path-escape") {
        await mkdir(
          join(repositoryRoot, "artifacts", "release", "v0.1.0-candidate"),
          { recursive: true },
        );
        await writeFile(
          join(repositoryRoot, ...reference.path.split("/")),
          name === "malformed"
            ? "{not-json"
            : await readFile(
                join(FINALIZER_FIXTURE_ROOT, "candidate-migration.json"),
              ),
        );
      }
      const result = await finalizeGraphFreezeFromEvidence(
        finalizerInput(repositoryRoot, {
          evidence: { candidateMigration: reference },
        }),
      );
      expect(result.decision.blockingReasons).toContain(blocker);
    }
  });

  it("rejects evidence reached through a symlinked path segment", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "qualigence-freeze-symlink-"),
    );
    fixtureRoots.push(repositoryRoot);
    const actualRoot = join(repositoryRoot, "actual-evidence");
    const manualRoot = join(repositoryRoot, "artifacts", "manual-acceptance");
    await mkdir(actualRoot, { recursive: true });
    await mkdir(manualRoot, { recursive: true });
    const bytes = await readFile(
      join(FINALIZER_FIXTURE_ROOT, "candidate-migration.json"),
    );
    await writeFile(join(actualRoot, "candidate-migration.json"), bytes);
    await symlink(
      actualRoot,
      join(manualRoot, "v0.1.0-candidate"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const result = await finalizeGraphFreezeFromEvidence(
      finalizerInput(repositoryRoot, {
        evidence: {
          candidateMigration: {
            path: "artifacts/manual-acceptance/v0.1.0-candidate/candidate-migration.json",
            sha256: sha256(bytes),
          },
        },
      }),
    );

    expect(result.decision.blockingReasons).toContain(
      "EvidencePathSymlink: candidate-migration",
    );
  });

  it.each([
    ["release manifest schema", "ManifestSchemaVersionInvalid"],
    ["unsigned Windows checklist", "WindowsEvidenceUnsigned"],
    ["failed Windows veto", "WindowsEvidenceVetoFailed"],
    ["cross-commit CI artifact", "GateArtifactCommitMismatch"],
    ["invalid SBOM", "SbomSchemaInvalid"],
    ["mismatched provenance", "AttestationBundleHashMismatch"],
  ] as const)("fails closed for %s", async (scenario, expectedCode) => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "qualigence-freeze-release-invalid-"),
    );
    fixtureRoots.push(repositoryRoot);
    const version = "v0.1.0-candidate";
    const releaseManifest = await writeReleaseFixture(repositoryRoot, version);
    const manifestPath = join(
      repositoryRoot,
      ...releaseManifest.path.split("/"),
    );
    const manifest = mutableRecord(
      JSON.parse(await readFile(manifestPath, "utf8")),
      "release manifest",
    );

    if (scenario === "release manifest schema") {
      manifest["schemaVersion"] = "qualigence-release-manifest/v2";
    } else if (scenario === "unsigned Windows checklist") {
      mutableRecord(manifest["windowsEvidence"], "windows evidence")[
        "signatures"
      ] = [];
    } else if (scenario === "failed Windows veto") {
      const windowsReference = mutableRecord(
        manifest["windowsEvidence"],
        "windows evidence",
      );
      const windowsPath = join(
        repositoryRoot,
        ...String(windowsReference["path"]).split("/"),
      );
      const windows = mutableRecord(
        JSON.parse(await readFile(windowsPath, "utf8")),
        "signed Windows payload",
      );
      const checklist = mutableRecord(
        windows["WindowsChecklistEvidence"],
        "Windows checklist",
      );
      const items = checklist["items"];
      if (!Array.isArray(items) || items[0] === undefined) {
        throw new Error("Windows fixture has no checklist item");
      }
      mutableRecord(items[0], "Windows checklist item")["result"] = "fail";
      const windowsBytes = `${JSON.stringify(windows, null, 2)}\n`;
      await writeFile(windowsPath, windowsBytes);
      windowsReference["sha256"] = sha256(windowsBytes);
    } else if (scenario === "cross-commit CI artifact") {
      const gates = manifest["gates"];
      if (!Array.isArray(gates) || gates[0] === undefined) {
        throw new Error("release fixture has no Gate");
      }
      mutableRecord(gates[0], "release Gate")["commit"] = "f".repeat(40);
    } else if (scenario === "invalid SBOM") {
      const sbomReference = mutableRecord(manifest["sbom"], "release SBOM");
      const sbomPath = join(
        repositoryRoot,
        ...String(sbomReference["path"]).split("/"),
      );
      const sbom = mutableRecord(
        JSON.parse(await readFile(sbomPath, "utf8")),
        "SBOM",
      );
      sbom["spdxVersion"] = "SPDX-3.0";
      const sbomBytes = `${JSON.stringify(sbom, null, 2)}\n`;
      await writeFile(sbomPath, sbomBytes);
      sbomReference["sha256"] = sha256(sbomBytes);
    } else {
      const images = mutableRecord(manifest["images"], "release images");
      const application = mutableRecord(
        images["application"],
        "application image",
      );
      mutableRecord(application["provenance"], "application provenance")[
        "bundleSha256"
      ] = "0".repeat(64);
    }

    const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeFile(manifestPath, manifestBytes);
    const previousOfflineMode =
      process.env["QUALIGENCE_ALLOW_OFFLINE_ATTESTATION_FIXTURES"];
    process.env["QUALIGENCE_ALLOW_OFFLINE_ATTESTATION_FIXTURES"] = "true";
    try {
      const result = await finalizeGraphFreezeFromEvidence(
        finalizerInput(repositoryRoot, {
          evidence: {
            releaseManifest: {
              path: releaseManifest.path,
              sha256: sha256(manifestBytes),
            },
          },
        }),
      );
      for (const capabilityId of [
        "release-manifest",
        "required-ci",
        "sbom-provenance",
        "windows-checklist",
      ]) {
        expect(result.decision.blockingReasons).toContain(
          `${expectedCode}: ${capabilityId}`,
        );
      }
      expect(result.decision.status).toBe("candidate");
      expect(result.decision.signoff).toBeUndefined();
    } finally {
      if (previousOfflineMode === undefined) {
        delete process.env["QUALIGENCE_ALLOW_OFFLINE_ATTESTATION_FIXTURES"];
      } else {
        process.env["QUALIGENCE_ALLOW_OFFLINE_ATTESTATION_FIXTURES"] =
          previousOfflineMode;
      }
    }
  });

  it("cancels before terminal work without publishing a decision", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "qualigence-freeze-cancel-"),
    );
    fixtureRoots.push(repositoryRoot);
    const controller = new AbortController();
    controller.abort();

    await expect(
      finalizeGraphFreezeFromEvidence(
        finalizerInput(repositoryRoot, { signal: controller.signal }),
      ),
    ).rejects.toMatchObject({ code: "FinalizationAborted" });
    await expect(
      readFile(
        join(
          repositoryRoot,
          "artifacts",
          "release",
          "v0.1.0-candidate",
          "graph-freeze-decision.json",
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects dot-segment release versions before resolving an output path", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "qualigence-freeze-invalid-version-"),
    );
    fixtureRoots.push(repositoryRoot);

    await expect(
      finalizeGraphFreezeFromEvidence({
        ...finalizerInput(repositoryRoot),
        version: "..",
      }),
    ).rejects.toMatchObject({ code: "FinalizerInputInvalid" });
    await expect(
      readFile(join(repositoryRoot, "artifacts", "graph-freeze-decision.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cancels a running Ticket 34 verifier without publishing a decision", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "qualigence-freeze-verifier-cancel-"),
    );
    fixtureRoots.push(repositoryRoot);
    const releaseManifest = await writeReleaseFixture(
      repositoryRoot,
      "v0.1.0-candidate",
    );
    await writeFile(
      join(repositoryRoot, "scripts", "verify-release-manifest.mjs"),
      "setInterval(() => {}, 1_000);\n",
    );
    const controller = new AbortController();
    const cancellation = setTimeout(() => controller.abort(), 50);
    try {
      await expect(
        finalizeGraphFreezeFromEvidence(
          finalizerInput(repositoryRoot, {
            evidence: { releaseManifest },
            signal: controller.signal,
          }),
        ),
      ).rejects.toMatchObject({ code: "FinalizationAborted" });
    } finally {
      clearTimeout(cancellation);
    }
    await expect(
      readFile(
        join(
          repositoryRoot,
          "artifacts",
          "release",
          "v0.1.0-candidate",
          "graph-freeze-decision.json",
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cancels after the temporary write and cleans non-terminal state", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "qualigence-freeze-mid-cancel-"),
    );
    fixtureRoots.push(repositoryRoot);
    const controller = new AbortController();
    let reads = 0;
    Object.defineProperty(controller.signal, "aborted", {
      get: () => {
        reads += 1;
        return reads >= 3;
      },
    });

    await expect(
      finalizeGraphFreezeFromEvidence(
        finalizerInput(repositoryRoot, { signal: controller.signal }),
      ),
    ).rejects.toMatchObject({ code: "FinalizationAborted" });
    const releaseRoot = join(
      repositoryRoot,
      "artifacts",
      "release",
      "v0.1.0-candidate",
    );
    await expect(
      readFile(join(releaseRoot, "graph-freeze-decision.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(releaseRoot)).resolves.toBeDefined();
    expect(await readdir(releaseRoot)).toEqual([]);
  });

  it("reconciles identical replay and concurrent writers without rewriting", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "qualigence-freeze-replay-"),
    );
    fixtureRoots.push(repositoryRoot);
    const input = finalizerInput(repositoryRoot);
    const first = await finalizeGraphFreezeFromEvidence(input);
    const firstStat = await stat(first.path);
    const replay = await finalizeGraphFreezeFromEvidence(input);
    const replayStat = await stat(replay.path);
    expect(replay.sha256).toBe(first.sha256);
    expect(replayStat.mtimeMs).toBe(firstStat.mtimeMs);

    const concurrentRoot = await mkdtemp(
      join(tmpdir(), "qualigence-freeze-concurrent-"),
    );
    fixtureRoots.push(concurrentRoot);
    const concurrentInput = finalizerInput(concurrentRoot);
    const [left, right] = await Promise.all([
      finalizeGraphFreezeFromEvidence(concurrentInput),
      finalizeGraphFreezeFromEvidence(concurrentInput),
    ]);
    expect(left.sha256).toBe(right.sha256);
    expect(await readFile(left.path, "utf8")).toBe(
      await readFile(right.path, "utf8"),
    );
  });

  it("preserves conflicting decisions and ignores orphan temporary state", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "qualigence-freeze-conflict-"),
    );
    fixtureRoots.push(repositoryRoot);
    const releaseRoot = join(
      repositoryRoot,
      "artifacts",
      "release",
      "v0.1.0-candidate",
    );
    await mkdir(releaseRoot, { recursive: true });
    const orphanPath = join(
      releaseRoot,
      "graph-freeze-decision.json.tmp-orphan",
    );
    await writeFile(orphanPath, "not terminal evidence\n");
    const first = await finalizeGraphFreezeFromEvidence(
      finalizerInput(repositoryRoot),
    );
    const originalBytes = await readFile(first.path, "utf8");

    await expect(
      finalizeGraphFreezeFromEvidence(
        finalizerInput(repositoryRoot, {
          decidedAt: "2026-08-30T09:00:00.000Z",
        }),
      ),
    ).rejects.toMatchObject({ code: "DecisionArtifactConflict" });
    expect(await readFile(first.path, "utf8")).toBe(originalBytes);
    expect(await readFile(orphanPath, "utf8")).toBe("not terminal evidence\n");
  });

  it("surfaces terminal persistence failures as typed errors", async () => {
    const parent = await mkdtemp(
      join(tmpdir(), "qualigence-freeze-write-failure-"),
    );
    fixtureRoots.push(parent);
    const repositoryRoot = join(parent, "repository-file");
    await writeFile(repositoryRoot, "not a directory");

    await expect(
      finalizeGraphFreezeFromEvidence(finalizerInput(repositoryRoot)),
    ).rejects.toMatchObject({ code: "DecisionArtifactWriteFailed" });
  });
});

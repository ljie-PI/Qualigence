import { execFile } from "node:child_process";
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
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "@qualigence/skill";
import {
  buildFreezeReport,
  buildFreezeGateReport,
  finalizeGraphFreezeFromEvidence,
  generateAutomatedFreezeGateReport,
  OBSERVATION_FREEZE_GATE_REPORT_VERSION,
  REQUIRED_SECURITY_VETO_ITEM_IDS,
  REQUIRED_WINDOWS_CHECKLIST_SECTION_COUNTS,
  REQUIRED_SHARED_CORE_FIELDS,
  WINDOWS_M3_CHECKLIST_VERSION,
  type ObservationFreezeReportV1,
  type ObservationMigrationResult,
  type SchemaConformanceEvidence,
  type WindowsChecklistEvidence,
} from "@qualigence/observation-migration";

const NOW = () => "2026-08-02T00:00:00.000Z";
const execFileAsync = promisify(execFile);
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
const REMEDIATION_PARENTS = [
  2, 17, 3, 18, 18, 18, 18, 18, 18, 18, 21, 30,
] as const;
const PULL_REQUESTS = new Map([
  [
    1,
    [
      69,
      "3b1c7621a3869be226b43153c0ae0682a62425b7",
      "c69ef0e54b75e9bc0745f38d69c3d3c00c562474",
    ],
  ],
  [
    2,
    [
      71,
      "a18d5f2e2d91358ed2b4ade5487574aa82fc3ec5",
      "17d9e875f6e4a12742ad9e69f28320839685c873",
    ],
  ],
  [
    3,
    [
      76,
      "fe30bfc8add4a7db38e4a81bc7701d44e9bf4c15",
      "454f96a055053e15dd24a9c85762bd83046c68e0",
    ],
  ],
  [
    4,
    [
      85,
      "055473ec58e6680335ce3306f8f8fcdbb169e593",
      "14bcf76cc686244775a127c86cfaa2b19e4ad4a2",
    ],
  ],
  [
    5,
    [
      92,
      "549ef5112138b7e4fa384c03f97b193d11c5e867",
      "6f330c96ab8082461f3f35c354e38d945154f61a",
    ],
  ],
  [
    6,
    [
      91,
      "14a7f1688d9c0f347239197f9c2c49be20587f67",
      "0334508d245981fb84f36e36368f9bbd08928062",
    ],
  ],
  [
    7,
    [
      102,
      "968c0f051cda71a05e3b2defeede7238c67e070b",
      "18f2bae1518fee740f028d0d63cd1de458fc9229",
    ],
  ],
  [
    8,
    [
      106,
      "240d013f438fc1df4d7063839bbaddbff6a66246",
      "88c4df17620fdc046b0082cc277b1e766e222559",
    ],
  ],
  [
    9,
    [
      109,
      "8bb2b779a52e9467a316d61f717aa41256e57afb",
      "5cdc7452b118b37354ead7643e0ba604a37161e2",
    ],
  ],
  [
    10,
    [
      111,
      "a83aadf617b4bbe97cab14fd67012141e575f485",
      "9f629afa7def3d6e9e43e21550ebbc326ac5a00f",
    ],
  ],
  [
    11,
    [
      115,
      "5614f8b7199163e3c0d3576b8e23299584bfe840",
      "bd5155e6bbe809e9af12b4b2cec00bd9d2be9e52",
    ],
  ],
  [
    12,
    [
      119,
      "318fc37bc6f0e5aeb7432f295cbc56d0be0cc734",
      "088a09753f765545e1982a7ee14758947085cff8",
    ],
  ],
  [
    13,
    [
      122,
      "de6d9f10d821163c8d25bd92f457576053c149c8",
      "8b9a3f84915b4b5a7a92c4eaa032463e3c3aad7f",
    ],
  ],
  [
    14,
    [
      125,
      "e18de3ba6dce8209a66389e99e7337a89a42d67c",
      "a71a06f39bad8fe51f72b95618ed680e1d3ee04e",
    ],
  ],
  [
    15,
    [
      128,
      "609f3f16a137b519dc7b42f36a1d5a936b22815a",
      "86f0bc7808b3c34b5f3e8a495d6220e6f7b67200",
    ],
  ],
  [
    16,
    [
      70,
      "eb32d3d666ee98a38de0784eb527c28564e4dbd9",
      "8c1c06f5f3bd10b0255d06a6b347e4d89a25d7fa",
    ],
  ],
  [
    17,
    [
      72,
      "87b8d5a1ba8bacb15ee70b9cf7d4daf932a962e9",
      "9df95b17a25e206b20a4f964694e42ebf18906c8",
    ],
  ],
  [
    18,
    [
      75,
      "2db5167ac6298b835beaa9f2047c4bbe53931c8a",
      "de2b77369801785696b57b5dfacfd230bc0ea3d3",
    ],
  ],
  [
    19,
    [
      86,
      "79fce12f4614f56754bf0babf6ceab0dbadac118",
      "4ec4ebd5df46dc8ba2f658dd90065f20c9daf130",
    ],
  ],
  [
    20,
    [
      99,
      "a33bef37fec00ff6db3a18a4c602191f8e012350",
      "1995a946d297c86d67ed355be4c07fbe09c7f7ac",
    ],
  ],
  [
    21,
    [
      101,
      "64f749ec144dce3f4114946d25517c1096be43d2",
      "219532953a4eb0601b8471a8e510508dbd2c8647",
    ],
  ],
  [
    22,
    [
      90,
      "7ec3ab1ca030913f390177f7d5f8b308981e00ef",
      "7ef31db708612ddc5c020e6e2bb2758d763fba85",
    ],
  ],
  [
    23,
    [
      97,
      "78a4de5d690375e037b78d41232c40bdb6f053e9",
      "b7d087526be47c86950ae0ff1714f68043445a6d",
    ],
  ],
  [
    24,
    [
      107,
      "57d38ea0fbd9eb232d1a2d97e57a9a8451b43619",
      "6e8e4bdad38b934ab9f414305bb4c944a8942fd8",
    ],
  ],
  [
    25,
    [
      110,
      "8216f8f1029dbb3700d37673c2a3383580ec1b19",
      "05e05ebd762a9222b5fc031503c29612424d0105",
    ],
  ],
  [
    26,
    [
      112,
      "7c7886fb089531b4159e9288e7f2b7f1e87c43a8",
      "cff217f68f0b3bcaffe517aaed11e3e302abb964",
    ],
  ],
  [
    27,
    [
      116,
      "588d349f159a1369b888207b8a79141f1c2fed93",
      "34aeb423ef655ca04f8c69736e0a4d8b1ac9621e",
    ],
  ],
  [
    28,
    [
      118,
      "76a109f8703d884310043f02f58c10b63d743c0b",
      "5f6ee13e8cb9bfcd8e0f401e9d3bccd3a1782199",
    ],
  ],
  [
    29,
    [
      120,
      "371e6d3e65c2ee334c5493cbf2fc8b9135129f64",
      "6a0a0adc0ae35359e137d89163b72bca38c65a51",
    ],
  ],
  [
    30,
    [
      123,
      "ebf933b9f45e85841cd2b602d410367dd8664395",
      "9156a7be33f0349cf9c6e3b65167bb6cc92e1ec1",
    ],
  ],
  [
    32,
    [
      131,
      "bbdf0e380c7feab5111aa6ecd0db4d8ffefa8236",
      "c22c4650ffd7319e15ac27647859697d548989f4",
    ],
  ],
  [
    33,
    [
      132,
      "5e26149b426101a2c3dc5c85fd71afb3beb404a3",
      "d85438e87cefd9be12d93875c1d748c173be5e9d",
    ],
  ],
  [
    34,
    [
      133,
      "8d90bf088a66d03dc1e7c1a1edfb518fd8969584",
      "d66590a2d7fc4de759f3718469333fe1658d36e3",
    ],
  ],
  [
    35,
    [
      130,
      "bc3b10546f2195588a771cbee7cf52ae4b8d65c4",
      "bb4d11b95098ce6bd604d3bc02d13f0fd798c334",
    ],
  ],
  [
    36,
    [
      74,
      "707a672e27ba23d825c95a735f803af78387e4b5",
      "d03179e8b6662a359485b4a1a71cec114eb173fc",
    ],
  ],
  [
    37,
    [
      73,
      "466742e08998fdbd61dadbd86e3fc493995b7588",
      "87b8d5a1ba8bacb15ee70b9cf7d4daf932a962e9",
    ],
  ],
  [
    38,
    [
      77,
      "b006e253b8b63fb59045f64606a3e9c95da34e35",
      "fe30bfc8add4a7db38e4a81bc7701d44e9bf4c15",
    ],
  ],
  [
    39,
    [
      94,
      "fcfb3fb64e696e819118f7c2a5269baee403f876",
      "8fd56808dea9fc8b202e0d4833a0e8f5606e6001",
    ],
  ],
  [
    40,
    [
      108,
      "18bd3e5a187410e674e67f8e851959bfd8b6aab7",
      "3e46233f6acf7733b9b0f77c871b2994ba2c0d67",
    ],
  ],
  [
    41,
    [
      113,
      "d56e8c98a93e602458a358c035f8a0ec33855480",
      "184fb79de67cf821ffd8da8d0d2a86ba1ffae29e",
    ],
  ],
  [
    42,
    [
      114,
      "a6db2f1ad6f9850b3e65ddb113decf5e23283fdf",
      "6123350bbd47a0d196a26f25b0e24528561d627f",
    ],
  ],
  [
    43,
    [
      117,
      "6fbc2c4d78dab248187bda30d8da8a709b7afd96",
      "6579bbbaedb1f0cb1361701d4778081d5c7db73b",
    ],
  ],
  [
    44,
    [
      121,
      "0805127eb1596736bb4c07e5a26fb6b94eedd3cc",
      "7e48d64fd61e2f433dc9431b9308fb5700080dbb",
    ],
  ],
  [
    45,
    [
      126,
      "4f45aaa9301940f106372deb38cd3b6ddeddd88c",
      "5a5dfa00601d9a24f56b707350b0b5e3574a37ee",
    ],
  ],
  [
    47,
    [
      127,
      "2a7a442e51b59ea57e11fc35811a5bb4c9e9daea",
      "808fd0f639acafe2eb287456ea64a368db338219",
    ],
  ],
] as const);
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
    "provider-output-stdout.json",
    "provider-output-stderr.json",
    "provider-output-summaries.json",
    "provider-output-artifacts.json",
    "provider-output-local-files.json",
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

function closurePullRequest(legacyTicket: number) {
  const pullRequest = PULL_REQUESTS.get(legacyTicket);
  if (pullRequest === undefined) {
    throw new Error(
      `legacy Ticket ${legacyTicket} has no fixture pull request`,
    );
  }
  const [pullRequestNumber, head, mergeCommit] = pullRequest;
  return {
    number: pullRequestNumber,
    url: `https://github.com/ljie-PI/Qualigence/pull/${pullRequestNumber}`,
    state: "closed",
    mergedAt: "2026-08-29T00:00:00.000Z",
    reviewedHead: head,
    remoteHead: head,
    mergeCommit,
    changedFiles: ["packages/observation-migration/src/index.ts"],
    checkSuite: {
      status: "completed",
      conclusion: "success",
      checkCount: 1,
    },
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
      pullRequest: closurePullRequest(legacyTicket),
    };
  });
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
        parentLegacyTicket: REMEDIATION_PARENTS[index],
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
      parentLegacyTicket: REMEDIATION_PARENTS[index],
      blocking: false,
      pullRequest: closurePullRequest(legacyTicket),
    };
  });
  const payload = {
    umbrellaIssue: 67,
    tickets,
    remediation,
    integratedAcceptance: {
      legacyTicket: 48,
      issue: {
        number: 181,
        parentIssue: 67,
        state: "open",
        status: "ready-for-human",
        blockedBy: [35],
      },
      authority: "integrated-human-acceptance",
      blocking: false,
    },
  };
  return {
    schemaVersion: "qualigence-github-closure-evidence/v1",
    repository: "ljie-PI/Qualigence",
    version: "v0.1.0-candidate",
    commit: FINALIZER_COMMIT,
    generatedAt: "2026-08-30T07:30:00.000Z",
    evidenceClass: "real",
    capture: {
      source: "github-graphql-and-rest-api",
      apiVersion: "2022-11-28",
      repositoryUrl: "https://api.github.com/repos/ljie-PI/Qualigence",
      actor: "ljie-PI",
      capturedAt: "2026-08-30T07:30:00.000Z",
      payloadSha256: sha256Hex(canonicalJson(payload)),
      ticket35ClosingPullRequest: 130,
    },
    ...payload,
  };
}

function refreshGithubCaptureHash(value: unknown): void {
  const evidence = mutableRecord(value, "GitHub closure fixture");
  const capture = mutableRecord(evidence["capture"], "GitHub API capture");
  capture["payloadSha256"] = sha256Hex(
    canonicalJson({
      umbrellaIssue: evidence["umbrellaIssue"],
      tickets: evidence["tickets"],
      remediation: evidence["remediation"],
      integratedAcceptance: evidence["integratedAcceptance"],
    }),
  );
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

async function ensureGitObjectStore(repositoryRoot: string): Promise<void> {
  const gitDirectory = join(repositoryRoot, ".git");
  try {
    await stat(gitDirectory);
    return;
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }
  await execFileAsync("git", ["init", "--quiet", repositoryRoot]);
  const { stdout } = await execFileAsync(
    "git",
    ["rev-parse", "--git-common-dir"],
    { cwd: process.cwd() },
  );
  const commonDirectory = stdout.trim();
  const objectDirectory = join(
    isAbsolute(commonDirectory)
      ? commonDirectory
      : resolve(process.cwd(), commonDirectory),
    "objects",
  );
  await mkdir(join(gitDirectory, "objects", "info"), { recursive: true });
  await writeFile(
    join(gitDirectory, "objects", "info", "alternates"),
    `${objectDirectory}\n`,
  );
}

async function writeEvidenceObject(
  repositoryRoot: string,
  version: string,
  filename: string,
  value: unknown,
  copyDependencies = true,
  refreshDependencyHashes = copyDependencies,
) {
  if (filename === "github-closure.json" || filename === "benchmark.json") {
    await ensureGitObjectStore(repositoryRoot);
  }
  const path = `artifacts/release/${version}/${filename}`;
  const materializedValue = structuredClone(value);
  if (filename === "github-closure.json") {
    refreshGithubCaptureHash(materializedValue);
  }
  await mkdir(join(repositoryRoot, "artifacts", "release", version), {
    recursive: true,
  });
  const dependencyHashes = new Map<string, string>();
  const refreshReferences = (
    candidate: unknown,
    hashes: ReadonlyMap<string, string>,
  ): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach((item) => refreshReferences(item, hashes));
      return;
    }

    if (candidate === null || typeof candidate !== "object") {
      return;
    }
    const record = candidate as Record<string, unknown>;
    if (typeof record["path"] === "string") {
      const dependency = record["path"].split("/").at(-1);
      const hash =
        dependency === undefined ? undefined : hashes.get(dependency);
      if (hash !== undefined) {
        record["sha256"] = hash;
      }
    }
    Object.values(record).forEach((item) => refreshReferences(item, hashes));
    if (
      record["scannedArtifact"] !== null &&
      typeof record["scannedArtifact"] === "object" &&
      !Array.isArray(record["scannedArtifact"])
    ) {
      record["scannedArtifactSha256"] = (
        record["scannedArtifact"] as Record<string, unknown>
      )["sha256"];
    }
  };
  if (copyDependencies) {
    for (const dependency of NESTED_EVIDENCE_FIXTURES[filename] ?? []) {
      const sourceBytes = await readFile(
        join(FINALIZER_FIXTURE_ROOT, dependency),
      );
      const dependencyValue = JSON.parse(sourceBytes.toString("utf8"));
      refreshReferences(dependencyValue, dependencyHashes);
      const dependencyBytes = Buffer.from(
        `${JSON.stringify(dependencyValue, null, 2)}\n`,
        "utf8",
      );
      await writeFile(
        join(repositoryRoot, "artifacts", "release", version, dependency),
        dependencyBytes,
      );
      dependencyHashes.set(dependency, sha256(dependencyBytes));
    }
  }
  if (refreshDependencyHashes) {
    refreshReferences(materializedValue, dependencyHashes);
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
  useOfflineVerifierFixture = true,
): Promise<{ path: string; sha256: string }> {
  const releaseRoot = join(repositoryRoot, "artifacts", "release", version);
  const gateRoot = join(releaseRoot, "gate-artifacts");
  await mkdir(gateRoot, { recursive: true });
  await mkdir(join(repositoryRoot, "scripts"), { recursive: true });
  const authoritativeVerifier = join(
    process.cwd(),
    "scripts",
    "verify-release-manifest.mjs",
  );
  const verifierFixture = useOfflineVerifierFixture
    ? [
        'import { execFileSync } from "node:child_process";',
        `execFileSync(process.execPath, [${JSON.stringify(authoritativeVerifier)}, ...process.argv.slice(2)], {`,
        '  stdio: "inherit",',
        '  env: { ...process.env, QUALIGENCE_ALLOW_OFFLINE_ATTESTATION_FIXTURES: "true" },',
        "});",
        "",
      ].join("\n")
    : await readFile(authoritativeVerifier);
  await writeFile(
    join(repositoryRoot, "scripts", "verify-release-manifest.mjs"),
    verifierFixture,
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
        items: completeWindowsChecklistItems(),
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
    items: completeWindowsChecklistItems(),
  };
}

function completeWindowsChecklistItems() {
  return Object.entries(REQUIRED_WINDOWS_CHECKLIST_SECTION_COUNTS).flatMap(
    ([section, count]) => {
      const ids =
        section === "16"
          ? [...REQUIRED_SECURITY_VETO_ITEM_IDS]
          : Array.from(
              { length: count },
              (_, index) => `${section}.item-${index + 1}`,
            );
      return ids.map((id, index) => ({
        section,
        id,
        description: `checklist item ${id}`,
        result:
          section === "17" && index > 0
            ? ("not_applicable" as const)
            : ("pass" as const),
        note: "fixture evidence ref",
      }));
    },
  );
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

  it("rejects GitHub closure state without canonical URL/API capture provenance", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "qualigence-freeze-github-capture-"),
    );
    fixtureRoots.push(repositoryRoot);
    const githubClosure = githubClosureFixture();
    githubClosure.capture.source = "caller-assertion";
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
      "GithubCaptureInvalid: github-closure",
    );
  });

  it("rejects Ticket 35 PR identity that is not the Issue 165 closing PR", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "qualigence-freeze-github-ticket35-pr-"),
    );
    fixtureRoots.push(repositoryRoot);
    const githubClosure = githubClosureFixture();
    githubClosure.capture.ticket35ClosingPullRequest = 999;
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
      "GithubPullRequestUnexpected: github-closure",
    );
  });

  it("recomputes the reviewed-to-remote PR diff from local Git objects", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "qualigence-freeze-github-review-diff-"),
    );
    fixtureRoots.push(repositoryRoot);
    const githubClosure = githubClosureFixture();
    await ensureGitObjectStore(repositoryRoot);
    const ticketOne = mutableRecord(
      githubClosure.tickets[0],
      "legacy Ticket 01",
    );
    const pullRequest = mutableRecord(
      ticketOne["pullRequest"],
      "legacy Ticket 01 pull request",
    );
    const remoteHead = String(pullRequest["remoteHead"]);
    const { stdout: reviewedHead } = await execFileAsync("git", [
      "-C",
      repositoryRoot,
      "rev-parse",
      `${remoteHead}^`,
    ]);
    pullRequest["reviewedHead"] = reviewedHead.trim();
    pullRequest["postReviewFiles"] = [];
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
      "GithubReviewedHeadMismatch: github-closure",
    );
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

  it("rejects unauthorized supersession of a canonical implementation ticket", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "qualigence-freeze-github-supersession-"),
    );
    fixtureRoots.push(repositoryRoot);
    const githubClosure = githubClosureFixture();
    const ticketThirty = mutableRecord(
      githubClosure.tickets[29],
      "legacy Ticket 30",
    );
    const issue = mutableRecord(
      ticketThirty["issue"],
      "legacy Ticket 30 issue",
    );
    issue["status"] = "superseded";
    issue["supersededBy"] = 48;
    delete ticketThirty["pullRequest"];
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

  it("rejects an incomplete serialized GitHub check suite", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "qualigence-freeze-github-check-suite-"),
    );
    fixtureRoots.push(repositoryRoot);
    const githubClosure = githubClosureFixture();
    const ticketOne = mutableRecord(
      githubClosure.tickets[0],
      "legacy Ticket 01",
    );
    const pullRequest = mutableRecord(
      ticketOne["pullRequest"],
      "legacy Ticket 01 pull request",
    );
    mutableRecord(pullRequest["checkSuite"], "check suite")["checkCount"] = 2;
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
      "GithubCheckMissing: github-closure",
    );
  });

  it("rejects a non-canonical PR identity even when its status is successful", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "qualigence-freeze-github-pr-identity-"),
    );
    fixtureRoots.push(repositoryRoot);
    const githubClosure = githubClosureFixture();
    const ticketOne = mutableRecord(
      githubClosure.tickets[0],
      "legacy Ticket 01",
    );
    const pullRequest = mutableRecord(
      ticketOne["pullRequest"],
      "legacy Ticket 01 pull request",
    );
    pullRequest["number"] = 999;
    pullRequest["url"] = "https://github.com/ljie-PI/Qualigence/pull/999";
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
      "GithubPullRequestUnexpected: github-closure",
    );
  });

  it("rejects a canonical PR whose merge commit is absent from local ancestry", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "qualigence-freeze-github-local-ancestry-"),
    );
    fixtureRoots.push(repositoryRoot);
    const githubClosure = githubClosureFixture();
    const ticketOne = mutableRecord(
      githubClosure.tickets[0],
      "legacy Ticket 01",
    );
    mutableRecord(ticketOne["pullRequest"], "legacy Ticket 01 pull request")[
      "mergeCommit"
    ] = "f".repeat(40);
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
      "GithubCommitNotAncestor: github-closure",
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
    await writeEvidenceObject(
      repositoryRoot,
      "v0.1.0-candidate",
      "provider.json",
      await readFixtureObject("provider.json"),
    );
    const provider = mutableRecord(
      JSON.parse(
        await readFile(
          join(
            repositoryRoot,
            "artifacts",
            "release",
            "v0.1.0-candidate",
            "provider.json",
          ),
          "utf8",
        ),
      ),
      "materialized provider evidence",
    );
    mutableRecord(provider["provider"], "provider identity")["model"] =
      "different-model";
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

  it("rejects provider redaction evidence whose scanned bytes changed", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "qualigence-freeze-provider-scanned-bytes-"),
    );
    fixtureRoots.push(repositoryRoot);
    const provider = await readFixtureObject("provider.json");
    const reference = await writeEvidenceObject(
      repositoryRoot,
      "v0.1.0-candidate",
      "provider.json",
      provider,
    );
    await writeEvidenceObject(
      repositoryRoot,
      "v0.1.0-candidate",
      "provider-output-stdout.json",
      { scope: "stdout", content: "changed after scan" },
    );

    const result = await finalizeGraphFreezeFromEvidence(
      finalizerInput(repositoryRoot, {
        evidence: { provider: reference },
      }),
    );

    expect(result.decision.blockingReasons).toContain(
      "EvidenceHashMismatch: provider",
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
  });

  it("never forwards the Ticket 34 offline-attestation fixture override", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "qualigence-freeze-offline-attestation-"),
    );
    fixtureRoots.push(repositoryRoot);
    const version = "v0.1.0-candidate";
    const releaseManifest = await writeReleaseFixture(
      repositoryRoot,
      version,
      false,
    );
    const previousOfflineMode =
      process.env["QUALIGENCE_ALLOW_OFFLINE_ATTESTATION_FIXTURES"];
    const previousVerification = process.env["QUALIGENCE_VERIFY_ATTESTATIONS"];
    process.env["QUALIGENCE_ALLOW_OFFLINE_ATTESTATION_FIXTURES"] = "true";
    delete process.env["QUALIGENCE_VERIFY_ATTESTATIONS"];
    try {
      const result = await finalizeGraphFreezeFromEvidence(
        finalizerInput(repositoryRoot, {
          evidence: { releaseManifest },
        }),
      );

      expect(result.decision.blockingReasons).toContain(
        "AttestationVerificationUnavailable: release-manifest",
      );
      expect(result.decision.status).toBe("candidate");
      expect(result.decision.signoff).toBeUndefined();
    } finally {
      if (previousOfflineMode === undefined) {
        delete process.env["QUALIGENCE_ALLOW_OFFLINE_ATTESTATION_FIXTURES"];
      } else {
        process.env["QUALIGENCE_ALLOW_OFFLINE_ATTESTATION_FIXTURES"] =
          previousOfflineMode;
      }
      if (previousVerification === undefined) {
        delete process.env["QUALIGENCE_VERIFY_ATTESTATIONS"];
      } else {
        process.env["QUALIGENCE_VERIFY_ATTESTATIONS"] = previousVerification;
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
      code: "BenchmarkSourceInvalid",
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
    {
      name: "benchmark manifest substituted from outside selected commit",
      key: "benchmark",
      filename: "benchmark.json",
      code: "BenchmarkSourceInvalid",
      mutate: (evidence: Record<string, unknown>) => {
        const manifest = mutableRecord(
          evidence["manifest"],
          "benchmark manifest",
        );
        const scenarios = manifest["scenarios"];
        if (!Array.isArray(scenarios)) {
          throw new Error("benchmark fixture has no scenario manifest");
        }
        scenarios.pop();
      },
    },
    {
      name: "modified benchmark runner input",
      key: "benchmark",
      filename: "benchmark.json",
      code: "BenchmarkReportInvalid",
      mutate: (evidence: Record<string, unknown>) => {
        const runnerInputs = mutableRecord(
          evidence["runnerInputs"],
          "benchmark runner inputs",
        );
        const definitions = runnerInputs["scenarioDefinitions"];
        if (!Array.isArray(definitions) || definitions[0] === undefined) {
          throw new Error("benchmark fixture has no scenario definitions");
        }
        const states = mutableRecord(
          definitions[0],
          "benchmark scenario definition",
        )["states"];
        if (!Array.isArray(states) || states[0] === undefined) {
          throw new Error("benchmark scenario definition has no states");
        }
        mutableRecord(states[0], "benchmark scenario state")[
          "observationGraphSha256"
        ] = "f".repeat(64);
      },
    },
    {
      name: "malformed benchmark scenario binding",
      key: "benchmark",
      filename: "benchmark.json",
      code: "BenchmarkSourceInvalid",
      mutate: (evidence: Record<string, unknown>) => {
        const runnerInputs = mutableRecord(
          evidence["runnerInputs"],
          "benchmark runner inputs",
        );
        const definitions = runnerInputs["scenarioDefinitions"];
        if (!Array.isArray(definitions) || definitions[0] === undefined) {
          throw new Error("benchmark fixture has no scenario definitions");
        }
        const states = mutableRecord(
          definitions[0],
          "benchmark scenario definition",
        )["states"];
        if (!Array.isArray(states) || states[0] === undefined) {
          throw new Error("benchmark scenario definition has no states");
        }
        mutableRecord(states[0], "benchmark scenario state")["signals"] =
          "not-an-array";
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
    ["duplicate Windows checklist item", "WindowsEvidenceItemDuplicate"],
    ["incomplete Windows checklist", "WindowsEvidenceItemMissing"],
    ["duplicate Windows signer", "WindowsEvidenceSignerInvalid"],
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
    } else if (
      scenario === "failed Windows veto" ||
      scenario === "duplicate Windows checklist item" ||
      scenario === "incomplete Windows checklist" ||
      scenario === "duplicate Windows signer"
    ) {
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
      if (scenario === "duplicate Windows signer") {
        const signatures = windows["WindowsChecklistSignatures"];
        if (!Array.isArray(signatures) || signatures[0] === undefined) {
          throw new Error("Windows fixture has no signature");
        }
        signatures.push(structuredClone(signatures[0]));
      } else {
        const items = checklist["items"];
        if (!Array.isArray(items) || items[0] === undefined) {
          throw new Error("Windows fixture has no checklist item");
        }
        if (scenario === "failed Windows veto") {
          const veto = items.find(
            (value) =>
              mutableRecord(value, "Windows checklist item")["section"] ===
              "16",
          );
          if (veto === undefined) {
            throw new Error("Windows fixture has no veto item");
          }
          mutableRecord(veto, "Windows checklist veto")["result"] = "fail";
        } else if (scenario === "duplicate Windows checklist item") {
          items.push(structuredClone(items[0]));
        } else {
          items.shift();
        }
      }
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

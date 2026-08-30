import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const script = fileURLToPath(new URL("../../scripts/verify-release-manifest.mjs", import.meta.url));
const fixtureRoots: string[] = [];
const commit = "153d61d1785acf530abd274ac203356c58614e56";
const digestA = `sha256:${"a".repeat(64)}`;
const digestB = `sha256:${"b".repeat(64)}`;
const hashE = "e".repeat(64);
const requiredSecurityVetoIds = [
  "16.permit-binding-enforced",
  "16.high-risk-authorization-required",
  "16.emergency-stop-blocks-new-actions",
  "16.no-secret-plaintext-logs",
  "16.no-companion-bypass-approval",
  "16.no-direct-uia-or-pid-management",
  "16.named-pipe-identity-enforced",
  "16.uia-hang-does-not-kill-companion",
  "16.no-out-of-job-name-or-pid-kill",
  "16.trace-integrity-conflicts-rejected",
  "16.unsigned-skill-not-executed",
  "16.crash-signals-not-suppressed",
  "16.unknown-side-effect-not-replayed",
];

function buildGateArchive(name: string, archiveCommit = commit) {
  const vitest = JSON.stringify({ numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0 }) + "\n";
  const report = JSON.stringify({ schemaVersion: "qualigence-gate-report/v1", gate: name, commit: archiveCommit, command: ["pnpm", "vitest", "run"], selection: ["tests"], counts: { passed: 1, failed: 0, skipped: 0, todo: 0 }, status: "passed", environment: {}, files: [{ path: "vitest.json", sha256: sha256(vitest), bytes: Buffer.byteLength(vitest) }] }, null, 2) + "\n";
  const marker = JSON.stringify({ schemaVersion: "qualigence-gate-accepted/v1", gate: name, commit: archiveCommit, report: "report.json", reportSha256: sha256(report), status: "accepted" }, null, 2) + "\n";
  const hashManifest = `${sha256(report)}  ${name}/report.json\n${sha256(marker)}  ${name}/accepted.json\n${sha256(vitest)}  ${name}/vitest.json\n`;
  const receipt = JSON.stringify({ schemaVersion: "qualigence-gate-artifact-receipt/v1", gate: name, commit: archiveCommit, report: `${name}/report.json`, reportSha256: sha256(report), marker: `${name}/accepted.json`, markerSha256: sha256(marker), hashManifest: "sha256.txt", hashManifestSha256: sha256(hashManifest) }, null, 2) + "\n";
  const bytes = zipStore({
    "receipt.json": receipt,
    [`${name}/report.json`]: report,
    [`${name}/accepted.json`]: marker,
    [`${name}/vitest.json`]: vitest,
    "sha256.txt": hashManifest,
  });
  return {
    bytes,
    archiveSha256: sha256(bytes),
    reportSha256: sha256(report),
    vitestSha256: sha256(vitest),
    receiptSha256: sha256(receipt),
  };
}

async function writeFixture() {
  const version = `test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const root = join(process.cwd(), "artifacts", "release", version);
  fixtureRoots.push(root);
  await mkdir(join(root, "gates"), { recursive: true });
  await mkdir(join(root, "docs/testing"), { recursive: true });
  const fixturePrefix = relative(process.cwd(), root).replaceAll("\\", "/");
  const sbomPath = `${fixturePrefix}/sbom.spdx.json`;
  const windowsPath = `${fixturePrefix}/docs/testing/windows-m3-manual-checklist.signed.json`;
  const sbom = JSON.stringify({
    spdxVersion: "SPDX-2.3",
    SPDXID: "SPDXRef-DOCUMENT",
    name: "fixture",
    documentComment: JSON.stringify({
      repository: "ljie-PI/Qualigence",
      commit,
      applicationReference: `ghcr.io/ljie-pi/qualigence/self-hosted@${digestA}`,
      consoleReference: `ghcr.io/ljie-pi/qualigence/self-hosted-console@${digestB}`,
    }),
    creationInfo: { created: "1970-01-01T00:00:00.000Z", creators: ["Tool: fixture"] },
  }, null, 2) + "\n";
  const operatorSignature = "fixture-signature-human-a";
  const reviewerSignature = "fixture-signature-human-b";
  const operatorSignatureSha256 = sha256(operatorSignature);
  const reviewerSignatureSha256 = sha256(reviewerSignature);
  const windows = JSON.stringify({
    WindowsChecklistEvidence: {
      checklistVersion: "windows-m3-manual-checklist/v1",
      commit,
      productVersion: version,
      runnerProtocolVersion: "runner-protocol/v1",
      windowsBuild: "Windows 11 23H2 22631",
      interactiveSessionType: "local",
      operatorName: "human-a",
      reviewerName: "human-b",
      executedAt: "2026-08-29T00:00:00.000Z",
      evidenceRefs: ["run:windows-native-local", "run:windows-native-rdp", "artifact:windows-native-1"],
      sessionEvidence: { local: ["run:windows-native-local"], rdp: ["run:windows-native-rdp"] },
      securityVetoItemIds: requiredSecurityVetoIds,
      items: requiredSecurityVetoIds.map((id) => ({ section: "16", id, description: id, result: "pass", note: "fixture evidence ref" })),
    },
    WindowsChecklistSignatures: [
      { signer: "human-a", signedAt: "2026-08-29T00:00:00.000Z", signature: operatorSignature, signatureSha256: operatorSignatureSha256 },
      { signer: "human-b", signedAt: "2026-08-29T00:00:00.000Z", signature: reviewerSignature, signatureSha256: reviewerSignatureSha256 },
    ],
  }, null, 2) + "\n";
  await writeFile(join(process.cwd(), sbomPath), sbom, "utf8");
  await writeFile(join(process.cwd(), windowsPath), windows, "utf8");
  const gateArchives = new Map<string, { path: string; sha256: string; reportSha256: string; vitestSha256: string; receiptSha256: string }>();
  for (const name of ["gate-linux", "gate-windows-rust", "gate-self-hosted", "browser-e2e"]) {
    const archivePath = `${fixturePrefix}/gates/${name}.zip`;
    const archive = buildGateArchive(name);
    await writeFile(join(process.cwd(), archivePath), archive.bytes);
    gateArchives.set(name, { path: archivePath, sha256: archive.archiveSha256, reportSha256: archive.reportSha256, vitestSha256: archive.vitestSha256, receiptSha256: archive.receiptSha256 });
  }
  const gateDeliveries = ["gate-linux", "gate-windows-rust", "gate-self-hosted", "browser-e2e"].map((name, index) => ({
    gate: name,
    artifactId: String(index + 100),
    runId: String(index + 200),
    commit,
    reportSha256: gateArchives.get(name)!.reportSha256,
    vitestSha256: gateArchives.get(name)!.vitestSha256,
    receiptSha256: gateArchives.get(name)!.receiptSha256,
  }));
  const gateEvidence = { schemaVersion: "qualigence-release-gate-evidence/v1", commit, status: "verified", deliveries: gateDeliveries, rejectedDeliveries: [] };
  const applicationName = "ghcr.io/ljie-pi/qualigence/self-hosted";
  const consoleName = "ghcr.io/ljie-pi/qualigence/self-hosted-console";
  const applicationReference = `${applicationName}@${digestA}`;
  const consoleReference = `${consoleName}@${digestB}`;
  const appProvenancePath = `${fixturePrefix}/attestations/application-provenance.bundle.json`;
  const appSbomPath = `${fixturePrefix}/attestations/application-sbom.bundle.json`;
  const consoleProvenancePath = `${fixturePrefix}/attestations/console-provenance.bundle.json`;
  const consoleSbomPath = `${fixturePrefix}/attestations/console-sbom.bundle.json`;
  await mkdir(join(root, "attestations"), { recursive: true });
  const appProvenance = attestationBundle(applicationName, digestA, "https://slsa.dev/provenance/v1");
  const appSbom = attestationBundle(applicationName, digestA, "https://spdx.dev/Document");
  const consoleProvenance = attestationBundle(consoleName, digestB, "https://slsa.dev/provenance/v1");
  const consoleSbom = attestationBundle(consoleName, digestB, "https://spdx.dev/Document");
  await writeFile(join(process.cwd(), appProvenancePath), appProvenance, "utf8");
  await writeFile(join(process.cwd(), appSbomPath), appSbom, "utf8");
  await writeFile(join(process.cwd(), consoleProvenancePath), consoleProvenance, "utf8");
  await writeFile(join(process.cwd(), consoleSbomPath), consoleSbom, "utf8");
  const sbomSha = sha256(sbom);
  const windowsSha = sha256(windows);
  const manifest = {
    schemaVersion: "qualigence-release-manifest/v1",
    version,
    repository: "ljie-PI/Qualigence",
    commit,
    generatedAt: "2026-08-29T00:00:00.000Z",
    images: {
      application: { name: applicationName, digest: digestA, reference: applicationReference, provenance: { attestationId: "https://github.com/ljie-PI/Qualigence/attestations/app", bundle: appProvenance, bundleSha256: sha256(appProvenance), sbomAttestationId: "https://github.com/ljie-PI/Qualigence/attestations/app-sbom", sbomBundle: appSbom, sbomBundleSha256: sha256(appSbom) } },
      console: { name: consoleName, digest: digestB, reference: consoleReference, provenance: { attestationId: "https://github.com/ljie-PI/Qualigence/attestations/console", bundle: consoleProvenance, bundleSha256: sha256(consoleProvenance), sbomAttestationId: "https://github.com/ljie-PI/Qualigence/attestations/console-sbom", sbomBundle: consoleSbom, sbomBundleSha256: sha256(consoleSbom) } },
    },
    sbom: { path: sbomPath, sha256: sbomSha, format: "spdx-json" },
    gateEvidence,
    gates: gateDeliveries.map((delivery) => ({
      name: delivery.gate,
      artifactName: `${delivery.gate}.zip`,
      artifactPath: gateArchives.get(delivery.gate)!.path,
      artifactSha256: gateArchives.get(delivery.gate)!.sha256,
      artifactId: delivery.artifactId,
      runId: delivery.runId,
      commit,
      reportSha256: delivery.reportSha256,
      vitestSha256: delivery.vitestSha256,
      receiptSha256: delivery.receiptSha256,
    })),
    windowsEvidence: {
      path: windowsPath,
      sha256: windowsSha,
      commit,
      signatures: [
        { signer: "human-a", signedAt: "2026-08-29T00:00:00.000Z", signatureSha256: operatorSignatureSha256 },
        { signer: "human-b", signedAt: "2026-08-29T00:00:00.000Z", signatureSha256: reviewerSignatureSha256 },
      ],
    },
  };
  const manifestPath = join(root, "release-manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return { root, manifestPath, manifest };
}

function sha256(text: string | Buffer) {
  return createHash("sha256").update(text).digest("hex");
}

function crc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function attestationBundle(subjectName: string, digest: string, predicateType: string, sourceCommit = commit) {
  const payload = {
    _type: "https://in-toto.io/Statement/v1",
    predicateType,
    subject: [{ name: subjectName, digest: { sha256: digest.slice("sha256:".length) } }],
    predicate: { buildDefinition: { externalParameters: { repository: "ljie-PI/Qualigence", commit: sourceCommit } } },
  };
  return JSON.stringify({ dsseEnvelope: { payload: Buffer.from(JSON.stringify(payload), "utf8").toString("base64"), signatures: [{ sig: "fixture" }] } }, null, 2) + "\n";
}

function zipStore(entries: Record<string, string>) {
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
    local.writeUInt16LE(0, 8);
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
    central.writeUInt16LE(0, 10);
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

async function runVerifier(manifestPath: string, cwd: string, extra: string[] = []) {
  const env = { ...process.env };
  delete env.GH_TOKEN;
  delete env.GITHUB_REPOSITORY;
  env.QUALIGENCE_ALLOW_OFFLINE_ATTESTATION_FIXTURES = "true";
  return execFileAsync(process.execPath, [script, "verify", "--manifest", manifestPath, ...extra], { cwd, env });
}

async function runVerifierWithGithubEnvironment(manifestPath: string, cwd: string) {
  const env = {
    ...process.env,
    GH_TOKEN: "unused-test-token",
    GITHUB_REPOSITORY: "ljie-PI/Qualigence",
    QUALIGENCE_ALLOW_OFFLINE_ATTESTATION_FIXTURES: "true",
  };
  return execFileAsync(process.execPath, [script, "verify", "--manifest", manifestPath], { cwd, env });
}

async function runVerifierWithoutOfflineAttestation(manifestPath: string, cwd: string) {
  const env = { ...process.env };
  delete env.GH_TOKEN;
  delete env.GITHUB_REPOSITORY;
  delete env.QUALIGENCE_ALLOW_OFFLINE_ATTESTATION_FIXTURES;
  delete env.QUALIGENCE_VERIFY_ATTESTATIONS;
  return execFileAsync(process.execPath, [script, "verify", "--manifest", manifestPath], { cwd, env });
}

async function runScanner(root: string) {
  return execFileAsync(process.execPath, [script, "scan-root", "--roots", root], { cwd: process.cwd() });
}

async function runWriteSbom(root: string, output: string) {
  return execFileAsync(process.execPath, [script, "write-sbom", "--roots", root, "--output", output], { cwd: process.cwd() });
}

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("release runtime-root scanner", () => {
  it("accepts production dist and dependency metadata without devDependencies", async () => {
    const root = join(process.cwd(), `.tmp-release-root-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fixtureRoots.push(root);
    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(join(root, "package.json"), `${JSON.stringify({ name: "fixture", dependencies: { fastify: "5.11.0" }, devDependencies: {} })}\n`, "utf8");
    await writeFile(join(root, "dist/main.js"), "console.log('ok');\n", "utf8");
    await expect(runScanner(root)).resolves.toMatchObject({ stdout: expect.stringContaining('"status": "clean"') });
  });

  it("writes SBOMs atomically and refuses to overwrite an existing release artifact", async () => {
    const root = join(process.cwd(), `.tmp-release-root-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fixtureRoots.push(root);
    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(join(root, "package.json"), `${JSON.stringify({ name: "fixture", version: "0.0.0", dependencies: {} })}\n`, "utf8");
    await writeFile(join(root, "dist/main.js"), "console.log('ok');\n", "utf8");
    const output = join(root, "sbom.spdx.json");
    await expect(runWriteSbom(root, output)).resolves.toMatchObject({ stdout: expect.stringContaining('"status": "written"') });
    await expect(runWriteSbom(root, output)).rejects.toMatchObject({ stderr: expect.stringContaining("ReleaseArtifactAlreadyExists") });
  });

  it("rejects source, tests, sourcemaps, and runtime package devDependencies", async () => {
    const root = join(process.cwd(), `.tmp-release-root-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fixtureRoots.push(root);
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "node_modules/vitest"), { recursive: true });
    await writeFile(join(root, "package.json"), `${JSON.stringify({ name: "fixture", dependencies: { fastify: "5.11.0" }, devDependencies: { vitest: "4.0.0" } })}\n`, "utf8");
    await writeFile(join(root, "dist.js.map"), "{}\n", "utf8");
    await expect(runScanner(root)).rejects.toMatchObject({ stderr: expect.stringContaining("RuntimeImageForbiddenContent") });
  });
});

describe("release manifest verifier", () => {
  it("requires materialized Gate paths in the persisted manifest schema", async () => {
    const schema = JSON.parse(await readFile("deployments/self-hosted/compose/release-manifest.schema.json", "utf8"));
    expect(schema.$defs.gate.required).toContain("artifactPath");
    expect(schema.$defs.gateEvidence.properties.deliveries).toMatchObject({ minItems: 4, maxItems: 4 });
  });

  it("rejects dot-segment aliases in the schema and verifier", async () => {
    const schema = JSON.parse(await readFile("deployments/self-hosted/compose/release-manifest.schema.json", "utf8"));
    const artifactPathPattern = new RegExp(schema.$defs.gate.properties.artifactPath.pattern);
    expect(artifactPathPattern.test("./artifacts/release/v1/gates/gate-linux.zip")).toBe(false);
    expect(artifactPathPattern.test("artifacts/release/v1/gates/./gate-linux.zip")).toBe(false);

    const { manifestPath, manifest } = await writeFixture();
    manifest.gates[0]!.artifactPath = manifest.gates[0]!.artifactPath.replace("/gates/", "/gates/./");
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    await expect(runVerifier(manifestPath, process.cwd())).rejects.toMatchObject({ stderr: expect.stringContaining("GateArtifactPathInvalid") });
  });

  it("rejects absolute and traversing Gate artifact paths in the schema and verifier", async () => {
    const schema = JSON.parse(await readFile("deployments/self-hosted/compose/release-manifest.schema.json", "utf8"));
    const artifactPathPattern = new RegExp(schema.$defs.gate.properties.artifactPath.pattern);
    expect(artifactPathPattern.test("C:/release/gate-linux.zip")).toBe(false);
    expect(artifactPathPattern.test("../artifacts/release/v1/gates/gate-linux.zip")).toBe(false);

    const absolute = await writeFixture();
    absolute.manifest.gates[0]!.artifactPath = join(process.cwd(), absolute.manifest.gates[0]!.artifactPath).replaceAll("\\", "/");
    await writeFile(absolute.manifestPath, JSON.stringify(absolute.manifest, null, 2) + "\n", "utf8");
    await expect(runVerifier(absolute.manifestPath, process.cwd())).rejects.toMatchObject({ stderr: expect.stringContaining("GateArtifactPathInvalid") });

    const traversing = await writeFixture();
    traversing.manifest.gates[0]!.artifactPath = traversing.manifest.gates[0]!.artifactPath.replace("/gates/", "/gates/../gates/");
    await writeFile(traversing.manifestPath, JSON.stringify(traversing.manifest, null, 2) + "\n", "utf8");
    await expect(runVerifier(traversing.manifestPath, process.cwd())).rejects.toMatchObject({ stderr: expect.stringContaining("GateArtifactPathInvalid") });
  });

  it("rejects a release version that aliases a filesystem directory", async () => {
    const { manifestPath, manifest } = await writeFixture();
    manifest.version = "..";
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    await expect(runVerifier(manifestPath, process.cwd())).rejects.toMatchObject({ stderr: expect.stringContaining("ReleaseVersionInvalid") });
  });

  it("rejects a manifest outside the canonical artifacts/release root", async () => {
    const { root, manifest } = await writeFixture();
    const canonicalPrefix = relative(process.cwd(), root).replaceAll("\\", "/");
    const alternateBase = join(process.cwd(), `.tmp-release-alternate-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const alternateRoot = join(alternateBase, "artifacts", "release", manifest.version);
    fixtureRoots.push(alternateBase);
    await mkdir(dirname(alternateRoot), { recursive: true });
    await rename(root, alternateRoot);
    const alternatePrefix = `artifacts/release/${manifest.version}`;
    const alternateManifest = JSON.parse(JSON.stringify(manifest).replaceAll(canonicalPrefix, alternatePrefix));
    const alternateManifestPath = join(alternateRoot, "release-manifest.json");
    await writeFile(alternateManifestPath, JSON.stringify(alternateManifest, null, 2) + "\n", "utf8");
    await expect(runVerifier(alternateManifestPath, alternateBase)).rejects.toMatchObject({ stderr: expect.stringContaining("CanonicalReleasePathInvalid") });
  });

  it("accepts one immutable manifest that binds images, SBOM, Gates, and signed Windows evidence", async () => {
    const { root, manifestPath } = await writeFixture();
    const rendered = join(root, "compose.release.rendered.yaml");
    const { stdout } = await runVerifier(manifestPath, process.cwd(), ["--repository", "ljie-PI/Qualigence", "--commit", commit, "--render-compose", rendered]);
    expect(JSON.parse(stdout)).toMatchObject({ status: "verified", repository: "ljie-PI/Qualigence", commit });
    const compose = await readFile(rendered, "utf8");
    expect(compose).toContain(`ghcr.io/ljie-pi/qualigence/self-hosted@${digestA}`);
    expect(compose).toContain(`ghcr.io/ljie-pi/qualigence/self-hosted-console@${digestB}`);
    expect(compose).not.toContain(":v0.1.0");
  });

  it("reverifies identical materialized release evidence without changing it", async () => {
    const { manifestPath } = await writeFixture();
    const first = await runVerifier(manifestPath, process.cwd());
    const second = await runVerifier(manifestPath, process.cwd());
    expect(second.stdout).toBe(first.stdout);
  });

  it("fails closed when production attestation verification is not enabled", async () => {
    const { manifestPath } = await writeFixture();
    await expect(runVerifierWithoutOfflineAttestation(manifestPath, process.cwd())).rejects.toMatchObject({ stderr: expect.stringContaining("AttestationVerificationUnavailable") });
  });

  it("rejects schema-unsupported extra manifest fields", async () => {
    const { manifestPath, manifest } = await writeFixture();
    (manifest as Record<string, unknown>).extra = "not allowed";
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    await expect(runVerifier(manifestPath, process.cwd())).rejects.toMatchObject({ stderr: expect.stringContaining("ManifestSchemaInvalid") });
  });

  it("rejects attestation bundles that do not bind the manifest commit", async () => {
    const { manifestPath, manifest } = await writeFixture();
    const staleBundle = attestationBundle(manifest.images.application.name, manifest.images.application.digest, "https://slsa.dev/provenance/v1", "0".repeat(40));
    manifest.images.application.provenance.bundle = staleBundle;
    manifest.images.application.provenance.bundleSha256 = sha256(staleBundle);
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    await expect(runVerifier(manifestPath, process.cwd())).rejects.toMatchObject({ stderr: expect.stringContaining("AttestationCommitMismatch") });
  });

  it("rejects attestation URLs outside the manifest repository", async () => {
    const { manifestPath, manifest } = await writeFixture();
    manifest.images.application.provenance.attestationId = "https://example.test/attestations/app";
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    await expect(runVerifier(manifestPath, process.cwd())).rejects.toMatchObject({ stderr: expect.stringContaining("AttestationReferenceInvalid") });
  });

  it("rejects SBOM bindings that do not match the manifest image subjects", async () => {
    const { manifestPath, manifest } = await writeFixture();
    const badSbom = JSON.stringify({
      spdxVersion: "SPDX-2.3",
      SPDXID: "SPDXRef-DOCUMENT",
      name: "fixture",
      documentComment: JSON.stringify({ repository: "ljie-PI/Qualigence", commit, applicationReference: "ghcr.io/ljie-pi/qualigence/self-hosted@sha256:bad", consoleReference: `ghcr.io/ljie-pi/qualigence/self-hosted-console@${digestB}` }),
      creationInfo: { created: "1970-01-01T00:00:00.000Z", creators: ["Tool: fixture"] },
    }, null, 2) + "\n";
    await writeFile(join(process.cwd(), manifest.sbom.path), badSbom, "utf8");
    manifest.sbom.sha256 = sha256(badSbom);
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    await expect(runVerifier(manifestPath, process.cwd())).rejects.toMatchObject({ stderr: expect.stringContaining("SbomBindingMismatch") });
  });

  it("rejects mutable tags even when a digest is also present", async () => {
    const { manifestPath, manifest } = await writeFixture();
    manifest.images.application.reference = `ghcr.io/ljie-pi/qualigence/self-hosted:latest@${digestA}`;
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    await expect(runVerifier(manifestPath, process.cwd())).rejects.toMatchObject({ stderr: expect.stringContaining("MutableImageReference") });
  });

  it("rejects hash-matched Gate artifact paths that are not ZIP archives", async () => {
    const { manifestPath, manifest } = await writeFixture();
    const plain = "plain text artifact\n";
    await writeFile(join(process.cwd(), manifest.gates[0]!.artifactPath), plain, "utf8");
    manifest.gates[0]!.artifactSha256 = sha256(plain);
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    await expect(runVerifier(manifestPath, process.cwd())).rejects.toMatchObject({ stderr: expect.stringContaining("GateArtifactArchiveInvalid") });
  });

  it("requires a materialized artifactPath for every Gate", async () => {
    const { manifestPath, manifest } = await writeFixture();
    delete (manifest.gates[0]! as Record<string, unknown>).artifactPath;
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    await expect(runVerifierWithGithubEnvironment(manifestPath, process.cwd())).rejects.toMatchObject({ stderr: expect.stringContaining("GateArtifactPathRequired") });
  });

  it("rejects a Gate artifactPath outside the selected release directory", async () => {
    const { root, manifestPath, manifest } = await writeFixture();
    const gate = manifest.gates[0]!;
    const outsideDirectory = join(root, "gate-artifacts");
    await mkdir(outsideDirectory, { recursive: true });
    const outsidePath = join(outsideDirectory, gate.artifactName);
    await writeFile(outsidePath, await readFile(join(process.cwd(), gate.artifactPath)));
    gate.artifactPath = relative(process.cwd(), outsidePath).replaceAll("\\", "/");
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    await expect(runVerifier(manifestPath, process.cwd())).rejects.toMatchObject({ stderr: expect.stringContaining("GateArtifactPathInvalid") });
  });

  it("rejects a Gate that reuses another Gate's artifact name", async () => {
    const { manifestPath, manifest } = await writeFixture();
    manifest.gates[1]!.artifactName = manifest.gates[0]!.artifactName;
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    await expect(runVerifier(manifestPath, process.cwd())).rejects.toMatchObject({ stderr: expect.stringContaining("GateArtifactNameInvalid") });
  });

  it("rejects Gate records that reuse an artifact ID", async () => {
    const { manifestPath, manifest } = await writeFixture();
    manifest.gates[1]!.artifactId = manifest.gates[0]!.artifactId;
    manifest.gateEvidence.deliveries[1]!.artifactId = manifest.gateEvidence.deliveries[0]!.artifactId;
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    await expect(runVerifier(manifestPath, process.cwd())).rejects.toMatchObject({ stderr: expect.stringContaining("GateArtifactIdDuplicate") });
  });

  it("rejects duplicate deliveries in the serialized Gate evidence report", async () => {
    const { manifestPath, manifest } = await writeFixture();
    manifest.gateEvidence.deliveries.push({ ...manifest.gateEvidence.deliveries[0]! });
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    await expect(runVerifier(manifestPath, process.cwd())).rejects.toMatchObject({ stderr: expect.stringContaining("GateEvidenceDeliveryDuplicate") });
  });

  it("rejects unexpected, missing, or cross-commit serialized Gate deliveries", async () => {
    const unexpected = await writeFixture();
    unexpected.manifest.gateEvidence.deliveries.push({
      ...unexpected.manifest.gateEvidence.deliveries[0]!,
      gate: "gate-unexpected",
      artifactId: "999",
    });
    await writeFile(unexpected.manifestPath, JSON.stringify(unexpected.manifest, null, 2) + "\n", "utf8");
    await expect(runVerifier(unexpected.manifestPath, process.cwd())).rejects.toMatchObject({ stderr: expect.stringContaining("GateEvidenceDeliveryUnexpected") });

    const missing = await writeFixture();
    missing.manifest.gateEvidence.deliveries.pop();
    await writeFile(missing.manifestPath, JSON.stringify(missing.manifest, null, 2) + "\n", "utf8");
    await expect(runVerifier(missing.manifestPath, process.cwd())).rejects.toMatchObject({ stderr: expect.stringContaining("GateEvidenceDeliveryMissing") });

    const crossCommit = await writeFixture();
    crossCommit.manifest.gateEvidence.deliveries[0]!.commit = "0".repeat(40);
    await writeFile(crossCommit.manifestPath, JSON.stringify(crossCommit.manifest, null, 2) + "\n", "utf8");
    await expect(runVerifier(crossCommit.manifestPath, process.cwd())).rejects.toMatchObject({ stderr: expect.stringContaining("GateEvidenceDeliveryCommitMismatch") });
  });

  it("rejects Gate records that reuse a materialized path", async () => {
    const { manifestPath, manifest } = await writeFixture();
    manifest.gates[1]!.artifactPath = manifest.gates[0]!.artifactPath;
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    await expect(runVerifier(manifestPath, process.cwd())).rejects.toMatchObject({ stderr: expect.stringContaining("GateArtifactPathDuplicate") });
  });

  it("rejects a symlinked Gate archive directory at the expected materialized path", async () => {
    const { manifestPath, manifest } = await writeFixture();
    const gate = manifest.gates[0]!;
    const gateDirectory = dirname(join(process.cwd(), gate.artifactPath));
    const targetDirectory = `${gateDirectory}-source`;
    await rename(gateDirectory, targetDirectory);
    await symlink(targetDirectory, gateDirectory, "junction");
    await expect(runVerifier(manifestPath, process.cwd())).rejects.toMatchObject({ stderr: expect.stringContaining("GateArtifactSymlink") });
  });

  it("rejects a missing or hash-mismatched materialized Gate archive", async () => {
    const missing = await writeFixture();
    await rm(join(process.cwd(), missing.manifest.gates[0]!.artifactPath));
    await expect(runVerifier(missing.manifestPath, process.cwd())).rejects.toMatchObject({ stderr: expect.stringContaining("GateArtifactMissing") });

    const mismatch = await writeFixture();
    mismatch.manifest.gates[0]!.artifactSha256 = "0".repeat(64);
    await writeFile(mismatch.manifestPath, JSON.stringify(mismatch.manifest, null, 2) + "\n", "utf8");
    await expect(runVerifier(mismatch.manifestPath, process.cwd())).rejects.toMatchObject({ stderr: expect.stringContaining("GateArtifactHashMismatch") });
  });

  it("rejects a stale Gate archive even when its outer hashes are rewritten", async () => {
    const { manifestPath, manifest } = await writeFixture();
    const gate = manifest.gates[0]!;
    const delivery = manifest.gateEvidence.deliveries.find((candidate) => candidate.gate === gate.name)!;
    const stale = buildGateArchive(gate.name, "0".repeat(40));
    await writeFile(join(process.cwd(), gate.artifactPath), stale.bytes);
    gate.artifactSha256 = stale.archiveSha256;
    gate.reportSha256 = stale.reportSha256;
    gate.vitestSha256 = stale.vitestSha256;
    gate.receiptSha256 = stale.receiptSha256;
    delivery.reportSha256 = stale.reportSha256;
    delivery.vitestSha256 = stale.vitestSha256;
    delivery.receiptSha256 = stale.receiptSha256;
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    await expect(runVerifier(manifestPath, process.cwd())).rejects.toMatchObject({ stderr: expect.stringContaining("GateArtifactReceiptInvalid") });
  });

  it("rejects missing, duplicate, unexpected, or cross-commit Gate evidence", async () => {
    const duplicate = await writeFixture();
    duplicate.manifest.gates[0] = { ...duplicate.manifest.gates[3]! };
    await writeFile(duplicate.manifestPath, JSON.stringify(duplicate.manifest, null, 2) + "\n", "utf8");
    await expect(runVerifier(duplicate.manifestPath, process.cwd())).rejects.toMatchObject({ stderr: expect.stringContaining("GateArtifactDuplicate") });

    const crossCommit = await writeFixture();
    crossCommit.manifest.gates[1]!.commit = "0".repeat(40);
    await writeFile(crossCommit.manifestPath, JSON.stringify(crossCommit.manifest, null, 2) + "\n", "utf8");
    await expect(runVerifier(crossCommit.manifestPath, process.cwd())).rejects.toMatchObject({ stderr: expect.stringContaining("GateArtifactCommitMismatch") });
  });

  it("rejects repository path traversal for referenced evidence files", async () => {
    const { manifestPath, manifest } = await writeFixture();
    manifest.sbom.path = "../outside/sbom.spdx.json";
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    await expect(runVerifier(manifestPath, process.cwd())).rejects.toMatchObject({ stderr: expect.stringContaining("ReferencedPathInvalid") });
  });

  it("rejects Windows checklist evidence without both local-console and RDP session evidence", async () => {
    const { root, manifestPath, manifest } = await writeFixture();
    const evidence = JSON.parse(await readFile(join(root, "docs/testing/windows-m3-manual-checklist.signed.json"), "utf8"));
    evidence.WindowsChecklistEvidence.sessionEvidence = { local: ["run:windows-native-local"], rdp: [] };
    const bytes = `${JSON.stringify(evidence, null, 2)}\n`;
    await writeFile(join(root, "docs/testing/windows-m3-manual-checklist.signed.json"), bytes, "utf8");
    manifest.windowsEvidence.sha256 = sha256(bytes);
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    await expect(runVerifier(manifestPath, process.cwd())).rejects.toMatchObject({ stderr: expect.stringContaining("WindowsEvidenceSessionMissing") });
  });

  it("rejects embedded Windows checklist evidence without the manifest commit", async () => {
    const { root, manifestPath, manifest } = await writeFixture();
    const evidence = JSON.parse(await readFile(join(root, "docs/testing/windows-m3-manual-checklist.signed.json"), "utf8"));
    delete evidence.WindowsChecklistEvidence.commit;
    const bytes = `${JSON.stringify(evidence, null, 2)}\n`;
    await writeFile(join(root, "docs/testing/windows-m3-manual-checklist.signed.json"), bytes, "utf8");
    manifest.windowsEvidence.sha256 = sha256(bytes);
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    await expect(runVerifier(manifestPath, process.cwd())).rejects.toMatchObject({ stderr: expect.stringContaining("WindowsEvidenceCommitMismatch") });
  });

  it("rejects a hash-matched Windows file without embedded checklist evidence", async () => {
    const { root, manifestPath, manifest } = await writeFixture();
    const bogus = "not a signed checklist\n";
    await writeFile(join(root, "docs/testing/windows-m3-manual-checklist.signed.json"), bogus, "utf8");
    manifest.windowsEvidence.sha256 = sha256(bogus);
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    await expect(runVerifier(manifestPath, process.cwd())).rejects.toMatchObject({ stderr: expect.stringContaining("WindowsChecklistEvidenceUnavailable") });
  });

  it("rejects unsigned or hash-mismatched Windows evidence", async () => {
    const { manifestPath, manifest } = await writeFixture();
    manifest.windowsEvidence.signatures = [];
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    await expect(runVerifier(manifestPath, process.cwd())).rejects.toMatchObject({ stderr: expect.stringContaining("WindowsEvidenceUnsigned") });

    const mismatch = await writeFixture();
    mismatch.manifest.windowsEvidence.signatures[0]!.signatureSha256 = hashE;
    await writeFile(mismatch.manifestPath, JSON.stringify(mismatch.manifest, null, 2) + "\n", "utf8");
    await expect(runVerifier(mismatch.manifestPath, process.cwd())).rejects.toMatchObject({ stderr: expect.stringContaining("WindowsEvidenceSignatureMismatch") });

    manifest.windowsEvidence.signatures = [{ signer: "human-a", signedAt: "2026-08-29T00:00:00.000Z", signatureSha256: hashE }];
    manifest.windowsEvidence.sha256 = "f".repeat(64);
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    await expect(runVerifier(manifestPath, process.cwd())).rejects.toMatchObject({ stderr: expect.stringContaining("ReferencedHashMismatch") });
  });
});

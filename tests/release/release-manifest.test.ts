import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
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

async function writeFixture() {
  const root = join(process.cwd(), `.tmp-release-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fixtureRoots.push(root);
  await mkdir(join(root, "artifacts/release/v0.1.0"), { recursive: true });
  await mkdir(join(root, "docs/testing"), { recursive: true });
  const fixturePrefix = relative(process.cwd(), root).replaceAll("\\", "/");
  const sbomPath = `${fixturePrefix}/artifacts/release/v0.1.0/sbom.spdx.json`;
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
      productVersion: "v0.1.0",
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
  await mkdir(join(root, "gate-artifacts"), { recursive: true });
  await writeFile(join(process.cwd(), sbomPath), sbom, "utf8");
  await writeFile(join(process.cwd(), windowsPath), windows, "utf8");
  const gateArchives = new Map<string, { path: string; sha256: string; reportSha256: string; vitestSha256: string; receiptSha256: string }>();
  for (const name of ["gate-linux", "gate-windows-rust", "gate-self-hosted", "browser-e2e"]) {
    const archivePath = `${fixturePrefix}/gate-artifacts/${name}.zip`;
    const vitest = JSON.stringify({ numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0 }) + "\n";
    const report = JSON.stringify({ schemaVersion: "qualigence-gate-report/v1", gate: name, commit, command: ["pnpm", "vitest", "run"], selection: ["tests"], counts: { passed: 1, failed: 0, skipped: 0, todo: 0 }, status: "passed", environment: {}, files: [{ path: "vitest.json", sha256: sha256(vitest), bytes: Buffer.byteLength(vitest) }] }, null, 2) + "\n";
    const marker = JSON.stringify({ schemaVersion: "qualigence-gate-accepted/v1", gate: name, commit, report: "report.json", reportSha256: sha256(report), status: "accepted" }, null, 2) + "\n";
    const hashManifest = `${sha256(report)}  ${name}/report.json\n${sha256(marker)}  ${name}/accepted.json\n${sha256(vitest)}  ${name}/vitest.json\n`;
    const receipt = JSON.stringify({ schemaVersion: "qualigence-gate-artifact-receipt/v1", gate: name, commit, report: `${name}/report.json`, reportSha256: sha256(report), marker: `${name}/accepted.json`, markerSha256: sha256(marker), hashManifest: "sha256.txt", hashManifestSha256: sha256(hashManifest) }, null, 2) + "\n";
    const archiveBytes = zipStore({
      "receipt.json": receipt,
      [`${name}/report.json`]: report,
      [`${name}/accepted.json`]: marker,
      [`${name}/vitest.json`]: vitest,
      "sha256.txt": hashManifest,
    });
    await writeFile(join(process.cwd(), archivePath), archiveBytes);
    gateArchives.set(name, { path: archivePath, sha256: sha256(archiveBytes), reportSha256: sha256(report), vitestSha256: sha256(vitest), receiptSha256: sha256(receipt) });
  }
  const gateDeliveries = ["gate-linux", "gate-windows-rust", "gate-self-hosted", "browser-e2e"].map((name, index) => ({
    gate: name,
    artifactName: `${name}.zip`,
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
    version: "v0.1.0",
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
      artifactName: delivery.artifactName,
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
  const manifestPath = join(root, "artifacts/release/v0.1.0/release-manifest.json");
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
  it("accepts one immutable manifest that binds images, SBOM, Gates, and signed Windows evidence", async () => {
    const { root, manifestPath } = await writeFixture();
    const rendered = join(root, "artifacts/release/v0.1.0/compose.release.rendered.yaml");
    const { stdout } = await runVerifier(manifestPath, process.cwd(), ["--repository", "ljie-PI/Qualigence", "--commit", commit, "--render-compose", rendered]);
    expect(JSON.parse(stdout)).toMatchObject({ status: "verified", repository: "ljie-PI/Qualigence", commit });
    const compose = await readFile(rendered, "utf8");
    expect(compose).toContain(`ghcr.io/ljie-pi/qualigence/self-hosted@${digestA}`);
    expect(compose).toContain(`ghcr.io/ljie-pi/qualigence/self-hosted-console@${digestB}`);
    expect(compose).not.toContain(":v0.1.0");
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

  it("rejects Gate evidence whose artifact bytes cannot be recomputed", async () => {
    const { manifestPath, manifest } = await writeFixture();
    delete (manifest.gates[0]! as Record<string, unknown>).artifactPath;
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    await expect(runVerifier(manifestPath, process.cwd())).rejects.toMatchObject({ stderr: expect.stringContaining("GateArtifactBytesUnavailable") });
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

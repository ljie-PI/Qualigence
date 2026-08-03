import { beforeAll, describe, expect, it } from "vitest";
import {
  InMemoryRunnerEnrollmentStore,
  InMemoryRunnerPrincipalStore,
  RunnerEnrollmentService,
  RunnerIdentityError,
  runnerUriSan,
  type IssuedRunnerCertificate,
} from "@qualigence/runner-identity";
import {
  PemCaRunnerCertificateIssuer,
  SelfHostedRunnerAuthenticator,
  runnerScopeFromSan,
  toX509Certificate,
} from "@qualigence/runner-mtls";
import type { RunnerHello } from "@qualigence/runner-protocol";
import {
  corruptCsrSignature,
  createRunnerCa,
  generateRunnerCsr,
  mintClientCertificate,
  type PemPair,
} from "../../helpers/runner-identity-pki.js";

function helloFor(runnerId: string): RunnerHello {
  return {
    runnerId,
    runnerVersion: "1.0.0",
    supportedProtocolMajors: [1],
    capabilities: {
      operatingSystem: "linux",
      architecture: "x64",
      targetAdapters: [],
      observationExtensions: [],
      actionKinds: [],
      model: { structuredOutput: true, visionInput: false },
      maximumArtifactBytes: 1024,
    },
  };
}

let ca: PemPair;
let rogueCa: PemPair;

beforeAll(() => {
  ca = createRunnerCa();
  rogueCa = createRunnerCa("Rogue CA");
});

interface Harness {
  readonly service: RunnerEnrollmentService;
  readonly principals: InMemoryRunnerPrincipalStore;
  readonly authenticator: SelfHostedRunnerAuthenticator;
}

function makeHarness(): Harness {
  const enrollments = new InMemoryRunnerEnrollmentStore();
  const principals = new InMemoryRunnerPrincipalStore();
  // Use the real wall clock so openssl-issued notBefore/notAfter windows (which
  // are stamped from the system clock at issuance) align with authentication.
  const clock = { now: () => new Date().toISOString() };
  const service = new RunnerEnrollmentService({
    enrollments,
    principals,
    issuer: new PemCaRunnerCertificateIssuer({ caCertificatePem: ca.certPem, caPrivateKeyPem: ca.keyPem }),
    clock,
  });
  const authenticator = new SelfHostedRunnerAuthenticator({
    caCertificatePem: ca.certPem,
    principals,
    clock,
  });
  return { service, principals, authenticator };
}

async function enrollAndIssue(
  harness: Harness,
  options: { tenantId: string; runnerId: string; projectIds: readonly string[]; bogusUriSan?: string },
): Promise<{ readonly issued: IssuedRunnerCertificate; readonly csrPem: string }> {
  const created = await harness.service.createEnrollment({
    tenantId: options.tenantId,
    runnerId: options.runnerId,
    projectIds: options.projectIds,
    ttlMs: 300_000,
  });
  const csr = generateRunnerCsr(
    options.bogusUriSan === undefined
      ? { commonName: options.runnerId }
      : { commonName: options.runnerId, bogusUriSan: options.bogusUriSan },
  );
  const issued = await harness.service.issueCertificate(
    created.enrollment.enrollmentId,
    created.enrollmentToken,
    csr.csrPem,
  );
  return { issued, csrPem: csr.csrPem };
}

describe("self-hosted runner mTLS enrollment and authentication", () => {
  it("issues a scoped certificate and authenticates the enrolled runner", async () => {
    const harness = makeHarness();
    const { issued } = await enrollAndIssue(harness, {
      tenantId: "tenant-a",
      runnerId: "runner-1",
      projectIds: ["project-1"],
    });

    const certificate = toX509Certificate(issued.certificatePem);
    expect(runnerScopeFromSan(certificate)).toEqual({ tenantId: "tenant-a", runnerId: "runner-1" });

    const principal = await harness.authenticator.authenticate(issued.certificatePem, helloFor("runner-1"));
    expect(principal).toMatchObject({
      runnerId: "runner-1",
      tenantId: "tenant-a",
      projectIds: ["project-1"],
      certificateUriSan: runnerUriSan("tenant-a", "runner-1"),
      status: "active",
    });
  });

  it("derives the SAN from the enrollment and ignores a CSR-supplied SAN", async () => {
    const harness = makeHarness();
    const { issued } = await enrollAndIssue(harness, {
      tenantId: "tenant-a",
      runnerId: "runner-1",
      projectIds: ["project-1"],
      bogusUriSan: "spiffe://qualigence.local/tenants/tenant-evil/runners/runner-evil",
    });
    const certificate = toX509Certificate(issued.certificatePem);
    expect(runnerScopeFromSan(certificate)).toEqual({ tenantId: "tenant-a", runnerId: "runner-1" });
  });

  it("rejects a replayed enrollment token (single-use)", async () => {
    const harness = makeHarness();
    const created = await harness.service.createEnrollment({
      tenantId: "tenant-a",
      runnerId: "runner-1",
      projectIds: ["project-1"],
      ttlMs: 300_000,
    });
    const csr = generateRunnerCsr({ commonName: "runner-1" });
    await harness.service.issueCertificate(created.enrollment.enrollmentId, created.enrollmentToken, csr.csrPem);

    await expect(
      harness.service.issueCertificate(created.enrollment.enrollmentId, created.enrollmentToken, csr.csrPem),
    ).rejects.toMatchObject({ code: "RunnerEnrollmentAlreadyConsumed" });
  });

  it("rejects a certificate presented under a different claimed runnerId", async () => {
    const harness = makeHarness();
    const { issued } = await enrollAndIssue(harness, {
      tenantId: "tenant-a",
      runnerId: "runner-1",
      projectIds: ["project-1"],
    });

    await expect(
      harness.authenticator.authenticate(issued.certificatePem, helloFor("runner-2")),
    ).rejects.toMatchObject({ code: "RunnerIdentityMismatch" });
  });

  it("rejects a runner enrolled for tenant A when authorized against tenant B", async () => {
    const harness = makeHarness();
    const { issued } = await enrollAndIssue(harness, {
      tenantId: "tenant-a",
      runnerId: "runner-1",
      projectIds: ["project-1"],
    });
    const principal = await harness.authenticator.authenticate(issued.certificatePem, helloFor("runner-1"));

    expect(() => harness.authenticator.authorize(principal, { tenantId: "tenant-a", projectId: "project-1" })).not.toThrow();
    try {
      harness.authenticator.authorize(principal, { tenantId: "tenant-b", projectId: "project-1" });
      throw new Error("expected tenant-b authorization to be rejected");
    } catch (error) {
      expect((error as RunnerIdentityError).code).toBe("RunnerScopeViolation");
    }
  });

  it("rejects an out-of-scope project for an authenticated runner", async () => {
    const harness = makeHarness();
    const { issued } = await enrollAndIssue(harness, {
      tenantId: "tenant-a",
      runnerId: "runner-1",
      projectIds: ["project-1"],
    });
    const principal = await harness.authenticator.authenticate(issued.certificatePem, helloFor("runner-1"));
    expect(() =>
      harness.authenticator.authorize(principal, { tenantId: "tenant-a", projectId: "project-2" }),
    ).toThrow(RunnerIdentityError);
  });

  it("rotates a certificate without downtime: old and new both authenticate", async () => {
    const harness = makeHarness();
    const { issued: original } = await enrollAndIssue(harness, {
      tenantId: "tenant-a",
      runnerId: "runner-1",
      projectIds: ["project-1"],
    });

    const rotationCsr = generateRunnerCsr({ commonName: "runner-1" });
    const rotated = await harness.service.rotateCertificate("tenant-a", "runner-1", rotationCsr.csrPem);

    expect(rotated.certificateFingerprintSha256).not.toBe(original.certificateFingerprintSha256);
    const viaOld = await harness.authenticator.authenticate(original.certificatePem, helloFor("runner-1"));
    const viaNew = await harness.authenticator.authenticate(rotated.certificatePem, helloFor("runner-1"));
    expect(viaOld.status).toBe("active");
    expect(viaNew.status).toBe("active");
  });

  it("rejects a revoked certificate immediately on the next connection attempt", async () => {
    const harness = makeHarness();
    const { issued } = await enrollAndIssue(harness, {
      tenantId: "tenant-a",
      runnerId: "runner-1",
      projectIds: ["project-1"],
    });
    // Valid before revocation.
    await harness.authenticator.authenticate(issued.certificatePem, helloFor("runner-1"));

    await harness.service.revokeRunner("tenant-a", "runner-1");

    await expect(
      harness.authenticator.authenticate(issued.certificatePem, helloFor("runner-1")),
    ).rejects.toMatchObject({ code: "RunnerCertificateRevoked" });
  });

  it("rejects a certificate signed by an untrusted CA", async () => {
    const harness = makeHarness();
    const rogue = mintClientCertificate({
      ca: rogueCa,
      commonName: "runner-1",
      uriSan: runnerUriSan("tenant-a", "runner-1"),
    });
    await expect(
      harness.authenticator.authenticate(rogue.certPem, helloFor("runner-1")),
    ).rejects.toMatchObject({ code: "RunnerCertificateUntrusted" });
  });

  it("rejects an expired certificate", async () => {
    const harness = makeHarness();
    const expired = mintClientCertificate({
      ca,
      commonName: "runner-1",
      uriSan: runnerUriSan("tenant-a", "runner-1"),
      validity: ["-not_before", "20200101000000Z", "-not_after", "20200102000000Z"],
    });
    await expect(
      harness.authenticator.authenticate(expired.certPem, helloFor("runner-1")),
    ).rejects.toMatchObject({ code: "RunnerCertificateExpired" });
  });

  it("rejects a certificate whose fingerprint is not bound to any principal", async () => {
    const harness = makeHarness();
    const orphan = mintClientCertificate({
      ca,
      commonName: "runner-1",
      uriSan: runnerUriSan("tenant-a", "runner-1"),
    });
    await expect(
      harness.authenticator.authenticate(orphan.certPem, helloFor("runner-1")),
    ).rejects.toMatchObject({ code: "RunnerPrincipalNotFound" });
  });

  it("rejects a CSR with an invalid signature", async () => {
    const harness = makeHarness();
    const created = await harness.service.createEnrollment({
      tenantId: "tenant-a",
      runnerId: "runner-1",
      projectIds: ["project-1"],
      ttlMs: 300_000,
    });
    const bad = corruptCsrSignature();
    await expect(
      harness.service.issueCertificate(created.enrollment.enrollmentId, created.enrollmentToken, bad.csrPem),
    ).rejects.toMatchObject({ code: "RunnerCsrInvalid" });
  });

  it("rejects an RSA key below 3072 bits", async () => {
    const harness = makeHarness();
    const created = await harness.service.createEnrollment({
      tenantId: "tenant-a",
      runnerId: "runner-1",
      projectIds: ["project-1"],
      ttlMs: 300_000,
    });
    const weak = generateRunnerCsr({ commonName: "runner-1", keyKind: "rsa-2048" });
    await expect(
      harness.service.issueCertificate(created.enrollment.enrollmentId, created.enrollmentToken, weak.csrPem),
    ).rejects.toMatchObject({ code: "RunnerKeyTooWeak" });
  });

  it("accepts an RSA-3072 key", async () => {
    const harness = makeHarness();
    const created = await harness.service.createEnrollment({
      tenantId: "tenant-a",
      runnerId: "runner-1",
      projectIds: ["project-1"],
      ttlMs: 300_000,
    });
    const strong = generateRunnerCsr({ commonName: "runner-1", keyKind: "rsa-3072" });
    const issued = await harness.service.issueCertificate(
      created.enrollment.enrollmentId,
      created.enrollmentToken,
      strong.csrPem,
    );
    const principal = await harness.authenticator.authenticate(issued.certificatePem, helloFor("runner-1"));
    expect(principal.runnerId).toBe("runner-1");
  });
});

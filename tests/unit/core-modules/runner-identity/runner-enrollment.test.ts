import { describe, expect, it } from "vitest";
import {
  InMemoryRunnerEnrollmentStore,
  InMemoryRunnerPrincipalStore,
  RunnerEnrollmentService,
  RunnerIdentityError,
  authorizeRunnerScope,
  hashEnrollmentToken,
  runnerUriSan,
  type IssueRunnerCertificateInput,
  type IssuedRunnerCertificate,
  type RunnerCertificateIssuer,
} from "@qualigence/runner-identity";

/**
 * A deterministic fake issuer that records the exact input it was asked to sign,
 * so domain/application tests can assert scoping and single-use semantics without
 * spawning real crypto. The contract test exercises the real PEM-CA issuer.
 */
class FakeRunnerCertificateIssuer implements RunnerCertificateIssuer {
  readonly calls: IssueRunnerCertificateInput[] = [];
  failNext = false;
  private counter = 0;

  constructor(private readonly notAfter = "2027-01-01T00:00:00.000Z") {}

  async issue(input: IssueRunnerCertificateInput): Promise<IssuedRunnerCertificate> {
    this.calls.push(input);
    if (this.failNext) {
      this.failNext = false;
      throw new RunnerIdentityError("RunnerCsrInvalid", "csr signature is invalid");
    }
    this.counter += 1;
    return {
      runnerId: input.runnerId,
      certificatePem: `-----BEGIN CERTIFICATE-----\nfake-${this.counter}\n-----END CERTIFICATE-----\n`,
      caCertificatePem: "-----BEGIN CERTIFICATE-----\nfake-ca\n-----END CERTIFICATE-----\n",
      certificateFingerprintSha256: `fingerprint-${this.counter}`,
      certificateNotAfter: this.notAfter,
    };
  }
}

function fixedClock(now: string): { now(): string } {
  return { now: () => now };
}

function makeService(options?: {
  readonly now?: string;
  readonly issuer?: FakeRunnerCertificateIssuer;
}): {
  readonly service: RunnerEnrollmentService;
  readonly enrollments: InMemoryRunnerEnrollmentStore;
  readonly principals: InMemoryRunnerPrincipalStore;
  readonly issuer: FakeRunnerCertificateIssuer;
} {
  const enrollments = new InMemoryRunnerEnrollmentStore();
  const principals = new InMemoryRunnerPrincipalStore();
  const issuer = options?.issuer ?? new FakeRunnerCertificateIssuer();
  const service = new RunnerEnrollmentService({
    enrollments,
    principals,
    issuer,
    clock: fixedClock(options?.now ?? "2026-08-01T00:00:00.000Z"),
  });
  return { service, enrollments, principals, issuer };
}

describe("RunnerEnrollmentService enrollment token lifecycle", () => {
  it("returns the raw token only once and persists only its hash", async () => {
    const { service, enrollments } = makeService();

    const created = await service.createEnrollment({
      tenantId: "tenant-a",
      runnerId: "runner-1",
      projectIds: ["project-1"],
      ttlMs: 60_000,
    });

    expect(created.enrollmentToken).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    const stored = await enrollments.findById(created.enrollment.enrollmentId);
    expect(stored).toBeDefined();
    expect(stored?.tokenHash).toBe(hashEnrollmentToken(created.enrollmentToken));
    // The persisted enrollment must not carry the raw token anywhere.
    expect(JSON.stringify(stored)).not.toContain(created.enrollmentToken);
    expect(stored).not.toHaveProperty("enrollmentToken");
    expect(stored).not.toHaveProperty("token");
  });

  it("binds a principal to the enrollment's tenant/project scope on first exchange", async () => {
    const { service, principals, issuer } = makeService();
    const created = await service.createEnrollment({
      tenantId: "tenant-a",
      runnerId: "runner-1",
      projectIds: ["project-1", "project-2"],
      ttlMs: 60_000,
    });

    const issued = await service.issueCertificate(
      created.enrollment.enrollmentId,
      created.enrollmentToken,
      "csr-pem",
    );

    expect(issuer.calls).toHaveLength(1);
    expect(issuer.calls[0]?.uriSan).toBe(runnerUriSan("tenant-a", "runner-1"));
    const principal = await principals.findByFingerprint(issued.certificateFingerprintSha256);
    expect(principal).toMatchObject({
      runnerId: "runner-1",
      tenantId: "tenant-a",
      projectIds: ["project-1", "project-2"],
      status: "active",
      certificateUriSan: runnerUriSan("tenant-a", "runner-1"),
    });
  });

  it("rejects a replayed enrollment token (single-use)", async () => {
    const { service } = makeService();
    const created = await service.createEnrollment({
      tenantId: "tenant-a",
      runnerId: "runner-1",
      projectIds: ["project-1"],
      ttlMs: 60_000,
    });

    await service.issueCertificate(created.enrollment.enrollmentId, created.enrollmentToken, "csr-pem");

    await expect(
      service.issueCertificate(created.enrollment.enrollmentId, created.enrollmentToken, "csr-pem"),
    ).rejects.toMatchObject({ code: "RunnerEnrollmentAlreadyConsumed" });
  });

  it("keeps the token spendable when the CSR is rejected, then consumes on success", async () => {
    const issuer = new FakeRunnerCertificateIssuer();
    const { service } = makeService({ issuer });
    const created = await service.createEnrollment({
      tenantId: "tenant-a",
      runnerId: "runner-1",
      projectIds: ["project-1"],
      ttlMs: 60_000,
    });

    issuer.failNext = true;
    await expect(
      service.issueCertificate(created.enrollment.enrollmentId, created.enrollmentToken, "bad-csr"),
    ).rejects.toMatchObject({ code: "RunnerCsrInvalid" });

    // A retry with a valid CSR still succeeds because a rejected CSR does not burn the token.
    const issued = await service.issueCertificate(
      created.enrollment.enrollmentId,
      created.enrollmentToken,
      "good-csr",
    );
    expect(issued.runnerId).toBe("runner-1");
  });

  it("rejects an expired enrollment token", async () => {
    const enrollments = new InMemoryRunnerEnrollmentStore();
    const principals = new InMemoryRunnerPrincipalStore();
    const issuer = new FakeRunnerCertificateIssuer();
    const service = new RunnerEnrollmentService({
      enrollments,
      principals,
      issuer,
      clock: fixedClock("2026-08-01T00:00:00.000Z"),
    });
    const created = await service.createEnrollment({
      tenantId: "tenant-a",
      runnerId: "runner-1",
      projectIds: ["project-1"],
      ttlMs: 1_000,
    });

    const expiredService = new RunnerEnrollmentService({
      enrollments,
      principals,
      issuer,
      clock: fixedClock("2026-08-01T00:01:00.000Z"),
    });
    await expect(
      expiredService.issueCertificate(created.enrollment.enrollmentId, created.enrollmentToken, "csr-pem"),
    ).rejects.toMatchObject({ code: "RunnerEnrollmentExpired" });
  });

  it("rejects an incorrect enrollment token", async () => {
    const { service } = makeService();
    const created = await service.createEnrollment({
      tenantId: "tenant-a",
      runnerId: "runner-1",
      projectIds: ["project-1"],
      ttlMs: 60_000,
    });

    await expect(
      service.issueCertificate(created.enrollment.enrollmentId, "not-the-token", "csr-pem"),
    ).rejects.toMatchObject({ code: "RunnerEnrollmentTokenInvalid" });
  });

  it("rejects exchange against an unknown enrollment", async () => {
    const { service } = makeService();
    await expect(service.issueCertificate("missing", "token", "csr")).rejects.toMatchObject({
      code: "RunnerEnrollmentNotFound",
    });
  });
});

describe("RunnerPrincipal scope authorization", () => {
  it("rejects a Runner enrolled for tenant A acting as tenant B", async () => {
    const { service } = makeService();
    const created = await service.createEnrollment({
      tenantId: "tenant-a",
      runnerId: "runner-1",
      projectIds: ["project-1"],
      ttlMs: 60_000,
    });
    const issued = await service.issueCertificate(
      created.enrollment.enrollmentId,
      created.enrollmentToken,
      "csr-pem",
    );
    const principal = {
      runnerId: "runner-1",
      tenantId: "tenant-a",
      projectIds: ["project-1"],
      certificateFingerprintSha256: issued.certificateFingerprintSha256,
      certificateUriSan: runnerUriSan("tenant-a", "runner-1"),
      enrollmentId: created.enrollment.enrollmentId,
      status: "active" as const,
      certificateNotAfter: issued.certificateNotAfter,
    };

    expect(() => authorizeRunnerScope(principal, { tenantId: "tenant-a", projectId: "project-1" })).not.toThrow();
    expect(() => authorizeRunnerScope(principal, { tenantId: "tenant-b", projectId: "project-1" })).toThrow(
      RunnerIdentityError,
    );
    try {
      authorizeRunnerScope(principal, { tenantId: "tenant-b", projectId: "project-1" });
    } catch (error) {
      expect((error as RunnerIdentityError).code).toBe("RunnerScopeViolation");
    }
  });

  it("rejects an out-of-scope project", () => {
    const principal = {
      runnerId: "runner-1",
      tenantId: "tenant-a",
      projectIds: ["project-1"],
      certificateFingerprintSha256: "fp",
      certificateUriSan: runnerUriSan("tenant-a", "runner-1"),
      enrollmentId: "enrollment-1",
      status: "active" as const,
      certificateNotAfter: "2027-01-01T00:00:00.000Z",
    };
    expect(() => authorizeRunnerScope(principal, { tenantId: "tenant-a", projectId: "project-9" })).toThrow(
      /project-9/,
    );
  });

  it("rejects a revoked or suspended principal regardless of scope", () => {
    const base = {
      runnerId: "runner-1",
      tenantId: "tenant-a",
      projectIds: ["project-1"],
      certificateFingerprintSha256: "fp",
      certificateUriSan: runnerUriSan("tenant-a", "runner-1"),
      enrollmentId: "enrollment-1",
      certificateNotAfter: "2027-01-01T00:00:00.000Z",
    };
    try {
      authorizeRunnerScope({ ...base, status: "revoked" }, { tenantId: "tenant-a", projectId: "project-1" });
      throw new Error("expected revoked principal to be rejected");
    } catch (error) {
      expect((error as RunnerIdentityError).code).toBe("RunnerCertificateRevoked");
    }
    try {
      authorizeRunnerScope({ ...base, status: "suspended" }, { tenantId: "tenant-a", projectId: "project-1" });
      throw new Error("expected suspended principal to be rejected");
    } catch (error) {
      expect((error as RunnerIdentityError).code).toBe("RunnerSuspended");
    }
  });
});

describe("certificate rotation and revocation", () => {
  it("keeps the old certificate active while issuing a new one (no forced downtime)", async () => {
    const { service, principals } = makeService();
    const created = await service.createEnrollment({
      tenantId: "tenant-a",
      runnerId: "runner-1",
      projectIds: ["project-1"],
      ttlMs: 60_000,
    });
    const original = await service.issueCertificate(
      created.enrollment.enrollmentId,
      created.enrollmentToken,
      "csr-pem",
    );

    const rotated = await service.rotateCertificate("tenant-a", "runner-1", "csr-pem-2");

    expect(rotated.certificateFingerprintSha256).not.toBe(original.certificateFingerprintSha256);
    const oldBinding = await principals.findByFingerprint(original.certificateFingerprintSha256);
    const newBinding = await principals.findByFingerprint(rotated.certificateFingerprintSha256);
    expect(oldBinding?.status).toBe("active");
    expect(newBinding?.status).toBe("active");
  });

  it("refuses rotation for a Runner with no active binding", async () => {
    const { service } = makeService();
    await expect(service.rotateCertificate("tenant-a", "runner-x", "csr")).rejects.toMatchObject({
      code: "RunnerPrincipalNotFound",
    });
  });

  it("revokes every binding for a Runner", async () => {
    const { service, principals } = makeService();
    const created = await service.createEnrollment({
      tenantId: "tenant-a",
      runnerId: "runner-1",
      projectIds: ["project-1"],
      ttlMs: 60_000,
    });
    const issued = await service.issueCertificate(
      created.enrollment.enrollmentId,
      created.enrollmentToken,
      "csr-pem",
    );
    await service.rotateCertificate("tenant-a", "runner-1", "csr-pem-2");

    const revoked = await service.revokeRunner("tenant-a", "runner-1");

    expect(revoked.length).toBe(2);
    const binding = await principals.findByFingerprint(issued.certificateFingerprintSha256);
    expect(binding?.status).toBe("revoked");
  });
});

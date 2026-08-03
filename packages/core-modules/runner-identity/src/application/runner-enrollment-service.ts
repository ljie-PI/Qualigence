import { randomUUID } from "node:crypto";
import type { Clock } from "@qualigence/shared-kernel";
import { RunnerIdentityError } from "../domain/errors.js";
import {
  generateEnrollmentToken,
  hashEnrollmentToken,
  tokenMatchesHash,
  type IssuedRunnerCertificate,
  type RunnerEnrollment,
} from "../domain/runner-enrollment.js";
import { runnerUriSan, type RunnerPrincipal } from "../domain/runner-principal.js";
import type {
  RunnerCertificateIssuer,
  RunnerEnrollmentStore,
  RunnerPrincipalStore,
} from "../ports/runner-certificate-issuer.js";

/** Admin command: register a Runner and mint a single-use enrollment token. */
export interface CreateRunnerEnrollmentInput {
  readonly tenantId: string;
  readonly runnerId: string;
  readonly projectIds: readonly string[];
  /** Token time-to-live in milliseconds; enrollment cannot be exchanged after this. */
  readonly ttlMs: number;
}

/**
 * Result of creating an enrollment. The raw {@link enrollmentToken} appears here
 * exactly once and is never persisted, logged in the clear, or returned by any
 * query — only its hash is stored on the {@link RunnerEnrollment}.
 */
export interface CreateRunnerEnrollmentResult {
  readonly enrollment: RunnerEnrollment;
  readonly enrollmentToken: string;
}

export interface RunnerEnrollmentServiceDependencies {
  readonly enrollments: RunnerEnrollmentStore;
  readonly principals: RunnerPrincipalStore;
  readonly issuer: RunnerCertificateIssuer;
  readonly clock: Clock;
  readonly generateId?: () => string;
  readonly generateToken?: () => string;
}

/**
 * Application service orchestrating the Runner enrollment/identity lifecycle:
 * single-use enrollment token issuance, atomic exchange for a scoped client
 * certificate, rotation without re-enrollment, and revocation.
 */
export class RunnerEnrollmentService {
  private readonly enrollments: RunnerEnrollmentStore;
  private readonly principals: RunnerPrincipalStore;
  private readonly issuer: RunnerCertificateIssuer;
  private readonly clock: Clock;
  private readonly generateId: () => string;
  private readonly generateToken: () => string;

  constructor(dependencies: RunnerEnrollmentServiceDependencies) {
    this.enrollments = dependencies.enrollments;
    this.principals = dependencies.principals;
    this.issuer = dependencies.issuer;
    this.clock = dependencies.clock;
    this.generateId = dependencies.generateId ?? ((): string => randomUUID());
    this.generateToken = dependencies.generateToken ?? generateEnrollmentToken;
  }

  async createEnrollment(input: CreateRunnerEnrollmentInput): Promise<CreateRunnerEnrollmentResult> {
    const token = this.generateToken();
    const nowMs = Date.parse(this.clock.now());
    const enrollment: RunnerEnrollment = {
      enrollmentId: this.generateId(),
      tenantId: input.tenantId,
      runnerId: input.runnerId,
      projectIds: [...input.projectIds],
      tokenHash: hashEnrollmentToken(token),
      expiresAt: new Date(nowMs + input.ttlMs).toISOString(),
    };
    await this.enrollments.create(enrollment);
    return { enrollment, enrollmentToken: token };
  }

  /**
   * Exchange a one-time enrollment token and CSR for a scoped client certificate.
   * The token is validated, the CSR is signed into a certificate whose SAN/scope
   * come only from the persisted enrollment, and the enrollment is atomically
   * consumed. A replayed token exchange is rejected with `RunnerEnrollmentAlreadyConsumed`.
   */
  async issueCertificate(
    enrollmentId: string,
    token: string,
    csrPem: string,
  ): Promise<IssuedRunnerCertificate> {
    const enrollment = await this.enrollments.findById(enrollmentId);
    if (enrollment === undefined) {
      throw new RunnerIdentityError("RunnerEnrollmentNotFound", `enrollment ${enrollmentId} not found`);
    }
    if (enrollment.consumedAt !== undefined) {
      throw new RunnerIdentityError(
        "RunnerEnrollmentAlreadyConsumed",
        `enrollment ${enrollmentId} was already consumed`,
      );
    }
    const now = this.clock.now();
    if (Date.parse(now) > Date.parse(enrollment.expiresAt)) {
      throw new RunnerIdentityError("RunnerEnrollmentExpired", `enrollment ${enrollmentId} has expired`);
    }
    if (!tokenMatchesHash(token, enrollment.tokenHash)) {
      throw new RunnerIdentityError("RunnerEnrollmentTokenInvalid", "enrollment token does not match");
    }

    const uriSan = runnerUriSan(enrollment.tenantId, enrollment.runnerId);
    const issued = await this.issuer.issue({
      runnerId: enrollment.runnerId,
      tenantId: enrollment.tenantId,
      csrPem,
      uriSan,
    });

    // Atomically consume only after the CSR is accepted, so an invalid CSR leaves
    // the single-use token spendable while a replay of a *successful* exchange is
    // rejected.
    const consumed = await this.enrollments.consume(enrollmentId, now);
    if (!consumed) {
      throw new RunnerIdentityError(
        "RunnerEnrollmentAlreadyConsumed",
        `enrollment ${enrollmentId} was already consumed`,
      );
    }

    await this.principals.put(this.bindPrincipal(enrollment, uriSan, issued));
    return issued;
  }

  /**
   * Issue a fresh certificate for an already-enrolled Runner without re-enrollment.
   * The previous binding stays `active` until its own certificate expires, so the
   * Runner can keep serving on the old certificate until it swaps to the new one —
   * no forced downtime.
   */
  async rotateCertificate(
    tenantId: string,
    runnerId: string,
    csrPem: string,
  ): Promise<IssuedRunnerCertificate> {
    const bindings = await this.principals.listByRunner(tenantId, runnerId);
    const active = bindings.find((binding) => binding.status === "active");
    if (active === undefined) {
      throw new RunnerIdentityError(
        "RunnerPrincipalNotFound",
        `no active certificate binding for runner ${runnerId} in tenant ${tenantId}`,
      );
    }
    const uriSan = active.certificateUriSan;
    const issued = await this.issuer.issue({ runnerId, tenantId, csrPem, uriSan });
    const rotated: RunnerPrincipal = {
      runnerId,
      tenantId,
      projectIds: [...active.projectIds],
      certificateFingerprintSha256: issued.certificateFingerprintSha256,
      certificateUriSan: uriSan,
      enrollmentId: active.enrollmentId,
      status: "active",
      certificateNotAfter: issued.certificateNotAfter,
    };
    await this.principals.put(rotated);
    return issued;
  }

  /**
   * Revoke every certificate binding for a Runner. Subsequent connection attempts
   * with any of the Runner's certificates fail closed immediately, with no grace
   * period.
   */
  async revokeRunner(tenantId: string, runnerId: string): Promise<readonly RunnerPrincipal[]> {
    return this.principals.setStatusForRunner(tenantId, runnerId, "revoked");
  }

  /** Suspend a Runner's certificates; can later be re-activated by re-issuance. */
  async suspendRunner(tenantId: string, runnerId: string): Promise<readonly RunnerPrincipal[]> {
    return this.principals.setStatusForRunner(tenantId, runnerId, "suspended");
  }

  private bindPrincipal(
    enrollment: RunnerEnrollment,
    uriSan: string,
    issued: IssuedRunnerCertificate,
  ): RunnerPrincipal {
    return {
      runnerId: enrollment.runnerId,
      tenantId: enrollment.tenantId,
      projectIds: [...enrollment.projectIds],
      certificateFingerprintSha256: issued.certificateFingerprintSha256,
      certificateUriSan: uriSan,
      enrollmentId: enrollment.enrollmentId,
      status: "active",
      certificateNotAfter: issued.certificateNotAfter,
    };
  }
}

/** Deterministic in-memory {@link RunnerEnrollmentStore} for composition/tests. */
export class InMemoryRunnerEnrollmentStore implements RunnerEnrollmentStore {
  private readonly byId = new Map<string, RunnerEnrollment>();

  async create(enrollment: RunnerEnrollment): Promise<void> {
    this.byId.set(enrollment.enrollmentId, enrollment);
  }

  async findById(enrollmentId: string): Promise<RunnerEnrollment | undefined> {
    return this.byId.get(enrollmentId);
  }

  async consume(enrollmentId: string, consumedAt: string): Promise<boolean> {
    const enrollment = this.byId.get(enrollmentId);
    if (enrollment === undefined || enrollment.consumedAt !== undefined) {
      return false;
    }
    this.byId.set(enrollmentId, { ...enrollment, consumedAt });
    return true;
  }

  async release(enrollmentId: string): Promise<void> {
    const enrollment = this.byId.get(enrollmentId);
    if (enrollment === undefined || enrollment.consumedAt === undefined) {
      return;
    }
    const { consumedAt: _consumedAt, ...rest } = enrollment;
    this.byId.set(enrollmentId, rest);
  }
}

/** Deterministic in-memory {@link RunnerPrincipalStore} for composition/tests. */
export class InMemoryRunnerPrincipalStore implements RunnerPrincipalStore {
  private readonly byFingerprint = new Map<string, RunnerPrincipal>();

  async put(principal: RunnerPrincipal): Promise<void> {
    this.byFingerprint.set(principal.certificateFingerprintSha256, principal);
  }

  async findByFingerprint(fingerprintSha256: string): Promise<RunnerPrincipal | undefined> {
    return this.byFingerprint.get(fingerprintSha256);
  }

  async listByRunner(tenantId: string, runnerId: string): Promise<readonly RunnerPrincipal[]> {
    return [...this.byFingerprint.values()].filter(
      (principal) => principal.tenantId === tenantId && principal.runnerId === runnerId,
    );
  }

  async setStatusForRunner(
    tenantId: string,
    runnerId: string,
    status: RunnerPrincipal["status"],
  ): Promise<readonly RunnerPrincipal[]> {
    const updated: RunnerPrincipal[] = [];
    for (const [fingerprint, principal] of this.byFingerprint) {
      if (principal.tenantId === tenantId && principal.runnerId === runnerId) {
        const next: RunnerPrincipal = { ...principal, status };
        this.byFingerprint.set(fingerprint, next);
        updated.push(next);
      }
    }
    return updated;
  }
}

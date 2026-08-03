import { X509Certificate } from "node:crypto";
import type { Clock } from "@qualigence/shared-kernel";
import type { RunnerHello } from "@qualigence/runner-protocol";
import {
  RunnerIdentityError,
  authorizeRunnerScope,
  type RunnerOperationScope,
  type RunnerPrincipal,
  type RunnerPrincipalStore,
} from "@qualigence/runner-identity";
import {
  certificateSha256Fingerprint,
  hasClientAuthEku,
  runnerScopeFromSan,
  toX509Certificate,
  type RunnerClientCertificateInput,
} from "./certificate.js";

export interface SelfHostedRunnerAuthenticatorOptions {
  /** Trusted issuing CA certificate the client certificate must chain to. */
  readonly caCertificatePem: string | Buffer;
  readonly principals: RunnerPrincipalStore;
  readonly clock: Clock;
}

/**
 * Resolves an incoming mTLS client certificate to a {@link RunnerPrincipal} for the
 * Self-hosted deployment and fails closed on any identity, validity, revocation or
 * scope violation before a Job payload is exchanged.
 *
 * This is the multi-tenant counterpart to LS-05's {@link CertificateRunnerIdentity}:
 * where the local adapter only checks a `runner://<id>` SAN against a claimed id,
 * this authenticator additionally enforces the certificate chain, validity window,
 * client-auth EKU, fingerprint→principal binding, revocation status and the
 * SPIFFE tenant/runner SAN, and exposes tenant/project authorization for the gRPC
 * adapter to apply before serializing an Offer.
 */
export class SelfHostedRunnerAuthenticator {
  private readonly caCertificate: X509Certificate;
  private readonly principals: RunnerPrincipalStore;
  private readonly clock: Clock;

  constructor(options: SelfHostedRunnerAuthenticatorOptions) {
    this.caCertificate = new X509Certificate(options.caCertificatePem);
    this.principals = options.principals;
    this.clock = options.clock;
  }

  async authenticate(peer: RunnerClientCertificateInput, hello: RunnerHello): Promise<RunnerPrincipal> {
    const certificate = this.parse(peer);
    this.assertTrusted(certificate);
    this.assertWithinValidity(certificate);
    this.assertClientAuth(certificate);

    const scope = runnerScopeFromSan(certificate);
    if (scope === undefined) {
      throw new RunnerIdentityError(
        "RunnerIdentityMismatch",
        "certificate has no recognizable runner URI SAN",
      );
    }

    const fingerprint = certificateSha256Fingerprint(certificate);
    const principal = await this.principals.findByFingerprint(fingerprint);
    if (principal === undefined) {
      throw new RunnerIdentityError(
        "RunnerPrincipalNotFound",
        `no runner principal is bound to certificate fingerprint ${fingerprint}`,
      );
    }

    if (principal.status === "revoked") {
      throw new RunnerIdentityError("RunnerCertificateRevoked", `runner ${principal.runnerId} is revoked`, {
        details: { runnerId: principal.runnerId },
      });
    }
    if (principal.status === "suspended") {
      throw new RunnerIdentityError("RunnerSuspended", `runner ${principal.runnerId} is suspended`, {
        details: { runnerId: principal.runnerId },
      });
    }

    if (scope.tenantId !== principal.tenantId || scope.runnerId !== principal.runnerId) {
      throw new RunnerIdentityError(
        "RunnerIdentityMismatch",
        "certificate SAN scope does not match the bound principal",
        { details: { san: scope, principalTenant: principal.tenantId, principalRunner: principal.runnerId } },
      );
    }

    if (hello.runnerId !== principal.runnerId) {
      throw new RunnerIdentityError(
        "RunnerIdentityMismatch",
        `certificate identity ${principal.runnerId} does not match claimed runner ${hello.runnerId}`,
        { details: { claimedRunnerId: hello.runnerId, certificateRunnerId: principal.runnerId } },
      );
    }

    return principal;
  }

  /**
   * Authorize an already-authenticated principal against the tenant/project scope of
   * the operation it is attempting. Applied by the gRPC adapter before serializing
   * an Offer so an out-of-scope or revoked Runner never receives a Job payload.
   */
  authorize(principal: RunnerPrincipal, scope: RunnerOperationScope): void {
    authorizeRunnerScope(principal, scope);
  }

  private parse(peer: RunnerClientCertificateInput): X509Certificate {
    try {
      return toX509Certificate(peer);
    } catch (error) {
      throw new RunnerIdentityError("RunnerCertificateUntrusted", "unable to parse client certificate", {
        cause: error,
      });
    }
  }

  private assertTrusted(certificate: X509Certificate): void {
    if (!certificate.checkIssued(this.caCertificate) || !certificate.verify(this.caCertificate.publicKey)) {
      throw new RunnerIdentityError(
        "RunnerCertificateUntrusted",
        "client certificate does not chain to the trusted runner CA",
      );
    }
  }

  private assertWithinValidity(certificate: X509Certificate): void {
    const now = Date.parse(this.clock.now());
    if (now < Date.parse(certificate.validFrom) || now > Date.parse(certificate.validTo)) {
      throw new RunnerIdentityError("RunnerCertificateExpired", "client certificate is outside its validity window", {
        details: { validFrom: certificate.validFrom, validTo: certificate.validTo },
      });
    }
  }

  private assertClientAuth(certificate: X509Certificate): void {
    if (!hasClientAuthEku(certificate)) {
      throw new RunnerIdentityError(
        "RunnerCertificateUntrusted",
        "client certificate is missing the clientAuth extended key usage",
      );
    }
  }
}

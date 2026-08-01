import type { FastifyInstance } from "fastify";
import type {
  CreateRunnerEnrollmentBody,
  IssueRunnerCertificateBody,
  RunnerCertificateDto,
  RunnerEnrollmentDto,
  RunnerIdentityDto,
} from "@qualigence/public-api";
import { CLIENT_CERTIFICATE_HEADER } from "@qualigence/public-api";
import {
  generateEnrollmentToken,
  RunnerEnrollmentService,
  RunnerIdentityError,
} from "@qualigence/runner-identity";
import {
  SelfHostedRunnerAuthenticator,
  runnerScopeFromSan,
  toX509Certificate,
} from "@qualigence/runner-mtls";
import type { RunnerHello } from "@qualigence/runner-protocol";
import {
  authenticateOidc,
  requireIdempotencyKey,
  requireRole,
  withTenant,
  type ServerDeps,
} from "../server-context.js";
import { commandEnvelope } from "../envelopes.js";
import {
  enrollmentTokenInvalid,
  newCorrelationId,
  runnerUnauthenticated,
  validationFailed,
} from "../errors.js";

export function registerRunnerEnrollmentRoutes(app: FastifyInstance, deps: ServerDeps): void {
  // Human-facing, OIDC + admin: register a Runner and mint a one-time token.
  app.post<{ Body: Partial<CreateRunnerEnrollmentBody> }>(
    "/v1/runner-enrollments",
    async (request, reply) => {
      const principal = await authenticateOidc(deps, request);
      requireRole(deps, principal, "admin");
      requireIdempotencyKey(request);
      const body = request.body ?? {};
      if (typeof body.runnerId !== "string" || body.runnerId.length === 0) {
        throw validationFailed("runnerId is required");
      }
      if (!Array.isArray(body.projectIds) || body.projectIds.length === 0) {
        throw validationFailed("projectIds is required");
      }
      if (typeof body.ttlMs !== "number" || body.ttlMs <= 0) {
        throw validationFailed("ttlMs must be a positive number");
      }

      const dto = await withTenant(deps, principal.tenantId, async (stores) => {
        const service = new RunnerEnrollmentService({
          enrollments: deps.enrollmentStore(stores),
          principals: deps.principalStore(stores),
          issuer: deps.issuer,
          clock: deps.clock,
          generateToken: generateEnrollmentToken,
        });
        const result = await service.createEnrollment({
          tenantId: principal.tenantId,
          runnerId: body.runnerId as string,
          projectIds: body.projectIds as string[],
          ttlMs: body.ttlMs as number,
        });
        const enrollmentDto: RunnerEnrollmentDto = {
          enrollmentId: result.enrollment.enrollmentId,
          runnerId: result.enrollment.runnerId,
          tenantId: result.enrollment.tenantId,
          projectIds: [...result.enrollment.projectIds],
          expiresAt: result.enrollment.expiresAt,
          enrollmentToken: result.enrollmentToken,
        };
        return enrollmentDto;
      });

      return reply.status(201).send(commandEnvelope(dto, 1, newCorrelationId()));
    },
  );

  // Runner-facing, NO OIDC: exchange the one-time token + CSR for a certificate.
  // The tenant is a non-secret routing hint; the enrollment token is the secret.
  app.post<{ Params: { enrollmentId: string }; Body: Partial<IssueRunnerCertificateBody> }>(
    "/v1/runner-enrollments/:enrollmentId/certificate",
    async (request, reply) => {
      const tenantId = request.headers["x-tenant-id"];
      if (typeof tenantId !== "string" || tenantId.length === 0) {
        throw validationFailed("x-tenant-id header is required");
      }
      const body = request.body ?? {};
      if (typeof body.enrollmentToken !== "string" || body.enrollmentToken.length === 0) {
        throw validationFailed("enrollmentToken is required");
      }
      if (typeof body.csrPem !== "string" || body.csrPem.length === 0) {
        throw validationFailed("csrPem is required");
      }

      const dto = await withTenant(deps, tenantId, async (stores) => {
        const service = new RunnerEnrollmentService({
          enrollments: deps.enrollmentStore(stores),
          principals: deps.principalStore(stores),
          issuer: deps.issuer,
          clock: deps.clock,
        });
        try {
          const issued = await service.issueCertificate(
            request.params.enrollmentId,
            body.enrollmentToken as string,
            body.csrPem as string,
          );
          const certificateDto: RunnerCertificateDto = {
            runnerId: issued.runnerId,
            certificatePem: issued.certificatePem,
            caCertificatePem: issued.caCertificatePem,
            certificateFingerprintSha256: issued.certificateFingerprintSha256,
            certificateNotAfter: issued.certificateNotAfter,
          };
          return certificateDto;
        } catch (error) {
          if (error instanceof RunnerIdentityError) {
            throw enrollmentTokenInvalid(`enrollment could not be exchanged: ${error.code}`);
          }
          throw error;
        }
      });

      return reply.status(201).send(dto);
    },
  );

  // Runner-facing, mTLS (NEVER OIDC): resolve the presented client certificate to
  // its bound identity. The tenant is derived from the certificate's SPIFFE SAN.
  app.get("/v1/runner-identity/self", async (request, reply) => {
    const rawCert = request.headers[CLIENT_CERTIFICATE_HEADER];
    if (typeof rawCert !== "string" || rawCert.length === 0) {
      throw runnerUnauthenticated("a client certificate is required");
    }
    // A TLS-terminating proxy (e.g. nginx `$ssl_client_escaped_cert`) forwards the
    // PEM URL-encoded because a raw PEM contains newlines that are illegal in an
    // HTTP header value. Decode it, tolerating an already-decoded value.
    const certPem = rawCert.includes("\n")
      ? rawCert
      : decodeURIComponent(rawCert);

    let scopeTenant: string;
    let scopeRunner: string;
    try {
      const certificate = toX509Certificate(certPem);
      const scope = runnerScopeFromSan(certificate);
      if (scope === undefined) {
        throw runnerUnauthenticated("certificate has no runner URI SAN");
      }
      scopeTenant = scope.tenantId;
      scopeRunner = scope.runnerId;
    } catch (error) {
      if (error instanceof Error && error.name === "ApiError") {
        throw error;
      }
      throw runnerUnauthenticated("the client certificate could not be parsed");
    }

    const dto = await withTenant(deps, scopeTenant, async (stores) => {
      const authenticator = new SelfHostedRunnerAuthenticator({
        caCertificatePem: deps.caCertificatePem,
        principals: deps.principalStore(stores),
        clock: deps.clock,
      });
      const hello = { runnerId: scopeRunner } as RunnerHello;
      try {
        const principal = await authenticator.authenticate(certPem, hello);
        const identityDto: RunnerIdentityDto = {
          runnerId: principal.runnerId,
          tenantId: principal.tenantId,
          projectIds: [...principal.projectIds],
          status: principal.status,
          certificateFingerprintSha256: principal.certificateFingerprintSha256,
          certificateNotAfter: principal.certificateNotAfter,
        };
        return identityDto;
      } catch (error) {
        if (error instanceof RunnerIdentityError) {
          throw runnerUnauthenticated(`runner identity rejected: ${error.code}`);
        }
        throw error;
      }
    });

    return reply.send(dto);
  });
}

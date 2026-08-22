import type { FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import type { Clock } from "@qualigence/shared-kernel";
import type {
  PublicApiRole,
  RequestPrincipal,
} from "@qualigence/public-api";
import { IDEMPOTENCY_KEY_HEADER } from "@qualigence/public-api";
import type { OidcAuthenticator, RbacAuthorizer } from "@qualigence/oidc";
import { OidcError } from "@qualigence/oidc";
import type {
  RunnerCertificateIssuer,
  RunnerEnrollmentStore,
  RunnerPrincipalStore,
} from "@qualigence/runner-identity";
import type {
  PostgresDatabase,
  TenantTransactionProvider,
} from "@qualigence/postgres-runtime";
import { PostgresPrdMissionRepository, PostgresProjectTargetRepository, PostgresTestPlanRepository } from "@qualigence/postgres-runtime";
import type { ReviewTaskRepository } from "@qualigence/review";
import { ProjectTargetService, type ProjectTargetRepository } from "@qualigence/project-target";
import { MissionIntakeService, TestPlanService, type PrdMissionRepository, type TestPlanRepository } from "@qualigence/mission";
import type { AuxDatabase } from "./aux-schema.js";
import {
  ApiError,
  forbidden,
  idempotencyKeyRequired,
  unauthorized,
} from "./errors.js";

/** The tenant-scoped query surfaces available inside a request transaction. */
export interface TenantStores {
  readonly db: Kysely<PostgresDatabase>;
  readonly aux: Kysely<AuxDatabase>;
}

/** Everything the routes need, wired once at startup. */
export interface ServerDeps {
  readonly provider: TenantTransactionProvider;
  readonly oidc: OidcAuthenticator;
  readonly rbac: RbacAuthorizer;
  readonly issuer: RunnerCertificateIssuer;
  readonly caCertificatePem: string;
  readonly clock: Clock;
  /** Factories so the Runner identity stores bind to the request's tenant tx. */
  readonly enrollmentStore: (stores: TenantStores) => RunnerEnrollmentStore;
  readonly principalStore: (stores: TenantStores) => RunnerPrincipalStore;
  /** Factory so review aggregate writes use the request's tenant transaction. */
  readonly reviewRepository: (stores: TenantStores) => ReviewTaskRepository;
  readonly projectTargetRepository?: (stores: TenantStores, tenantId: string) => ProjectTargetRepository;
  readonly testPlanRepository?: (stores: TenantStores, tenantId: string) => TestPlanRepository;
  readonly prdMissionRepository?: (stores: TenantStores, tenantId: string) => PrdMissionRepository;
}

export function projectTargetService(deps: ServerDeps, stores: TenantStores, tenantId: string): ProjectTargetService {
  return new ProjectTargetService(projectTargets(deps, stores, tenantId), deps.clock);
}

export function projectTargets(deps: ServerDeps, stores: TenantStores, tenantId: string): ProjectTargetRepository {
  return deps.projectTargetRepository?.(stores, tenantId) ?? new PostgresProjectTargetRepository(stores.db, tenantId);
}

export function testPlans(deps: ServerDeps, stores: TenantStores, tenantId: string): TestPlanRepository {
  return deps.testPlanRepository?.(stores, tenantId) ?? new PostgresTestPlanRepository(stores.db, tenantId);
}

export function testPlanService(deps: ServerDeps, stores: TenantStores, tenantId: string): TestPlanService {
  return new TestPlanService(testPlans(deps, stores, tenantId), deps.clock, async (projectId) => (await stores.aux.selectFrom("projects").select("project_id").where("project_id", "=", projectId).executeTakeFirst()) !== undefined);
}

export function missionIntakeService(deps: ServerDeps, stores: TenantStores, tenantId: string): MissionIntakeService {
  const repository = deps.prdMissionRepository?.(stores, tenantId) ?? new PostgresPrdMissionRepository(stores.db, tenantId);
  return new MissionIntakeService(projectTargets(deps, stores, tenantId), testPlans(deps, stores, tenantId), repository, deps.clock);
}

/** Authenticate a human caller from the OIDC bearer token. Fails closed (401). */
export async function authenticateOidc(
  deps: ServerDeps,
  request: FastifyRequest,
): Promise<RequestPrincipal> {
  const header = request.headers.authorization;
  if (header === undefined || !header.toLowerCase().startsWith("bearer ")) {
    throw unauthorized("a Bearer access token is required");
  }
  const token = header.slice("bearer ".length).trim();
  try {
    return await deps.oidc.authenticate(token);
  } catch (error) {
    if (error instanceof OidcError) {
      throw unauthorized("the access token is not valid");
    }
    throw error;
  }
}

/** Enforce the minimum role for a human route. Fails closed (403). */
export function requireRole(
  deps: ServerDeps,
  principal: RequestPrincipal,
  role: PublicApiRole,
): void {
  if (!deps.rbac.satisfies(principal, role)) {
    throw forbidden(`role ${role} is required`);
  }
}

/** Require the Idempotency-Key header on a mutation; returns its value. */
export function requireIdempotencyKey(request: FastifyRequest): string {
  const key = request.headers[IDEMPOTENCY_KEY_HEADER];
  if (typeof key !== "string" || key.trim().length === 0) {
    throw idempotencyKeyRequired();
  }
  return key.trim();
}

/** Run an operation inside the tenant's RLS-scoped transaction. */
export async function withTenant<T>(
  deps: ServerDeps,
  tenantId: string,
  operation: (stores: TenantStores) => Promise<T>,
): Promise<T> {
  return deps.provider.withTenant(tenantId, ({ db }) =>
    operation({
      db: db as unknown as Kysely<PostgresDatabase>,
      aux: db as unknown as Kysely<AuxDatabase>,
    }),
  );
}

export type { RunnerCertificateIssuer, ApiError };

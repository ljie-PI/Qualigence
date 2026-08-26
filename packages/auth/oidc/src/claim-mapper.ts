import type { PublicApiRole, RequestPrincipal } from "@qualigence/public-api";
import { OidcError } from "./errors.js";

const PUBLIC_API_ROLES = ["admin", "tester", "reviewer", "viewer"] as const satisfies readonly PublicApiRole[];
const PUBLIC_API_ROLE_SET: ReadonlySet<string> = new Set(PUBLIC_API_ROLES);

function isPublicApiRole(value: unknown): value is PublicApiRole {
  return typeof value === "string" && PUBLIC_API_ROLE_SET.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function stringArray(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${name} must be a non-empty string array`);
  }
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new Error(`${name} must contain only non-empty strings`);
    }
    if (!result.includes(entry)) {
      result.push(entry);
    }
  }
  return result;
}

function roleMap(value: unknown, name: string): Readonly<Record<string, PublicApiRole>> {
  if (!isRecord(value)) {
    throw new Error(`${name} must be an object`);
  }
  const result: Record<string, PublicApiRole> = {};
  for (const [rawRole, mappedRole] of Object.entries(value)) {
    if (rawRole.trim().length === 0) {
      throw new Error(`${name} must not contain an empty raw role`);
    }
    if (!isPublicApiRole(mappedRole)) {
      throw new Error(`${name} maps ${rawRole} to unsupported Public API role ${String(mappedRole)}`);
    }
    result[rawRole] = mappedRole;
  }
  if (Object.keys(result).length === 0) {
    throw new Error(`${name} must not be empty`);
  }
  return result;
}

/** Validate and copy a deployment-provided OIDC claim-map configuration. */
export function parseClaimMapperConfig(value: unknown, name = "ClaimMapperConfig"): ClaimMapperConfig {
  if (!isRecord(value)) {
    throw new Error(`${name} must be an object`);
  }
  return {
    tenantClaim: nonEmptyString(value.tenantClaim, `${name}.tenantClaim`),
    rolesClaim: nonEmptyString(value.rolesClaim, `${name}.rolesClaim`),
    allowedTenants: stringArray(value.allowedTenants, `${name}.allowedTenants`),
    roleMap: roleMap(value.roleMap, `${name}.roleMap`),
  };
}

/**
 * Deployment-configured mapping from raw OIDC token claims to a
 * {@link RequestPrincipal}. Tenant and role claim NAMES and their allowed
 * VALUES are pinned by configuration — an unknown tenant, an unmapped role
 * value or a missing claim fails closed rather than trusting an arbitrary
 * same-named claim from the token.
 */
export interface ClaimMapperConfig {
  /** Claim name carrying the tenant id (e.g. a namespaced custom claim). */
  readonly tenantClaim: string;
  /** Claim name carrying the caller's roles (string or string[]). */
  readonly rolesClaim: string;
  /** Allowlist of tenant ids this deployment serves. */
  readonly allowedTenants: readonly string[];
  /** Allowlisted map from a raw role claim value to a Public API role. */
  readonly roleMap: Readonly<Record<string, PublicApiRole>>;
}

export class ClaimMapper {
  private readonly allowedTenants: ReadonlySet<string>;
  private readonly config: ClaimMapperConfig;

  constructor(config: ClaimMapperConfig) {
    this.config = parseClaimMapperConfig(config);
    this.allowedTenants = new Set(this.config.allowedTenants);
  }

  map(subject: string, claims: Readonly<Record<string, unknown>>): RequestPrincipal {
    const tenantValue = claims[this.config.tenantClaim];
    if (typeof tenantValue !== "string" || tenantValue.trim().length === 0) {
      throw new OidcError("TenantClaimMissing", `missing claim ${this.config.tenantClaim}`);
    }
    if (!this.allowedTenants.has(tenantValue)) {
      throw new OidcError("TenantNotAllowed", `tenant ${tenantValue} is not allowed`);
    }

    const rawRoles = claims[this.config.rolesClaim];
    let roleValues: readonly string[] | undefined;
    if (typeof rawRoles === "string") {
      roleValues = [rawRoles];
    } else if (Array.isArray(rawRoles)) {
      if (!rawRoles.every((value): value is string => typeof value === "string")) {
        throw new OidcError("RoleNotAllowed", `claim ${this.config.rolesClaim} contains a non-string role`);
      }
      roleValues = rawRoles;
    }
    if (roleValues === undefined || roleValues.length === 0 || roleValues.some((value) => value.trim().length === 0)) {
      throw new OidcError("RoleClaimMissing", `missing claim ${this.config.rolesClaim}`);
    }

    const roles: PublicApiRole[] = [];
    for (const value of roleValues) {
      const mapped = this.config.roleMap[value];
      if (mapped === undefined) {
        throw new OidcError("RoleNotAllowed", `role ${value} is not allowed`);
      }
      if (!isPublicApiRole(mapped)) {
        throw new OidcError("RoleNotAllowed", `role ${value} maps to an unsupported Public API role`);
      }
      if (!roles.includes(mapped)) {
        roles.push(mapped);
      }
    }

    return { subject, tenantId: tenantValue, roles };
  }
}

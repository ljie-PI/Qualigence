import type { PublicApiRole, RequestPrincipal } from "@qualigence/public-api";
import { OidcError } from "./errors.js";

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

  constructor(private readonly config: ClaimMapperConfig) {
    this.allowedTenants = new Set(config.allowedTenants);
  }

  map(subject: string, claims: Readonly<Record<string, unknown>>): RequestPrincipal {
    const tenantValue = claims[this.config.tenantClaim];
    if (typeof tenantValue !== "string" || tenantValue.length === 0) {
      throw new OidcError("TenantClaimMissing", `missing claim ${this.config.tenantClaim}`);
    }
    if (!this.allowedTenants.has(tenantValue)) {
      throw new OidcError("TenantNotAllowed", `tenant ${tenantValue} is not allowed`);
    }

    const rawRoles = claims[this.config.rolesClaim];
    const roleValues =
      typeof rawRoles === "string"
        ? [rawRoles]
        : Array.isArray(rawRoles)
          ? rawRoles.filter((value): value is string => typeof value === "string")
          : undefined;
    if (roleValues === undefined || roleValues.length === 0) {
      throw new OidcError("RoleClaimMissing", `missing claim ${this.config.rolesClaim}`);
    }

    const roles: PublicApiRole[] = [];
    for (const value of roleValues) {
      const mapped = this.config.roleMap[value];
      if (mapped === undefined) {
        throw new OidcError("RoleNotAllowed", `role ${value} is not allowed`);
      }
      if (!roles.includes(mapped)) {
        roles.push(mapped);
      }
    }

    return { subject, tenantId: tenantValue, roles };
  }
}

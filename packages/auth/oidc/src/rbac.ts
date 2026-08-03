import type { PublicApiRole, RequestPrincipal } from "@qualigence/public-api";
import { OidcError } from "./errors.js";

/**
 * The roles each role implicitly satisfies. `admin` is a superset; `tester` and
 * `reviewer` both include read (`viewer`) access, but neither implies the other.
 */
const ROLE_SATISFIES: Readonly<Record<PublicApiRole, readonly PublicApiRole[]>> = {
  admin: ["admin", "tester", "reviewer", "viewer"],
  tester: ["tester", "viewer"],
  reviewer: ["reviewer", "viewer"],
  viewer: ["viewer"],
};

/**
 * Role-based authorization for human-facing routes. Each route declares the
 * minimum role it requires; a principal is authorized when any of its roles
 * satisfies that requirement. A missing or insufficient role fails closed with
 * a `Forbidden` {@link OidcError} the Server maps to 403.
 */
export class RbacAuthorizer {
  satisfies(principal: RequestPrincipal, required: PublicApiRole): boolean {
    return principal.roles.some((role) => ROLE_SATISFIES[role].includes(required));
  }

  require(principal: RequestPrincipal, required: PublicApiRole): void {
    if (!this.satisfies(principal, required)) {
      throw new OidcError(
        "Forbidden",
        `role ${required} is required but principal has [${principal.roles.join(", ")}]`,
      );
    }
  }
}

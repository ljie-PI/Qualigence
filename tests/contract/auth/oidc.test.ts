import { describe, expect, it } from "vitest";
import {
  ClaimMapper,
  OidcAuthenticator,
  OidcError,
  RbacAuthorizer,
  StaticJwksResolver,
  type ClaimMapperConfig,
} from "@qualigence/oidc";
import type { RequestPrincipal } from "@qualigence/public-api";
import { createTestJwtIssuer, standardClaims } from "../../helpers/oidc-jwt.js";

const TENANT_CLAIM = "https://qualigence.dev/tenant";
const ROLES_CLAIM = "https://qualigence.dev/roles";

const claimMapperConfig: ClaimMapperConfig = {
  tenantClaim: TENANT_CLAIM,
  rolesClaim: ROLES_CLAIM,
  allowedTenants: ["tenant-a", "tenant-b"],
  roleMap: {
    "qualigence:admin": "admin",
    "qualigence:tester": "tester",
    "qualigence:reviewer": "reviewer",
    "qualigence:viewer": "viewer",
  },
};

const clock = { now: () => new Date().toISOString() };

function makeAuthenticator(issuer = createTestJwtIssuer("RS256")): {
  authenticator: OidcAuthenticator;
  issuer: ReturnType<typeof createTestJwtIssuer>;
} {
  const authenticator = new OidcAuthenticator({
    issuer: "https://oidc.example.test/",
    audience: "qualigence-self-hosted",
    allowedAlgorithms: ["RS256", "ES256"],
    jwks: new StaticJwksResolver([issuer.signingKey]),
    clock,
    claimMapper: new ClaimMapper(claimMapperConfig),
  });
  return { authenticator, issuer };
}

function tokenClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return standardClaims({
    [TENANT_CLAIM]: "tenant-a",
    [ROLES_CLAIM]: ["qualigence:tester"],
    ...overrides,
  });
}

describe("OidcAuthenticator", () => {
  it("authenticates a valid RS256 token and maps tenant/role claims", async () => {
    const { authenticator, issuer } = makeAuthenticator();
    const principal = await authenticator.authenticate(issuer.sign(tokenClaims()));
    expect(principal).toEqual<RequestPrincipal>({
      subject: "user-123",
      tenantId: "tenant-a",
      roles: ["tester"],
    });
  });

  it("authenticates a valid ES256 token", async () => {
    const es = createTestJwtIssuer("ES256", "es-key");
    const { authenticator } = makeAuthenticator(es);
    const principal = await authenticator.authenticate(es.sign(tokenClaims()));
    expect(principal.tenantId).toBe("tenant-a");
  });

  it("rejects an unknown issuer", async () => {
    const { authenticator, issuer } = makeAuthenticator();
    await expect(
      authenticator.authenticate(issuer.sign(tokenClaims({ iss: "https://evil.test/" }))),
    ).rejects.toMatchObject({ code: "IssuerMismatch" });
  });

  it("rejects a wrong audience", async () => {
    const { authenticator, issuer } = makeAuthenticator();
    await expect(
      authenticator.authenticate(issuer.sign(tokenClaims({ aud: "some-other-api" }))),
    ).rejects.toMatchObject({ code: "AudienceMismatch" });
  });

  it("rejects an expired token", async () => {
    const { authenticator, issuer } = makeAuthenticator();
    const past = Math.floor(Date.now() / 1000) - 7200;
    await expect(
      authenticator.authenticate(issuer.sign(tokenClaims({ exp: past }))),
    ).rejects.toMatchObject({ code: "TokenExpired" });
  });

  it("rejects a token signed by an unknown key", async () => {
    const { authenticator } = makeAuthenticator();
    const rogue = createTestJwtIssuer("RS256", "rogue-key");
    await expect(
      authenticator.authenticate(rogue.sign(tokenClaims())),
    ).rejects.toMatchObject({ code: "SigningKeyUnknown" });
  });

  it("rejects a token whose signature does not verify", async () => {
    const { authenticator, issuer } = makeAuthenticator();
    const token = issuer.sign(tokenClaims());
    const tampered = `${token.slice(0, -4)}AAAA`;
    await expect(authenticator.authenticate(tampered)).rejects.toBeInstanceOf(OidcError);
  });

  it("rejects a disallowed algorithm (alg downgrade)", async () => {
    const { authenticator, issuer } = makeAuthenticator();
    // Forge a header claiming 'none' while reusing a real signature segment.
    const forgedHeader = Buffer.from(JSON.stringify({ alg: "none", kid: issuer.kid })).toString(
      "base64url",
    );
    const payload = Buffer.from(JSON.stringify(tokenClaims())).toString("base64url");
    await expect(
      authenticator.authenticate(`${forgedHeader}.${payload}.`),
    ).rejects.toMatchObject({ code: "AlgorithmNotAllowed" });
  });

  it("rejects an unknown tenant claim (fail closed)", async () => {
    const { authenticator, issuer } = makeAuthenticator();
    await expect(
      authenticator.authenticate(issuer.sign(tokenClaims({ [TENANT_CLAIM]: "tenant-x" }))),
    ).rejects.toMatchObject({ code: "TenantNotAllowed" });
  });

  it("rejects an unmapped role value (fail closed)", async () => {
    const { authenticator, issuer } = makeAuthenticator();
    await expect(
      authenticator.authenticate(issuer.sign(tokenClaims({ [ROLES_CLAIM]: ["superuser"] }))),
    ).rejects.toMatchObject({ code: "RoleNotAllowed" });
  });
});

describe("RbacAuthorizer", () => {
  const rbac = new RbacAuthorizer();
  const principal = (roles: RequestPrincipal["roles"]): RequestPrincipal => ({
    subject: "u",
    tenantId: "tenant-a",
    roles,
  });

  it("lets a tester write and read but not admin", () => {
    expect(rbac.satisfies(principal(["tester"]), "tester")).toBe(true);
    expect(rbac.satisfies(principal(["tester"]), "viewer")).toBe(true);
    expect(rbac.satisfies(principal(["tester"]), "admin")).toBe(false);
    expect(rbac.satisfies(principal(["tester"]), "reviewer")).toBe(false);
  });

  it("lets a reviewer review and read but not write", () => {
    expect(rbac.satisfies(principal(["reviewer"]), "reviewer")).toBe(true);
    expect(rbac.satisfies(principal(["reviewer"]), "viewer")).toBe(true);
    expect(rbac.satisfies(principal(["reviewer"]), "tester")).toBe(false);
  });

  it("lets admin satisfy every role", () => {
    for (const role of ["admin", "tester", "reviewer", "viewer"] as const) {
      expect(rbac.satisfies(principal(["admin"]), role)).toBe(true);
    }
  });

  it("throws Forbidden when the role is insufficient", () => {
    expect(() => rbac.require(principal(["viewer"]), "tester")).toThrowError(OidcError);
    try {
      rbac.require(principal(["viewer"]), "tester");
    } catch (error) {
      expect((error as OidcError).code).toBe("Forbidden");
    }
  });
});

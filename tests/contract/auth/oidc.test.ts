import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  ClaimMapper,
  OidcAuthenticator,
  OidcError,
  RbacAuthorizer,
  RemoteJwksResolver,
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

const openServers: Server[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function tokenClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return standardClaims({
    [TENANT_CLAIM]: "tenant-a",
    [ROLES_CLAIM]: ["qualigence:tester"],
    ...overrides,
  });
}

async function startJwksServer(currentJwks: () => unknown, status = () => 200): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(status(), { "content-type": "application/json" });
    response.end(JSON.stringify(currentJwks()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  openServers.push(server);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("JWKS test server did not bind");
  return `http://127.0.0.1:${address.port}/jwks`;
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

  it("fetches remote JWKS with a bounded cache and refreshes on issuer key rotation", async () => {
    const first = createTestJwtIssuer("RS256", "first-key");
    let servedJwks = first.jwks;
    let fetches = 0;
    const jwksUri = await startJwksServer(() => {
      fetches += 1;
      return servedJwks;
    });
    const jwks = new RemoteJwksResolver({
      jwksUri,
      allowedAlgorithms: ["RS256"],
      timeoutMs: 1_000,
      cacheTtlMs: 60_000,
      rotationCooldownMs: 0,
      clock,
    });
    const authenticator = new OidcAuthenticator({
      issuer: "https://oidc.example.test/",
      audience: "qualigence-self-hosted",
      allowedAlgorithms: ["RS256"],
      jwks,
      clock,
      claimMapper: new ClaimMapper(claimMapperConfig),
    });

    await expect(authenticator.authenticate(first.sign(tokenClaims()))).resolves.toMatchObject({ tenantId: "tenant-a" });
    await expect(authenticator.authenticate(first.sign(tokenClaims()))).resolves.toMatchObject({ tenantId: "tenant-a" });
    expect(fetches).toBe(1);

    const rotated = createTestJwtIssuer("RS256", "rotated-key");
    servedJwks = rotated.jwks;
    await expect(authenticator.authenticate(rotated.sign(tokenClaims()))).resolves.toMatchObject({ subject: "user-123" });
    expect(fetches).toBe(2);
  });

  it("fails closed when remote JWKS is unavailable or times out", async () => {
    let status = 503;
    const issuer = createTestJwtIssuer("RS256", "available-after-recovery");
    const jwksUri = await startJwksServer(() => issuer.jwks, () => status);
    const unavailable = new RemoteJwksResolver({
      jwksUri,
      allowedAlgorithms: ["RS256"],
      timeoutMs: 1_000,
      cacheTtlMs: 60_000,
      rotationCooldownMs: 0,
      clock,
    });
    await expect(unavailable.resolve("missing")).rejects.toMatchObject({ code: "JwksUnavailable" });
    status = 200;
    await expect(unavailable.refresh()).resolves.toBeUndefined();
    expect(unavailable.readiness()).toMatchObject({ status: "ready", keyCount: 1 });

    const timeout = new RemoteJwksResolver({
      jwksUri: "http://127.0.0.1:1/jwks",
      allowedAlgorithms: ["RS256"],
      timeoutMs: 1,
      fetcher: async () => new Promise<Response>(() => undefined),
      clock,
    });
    await expect(timeout.resolve("any")).rejects.toMatchObject({ code: "JwksTimeout" });
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

  it("rejects a claim-map config that maps into an unsupported Public API role", () => {
    expect(() => new ClaimMapper({
      ...claimMapperConfig,
      roleMap: { "qualigence:owner": "owner" } as unknown as ClaimMapperConfig["roleMap"],
    })).toThrow(/unsupported Public API role/);
  });

  it("rejects malformed subject and role claims (fail closed)", async () => {
    const { authenticator, issuer } = makeAuthenticator();
    await expect(
      authenticator.authenticate(issuer.sign(tokenClaims({ sub: "" }))),
    ).rejects.toMatchObject({ code: "TokenMalformed" });
    await expect(
      authenticator.authenticate(issuer.sign(tokenClaims({ [ROLES_CLAIM]: ["qualigence:tester", 42] }))),
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

  it("fails closed instead of throwing TypeError if an unsafe role reaches the RBAC boundary", () => {
    const unsafePrincipal = principal(["owner"] as unknown as RequestPrincipal["roles"]);
    expect(rbac.satisfies(unsafePrincipal, "viewer")).toBe(false);
    expect(() => rbac.require(unsafePrincipal, "viewer")).toThrowError(OidcError);
  });
});

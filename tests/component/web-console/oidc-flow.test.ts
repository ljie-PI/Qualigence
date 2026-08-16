import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MemoryTokenStore } from "../../../apps/web-console/src/auth/memory-token-store.js";
import { RemoteJwksIdTokenVerifier } from "../../../apps/web-console/src/auth/id-token-verifier.js";
import {
  OidcSession,
  OidcSessionError,
  type OidcClientConfig,
  type TransientStore,
} from "../../../apps/web-console/src/auth/oidc-session.js";
import { computeS256Challenge } from "../../../apps/web-console/src/auth/pkce.js";
import {
  createTestJwtIssuer,
  tamperJwtPayload,
  type TestJwtIssuer,
} from "../../helpers/oidc-jwt.js";

const TENANT_CLAIM = "https://qualigence.example/tenant";
const ROLES_CLAIM = "https://qualigence.example/roles";
const ISSUER = "https://idp.test/";
const CLIENT_ID = "qualigence-console";

/** In-memory stand-in for the browser's TTL-bounded sessionStorage. */
class FakeTransientStore implements TransientStore {
  readonly writes: string[] = [];
  private readonly map = new Map<string, string>();
  set(key: string, value: string): void {
    this.writes.push(value);
    this.map.set(key, value);
  }
  get(key: string): string | undefined {
    return this.map.get(key);
  }
  remove(key: string): void {
    this.map.delete(key);
  }
  size(): number {
    return this.map.size;
  }
  everyValue(): string[] {
    return [...this.map.values()];
  }
}

describe("Web Console OIDC Authorization Code + PKCE flow", () => {
  let jwt: TestJwtIssuer;
  let tokenServer: Server;
  let tokenEndpoint: string;
  let jwksEndpoint: string;
  let issuedAccessToken = "access-token-value-xyz";
  let idTokenNonce = "";
  let lastTokenRequestBody = "";
  let issueIdToken: (claims: Readonly<Record<string, unknown>>) => string;
  let servedJwks: TestJwtIssuer["jwks"];
  let jwksStatus: number;

  function makeConfig(): OidcClientConfig {
    return {
      issuer: ISSUER,
      authorizationEndpoint: "https://idp.test/authorize",
      tokenEndpoint,
      clientId: CLIENT_ID,
      redirectUri: "https://console.test/callback",
      scope: "openid profile",
      tenantClaim: TENANT_CLAIM,
      rolesClaim: ROLES_CLAIM,
      jwksUri: jwksEndpoint,
      allowedAlgorithms: ["RS256"],
      roleMap: {
        "qa-admin": "admin",
        "qa-tester": "tester",
        "qa-reviewer": "reviewer",
        "qa-viewer": "viewer",
      },
      allowedTenants: ["tenant-a"],
    };
  }

  function makeVerifier(config = makeConfig()): RemoteJwksIdTokenVerifier {
    return new RemoteJwksIdTokenVerifier({
      jwksUri: config.jwksUri,
      allowedAlgorithms: config.allowedAlgorithms,
      timeoutDuration: 1_000,
      cooldownDuration: 0,
      cacheMaxAge: 1_000,
    });
  }

  function makeSession(
    transient: TransientStore,
    config: OidcClientConfig = makeConfig(),
  ): OidcSession {
    return new OidcSession(config, transient, makeVerifier(config));
  }

  beforeAll(async () => {
    jwt = createTestJwtIssuer("RS256");
    issueIdToken = (claims) => jwt.sign(claims);
    servedJwks = jwt.jwks;
    jwksStatus = 200;
    tokenServer = createServer((req, res) => {
      if (req.url === "/jwks") {
        res.writeHead(jwksStatus, { "content-type": "application/json" });
        res.end(JSON.stringify(servedJwks));
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        lastTokenRequestBody = Buffer.concat(chunks).toString("utf8");
        const nowSeconds = Math.floor(Date.now() / 1000);
        const idToken = issueIdToken({
          iss: ISSUER,
          aud: CLIENT_ID,
          sub: "user-42",
          nonce: idTokenNonce,
          iat: nowSeconds,
          exp: nowSeconds + 3600,
          [TENANT_CLAIM]: "tenant-a",
          [ROLES_CLAIM]: ["qa-reviewer"],
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            access_token: issuedAccessToken,
            id_token: idToken,
            token_type: "Bearer",
            expires_in: 3600,
          }),
        );
      });
    });
    await new Promise<void>((resolve) => tokenServer.listen(0, "127.0.0.1", resolve));
    const address = tokenServer.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    tokenEndpoint = `http://127.0.0.1:${port}/token`;
    jwksEndpoint = `http://127.0.0.1:${port}/jwks`;
  });

  beforeEach(() => {
    issueIdToken = (claims) => jwt.sign(claims);
    servedJwks = jwt.jwks;
    jwksStatus = 200;
    idTokenNonce = "";
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => tokenServer.close(() => resolve()));
  });

  it("builds an S256 authorization URL with independent, unpredictable secrets", async () => {
    const transient = new FakeTransientStore();
    const session = makeSession(transient);

    const first = await session.beginAuthorization();
    const second = await session.beginAuthorization();

    const url = new URL(first.authorizationUrl);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe("https://console.test/callback");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.searchParams.get("nonce")).toBeTruthy();
    expect(url.searchParams.get("code_challenge")).toBeTruthy();

    // Each authorization must produce distinct state/nonce/challenge.
    const secondUrl = new URL(second.authorizationUrl);
    expect(secondUrl.searchParams.get("state")).not.toBe(url.searchParams.get("state"));
    expect(secondUrl.searchParams.get("nonce")).not.toBe(url.searchParams.get("nonce"));
    expect(secondUrl.searchParams.get("code_challenge")).not.toBe(
      url.searchParams.get("code_challenge"),
    );

    // The stored code_verifier must actually hash (S256) to the sent challenge.
    const record = JSON.parse(transient.everyValue()[0] as string) as { codeVerifier: string };
    const expectedChallenge = await computeS256Challenge(record.codeVerifier);
    // Re-derive the URL that used the first stored record's state.
    const matchingUrl = [first, second]
      .map((r) => new URL(r.authorizationUrl))
      .find((u) => u.searchParams.get("state") === (JSON.parse(transient.everyValue()[0] as string) as { state: string }).state);
    expect(matchingUrl?.searchParams.get("code_challenge")).toBe(expectedChallenge);
  });

  it("completes the callback, storing the access token ONLY in memory (never in storage)", async () => {
    const transient = new FakeTransientStore();
    const store = new MemoryTokenStore();
    const session = makeSession(transient);

    const begin = await session.beginAuthorization();
    const record = JSON.parse(transient.get(`oidc.tx.${begin.state}`) as string) as {
      nonce: string;
    };
    idTokenNonce = record.nonce;

    const consoleSession = await session.completeAuthorization({
      code: "auth-code-1",
      state: begin.state,
    });
    store.set(consoleSession);

    expect(consoleSession.tenantId).toBe("tenant-a");
    expect(consoleSession.roles).toEqual(["reviewer"]);
    expect(store.accessToken()).toBe(issuedAccessToken);

    // The transient record (the only thing that ever touches sessionStorage) is
    // cleared after callback and NEVER contained the access token.
    expect(transient.size()).toBe(0);
    for (const value of transient.writes) {
      expect(value).not.toContain(issuedAccessToken);
    }
    // The code_verifier was sent to the token endpoint (proof of PKCE).
    expect(lastTokenRequestBody).toContain("code_verifier=");
    expect(lastTokenRequestBody).toContain("grant_type=authorization_code");
  });

  it("rejects an ID Token whose payload changed after signing and clears the transient record", async () => {
    const transient = new FakeTransientStore();
    const session = makeSession(transient);
    const begin = await session.beginAuthorization();
    const record = JSON.parse(transient.get(`oidc.tx.${begin.state}`) as string) as {
      nonce: string;
    };
    idTokenNonce = record.nonce;
    issueIdToken = (claims) =>
      tamperJwtPayload(jwt.sign(claims), (signedClaims) => ({
        ...signedClaims,
        sub: "attacker",
      }));

    await expect(
      session.completeAuthorization({ code: "tampered-code", state: begin.state }),
    ).rejects.toMatchObject({ reason: "TokenSignatureInvalid" });
    expect(transient.size()).toBe(0);
  });

  it("rejects an ID Token signed by an unknown kid", async () => {
    const transient = new FakeTransientStore();
    const session = makeSession(transient);
    const begin = await session.beginAuthorization();
    const record = JSON.parse(transient.get(`oidc.tx.${begin.state}`) as string) as {
      nonce: string;
    };
    idTokenNonce = record.nonce;
    const unknown = createTestJwtIssuer("RS256", "unknown-key");
    issueIdToken = (claims) => unknown.sign(claims);

    await expect(
      session.completeAuthorization({ code: "unknown-kid-code", state: begin.state }),
    ).rejects.toMatchObject({ reason: "TokenSignatureInvalid" });
    expect(transient.size()).toBe(0);
  });

  it("rejects a correctly signed ID Token whose algorithm is not allowlisted", async () => {
    const transient = new FakeTransientStore();
    const session = makeSession(transient);
    const begin = await session.beginAuthorization();
    const record = JSON.parse(transient.get(`oidc.tx.${begin.state}`) as string) as {
      nonce: string;
    };
    idTokenNonce = record.nonce;
    const es256 = createTestJwtIssuer("ES256", "es256-key");
    servedJwks = { keys: [...jwt.jwks.keys, ...es256.jwks.keys] };
    issueIdToken = (claims) => es256.sign(claims);

    await expect(
      session.completeAuthorization({ code: "disallowed-alg-code", state: begin.state }),
    ).rejects.toMatchObject({ reason: "TokenSignatureInvalid" });
    expect(transient.size()).toBe(0);
  });

  it("rejects a runtime verifier configuration containing a symmetric algorithm", () => {
    expect(
      () =>
        new RemoteJwksIdTokenVerifier({
          jwksUri: jwksEndpoint,
          allowedAlgorithms: ["HS256"],
        }),
    ).toThrow(/RS256 or ES256/);
  });

  it("rejects an expired ID Token even when the token endpoint returns 200", async () => {
    const transient = new FakeTransientStore();
    const session = makeSession(transient);
    const begin = await session.beginAuthorization();
    const record = JSON.parse(transient.get(`oidc.tx.${begin.state}`) as string) as {
      nonce: string;
    };
    idTokenNonce = record.nonce;
    issueIdToken = (claims) =>
      jwt.sign({ ...claims, exp: Math.floor(Date.now() / 1000) - 60 });

    await expect(
      session.completeAuthorization({ code: "expired-code", state: begin.state }),
    ).rejects.toMatchObject({ reason: "TokenExpired" });
    expect(transient.size()).toBe(0);
  });

  it("maps an unavailable JWKS endpoint to a stable error and clears transient state", async () => {
    const transient = new FakeTransientStore();
    const session = makeSession(transient);
    const begin = await session.beginAuthorization();
    const record = JSON.parse(transient.get(`oidc.tx.${begin.state}`) as string) as {
      nonce: string;
    };
    idTokenNonce = record.nonce;
    jwksStatus = 503;

    await expect(
      session.completeAuthorization({ code: "jwks-down-code", state: begin.state }),
    ).rejects.toMatchObject({ reason: "JwksUnavailable" });
    expect(transient.size()).toBe(0);
  });

  it("rejects a callback whose state has no transient record (CSRF / mismatch)", async () => {
    const transient = new FakeTransientStore();
    const session = makeSession(transient);
    await session.beginAuthorization();
    await expect(
      session.completeAuthorization({ code: "x", state: "forged-state" }),
    ).rejects.toBeInstanceOf(OidcSessionError);
  });

  it("rejects a callback whose id_token nonce does not match", async () => {
    const transient = new FakeTransientStore();
    const session = makeSession(transient);
    const begin = await session.beginAuthorization();
    idTokenNonce = "a-different-nonce"; // server mints a mismatching nonce
    const error = await session
      .completeAuthorization({ code: "auth-code-2", state: begin.state })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OidcSessionError);
    expect((error as OidcSessionError).reason).toBe("NonceMismatch");
    expect(transient.size()).toBe(0);
  });

  it("rejects a valid signature with the wrong issuer", async () => {
    const transient = new FakeTransientStore();
    const session = makeSession(transient);
    const begin = await session.beginAuthorization();
    const record = JSON.parse(transient.get(`oidc.tx.${begin.state}`) as string) as {
      nonce: string;
    };
    idTokenNonce = record.nonce;
    issueIdToken = (claims) => jwt.sign({ ...claims, iss: "https://attacker.test/" });

    await expect(
      session.completeAuthorization({ code: "wrong-issuer-code", state: begin.state }),
    ).rejects.toMatchObject({ reason: "IssuerMismatch" });
    expect(transient.size()).toBe(0);
  });

  it("rejects a valid signature with the wrong audience", async () => {
    const transient = new FakeTransientStore();
    const session = makeSession(transient);
    const begin = await session.beginAuthorization();
    const record = JSON.parse(transient.get(`oidc.tx.${begin.state}`) as string) as {
      nonce: string;
    };
    idTokenNonce = record.nonce;
    issueIdToken = (claims) => jwt.sign({ ...claims, aud: "another-console" });

    await expect(
      session.completeAuthorization({ code: "wrong-audience-code", state: begin.state }),
    ).rejects.toMatchObject({ reason: "AudienceMismatch" });
    expect(transient.size()).toBe(0);
  });

  it("fails closed for a tenant outside the deployment allowlist", async () => {
    const transient = new FakeTransientStore();
    const config = { ...makeConfig(), allowedTenants: ["tenant-zzz"] };
    const session = makeSession(transient, config);
    const begin = await session.beginAuthorization();
    const record = JSON.parse(transient.get(`oidc.tx.${begin.state}`) as string) as {
      nonce: string;
    };
    idTokenNonce = record.nonce;
    const error = await session
      .completeAuthorization({ code: "auth-code-3", state: begin.state })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OidcSessionError);
    expect((error as OidcSessionError).reason).toBe("TenantNotAllowed");
    expect(transient.size()).toBe(0);
  });

  it("clears the in-memory session on logout", () => {
    const store = new MemoryTokenStore();
    store.set({
      subject: "u",
      tenantId: "tenant-a",
      roles: ["viewer"],
      accessToken: "tok",
      expiresAtMs: Date.now() + 1000,
    });
    expect(store.isAuthenticated()).toBe(true);
    store.clear();
    expect(store.isAuthenticated()).toBe(false);
    expect(store.accessToken()).toBeUndefined();
  });
});

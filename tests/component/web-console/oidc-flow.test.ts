import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MemoryTokenStore } from "../../../apps/web-console/src/auth/memory-token-store.js";
import { BrowserOidcController } from "../../../apps/web-console/src/auth/browser-oidc.js";
import { RemoteJwksIdTokenVerifier } from "../../../apps/web-console/src/auth/id-token-verifier.js";
import {
  OidcSession,
  OidcSessionError,
  type OidcClientConfig,
  type TransientStore,
} from "../../../apps/web-console/src/auth/oidc-session.js";
import { computeS256Challenge } from "../../../apps/web-console/src/auth/pkce.js";
import { resolveRuntimeConfig } from "../../../apps/web-console/src/config.js";
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
  let tokenStatus: number;
  let tokenResponseMutator: ((response: Record<string, unknown>) => unknown) | undefined;

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
        res.writeHead(tokenStatus, { "content-type": "application/json" });
        const tokenResponse = {
          access_token: issuedAccessToken,
          id_token: idToken,
          token_type: "Bearer",
          expires_in: 3600,
        };
        res.end(JSON.stringify(tokenResponseMutator?.(tokenResponse) ?? tokenResponse));
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
    tokenStatus = 200;
    tokenResponseMutator = undefined;
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

  it("accepts a valid ES256 ID Token when ES256 is deployment-allowlisted", async () => {
    const transient = new FakeTransientStore();
    const config: OidcClientConfig = {
      ...makeConfig(),
      allowedAlgorithms: ["ES256"],
    };
    const es256 = createTestJwtIssuer("ES256", "allowed-es256-key");
    servedJwks = es256.jwks;
    issueIdToken = (claims) => es256.sign(claims);
    const session = makeSession(transient, config);
    const begin = await session.beginAuthorization();
    const record = JSON.parse(transient.get(`oidc.tx.${begin.state}`) as string) as {
      nonce: string;
    };
    idTokenNonce = record.nonce;

    const consoleSession = await session.completeAuthorization({
      code: "es256-auth-code",
      state: begin.state,
    });

    expect(consoleSession).toMatchObject({
      subject: "user-42",
      tenantId: "tenant-a",
      roles: ["reviewer"],
    });
    expect(transient.size()).toBe(0);
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

  it("rejects an ID Token without a non-empty subject and clears transient state", async () => {
    const transient = new FakeTransientStore();
    const session = makeSession(transient);
    const begin = await session.beginAuthorization();
    const record = JSON.parse(transient.get(`oidc.tx.${begin.state}`) as string) as {
      nonce: string;
    };
    idTokenNonce = record.nonce;
    issueIdToken = (claims) => {
      const { sub: _sub, ...withoutSubject } = claims;
      return jwt.sign(withoutSubject);
    };

    await expect(
      session.completeAuthorization({ code: "missing-sub", state: begin.state }),
    ).rejects.toMatchObject({ reason: "TokenMalformed" });
    expect(transient.size()).toBe(0);
  });

  it.each([
    [(response: Record<string, unknown>) => ({ ...response, access_token: undefined }), "missing access token"],
    [(response: Record<string, unknown>) => ({ ...response, id_token: undefined }), "missing ID token"],
    [(response: Record<string, unknown>) => ({ ...response, token_type: "MAC" }), "wrong token type"],
    [(response: Record<string, unknown>) => ({ ...response, expires_in: 0 }), "non-positive expiry"],
  ])("rejects a malformed token response ($1) and clears transient state", async (mutate, _caseName) => {
    const transient = new FakeTransientStore();
    const session = makeSession(transient);
    const begin = await session.beginAuthorization();
    const record = JSON.parse(transient.get(`oidc.tx.${begin.state}`) as string) as {
      nonce: string;
    };
    idTokenNonce = record.nonce;
    tokenResponseMutator = mutate;

    await expect(
      session.completeAuthorization({ code: "bad-token-response", state: begin.state }),
    ).rejects.toMatchObject({ reason: "TokenMalformed" });
    expect(transient.size()).toBe(0);
  });

  it("clears transient state when token exchange fails", async () => {
    const transient = new FakeTransientStore();
    const session = makeSession(transient);
    const begin = await session.beginAuthorization();
    tokenStatus = 503;

    await expect(
      session.completeAuthorization({ code: "exchange-failure", state: begin.state }),
    ).rejects.toMatchObject({ reason: "TokenExchangeFailed" });
    expect(transient.size()).toBe(0);
  });

  it("rejects malformed transient state and consumes it", async () => {
    const transient = new FakeTransientStore();
    transient.set("oidc.tx.malformed", JSON.stringify({ state: "malformed" }));
    const session = makeSession(transient);

    await expect(
      session.completeAuthorization({ code: "x", state: "malformed" }),
    ).rejects.toMatchObject({ reason: "TokenMalformed" });
    expect(transient.size()).toBe(0);
  });

  it("consumes transient state when the stored state does not match", async () => {
    const transient = new FakeTransientStore();
    transient.set(
      "oidc.tx.returned-state",
      JSON.stringify({
        state: "different-state",
        nonce: "nonce",
        codeVerifier: "verifier",
        createdAtMs: Date.now(),
      }),
    );
    const session = makeSession(transient);

    await expect(
      session.completeAuthorization({ code: "x", state: "returned-state" }),
    ).rejects.toMatchObject({ reason: "StateMismatch" });
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

  it("maps a JWKS network failure to JwksUnavailable", async () => {
    const verifier = new RemoteJwksIdTokenVerifier({
      jwksUri: "https://jwks.invalid/keys",
      allowedAlgorithms: ["RS256"],
      fetcher: async () => {
        throw new TypeError("network down");
      },
    });
    const token = jwt.sign({
      iss: ISSUER,
      aud: CLIENT_ID,
      sub: "user-42",
      exp: Math.floor(Date.now() / 1000) + 60,
    });

    await expect(
      verifier.verify(token, { issuer: ISSUER, audience: CLIENT_ID }),
    ).rejects.toMatchObject({ failure: "jwks_unavailable" });
  });

  it("refreshes a cached JWKS when the issuer rotates to a new key", async () => {
    const transient = new FakeTransientStore();
    const session = makeSession(transient);
    const first = await session.beginAuthorization();
    const firstRecord = JSON.parse(transient.get(`oidc.tx.${first.state}`) as string) as {
      nonce: string;
    };
    idTokenNonce = firstRecord.nonce;
    await session.completeAuthorization({ code: "before-rotation", state: first.state });

    const rotated = createTestJwtIssuer("RS256", "rotated-key");
    servedJwks = rotated.jwks;
    issueIdToken = (claims) => rotated.sign(claims);
    const second = await session.beginAuthorization();
    const secondRecord = JSON.parse(transient.get(`oidc.tx.${second.state}`) as string) as {
      nonce: string;
    };
    idTokenNonce = secondRecord.nonce;

    await expect(
      session.completeAuthorization({ code: "after-rotation", state: second.state }),
    ).resolves.toMatchObject({ subject: "user-42" });
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

  it("fails closed when a role claim contains a malformed value", async () => {
    const transient = new FakeTransientStore();
    const session = makeSession(transient);
    const begin = await session.beginAuthorization();
    const record = JSON.parse(transient.get(`oidc.tx.${begin.state}`) as string) as {
      nonce: string;
    };
    idTokenNonce = record.nonce;
    issueIdToken = (claims) => jwt.sign({ ...claims, [ROLES_CLAIM]: ["qa-reviewer", 42] });

    await expect(
      session.completeAuthorization({ code: "bad-role", state: begin.state }),
    ).rejects.toMatchObject({ reason: "RoleNotAllowed" });
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

  it("recognizes callbacks only at the exact configured redirect URL", () => {
    const globals = globalThis as { window?: unknown; document?: unknown };
    const originalWindow = globals.window;
    const originalDocument = globals.document;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: {
          href: "https://console.test/not-the-callback?code=a&state=b",
          origin: "https://console.test",
          pathname: "/not-the-callback",
          search: "?code=a&state=b",
        },
        sessionStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
      },
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { title: "Qualigence" },
    });
    try {
      const controller = new BrowserOidcController(
        { apiBaseUrl: "https://console.test/api", authMode: "oidc", oidc: makeConfig() },
        new MemoryTokenStore(),
        new FakeTransientStore(),
      );
      expect(controller.isCallback()).toBe(false);
    } finally {
      Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
      Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
    }
  });

  it("scrubs callback parameters even when callback validation fails", async () => {
    const globals = globalThis as { window?: unknown; document?: unknown };
    const originalWindow = globals.window;
    const originalDocument = globals.document;
    const replacements: string[] = [];
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: {
          href: "https://console.test/callback?code=secret-code&state=missing",
          origin: "https://console.test",
          pathname: "/callback",
          search: "?code=secret-code&state=missing",
        },
        history: {
          replaceState: (_state: unknown, _title: string, path: string) => replacements.push(path),
        },
        sessionStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
      },
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { title: "Qualigence" },
    });
    try {
      const controller = new BrowserOidcController(
        { apiBaseUrl: "https://console.test/api", authMode: "oidc", oidc: makeConfig() },
        new MemoryTokenStore(),
        new FakeTransientStore(),
      );
      await expect(controller.handleCallbackIfPresent()).rejects.toMatchObject({
        reason: "TransientMissing",
      });
      expect(replacements).toEqual(["/callback"]);
    } finally {
      Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
      Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
    }
  });

  it("consumes and scrubs an OIDC error callback", async () => {
    const globals = globalThis as { window?: unknown; document?: unknown };
    const originalWindow = globals.window;
    const originalDocument = globals.document;
    const transient = new FakeTransientStore();
    transient.set(
      "oidc.tx.denied-state",
      JSON.stringify({ state: "denied-state", nonce: "n", codeVerifier: "v", createdAtMs: Date.now() }),
    );
    const replacements: string[] = [];
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: {
          href: "https://console.test/callback?error=access_denied&state=denied-state",
          pathname: "/callback",
          search: "?error=access_denied&state=denied-state",
        },
        history: { replaceState: (_s: unknown, _t: string, path: string) => replacements.push(path) },
        sessionStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
      },
    });
    Object.defineProperty(globalThis, "document", { configurable: true, value: { title: "Q" } });
    try {
      const controller = new BrowserOidcController(
        { apiBaseUrl: "https://console.test/api", authMode: "oidc", oidc: makeConfig() },
        new MemoryTokenStore(),
        transient,
      );
      await expect(controller.handleCallbackIfPresent()).rejects.toMatchObject({
        reason: "AuthorizationFailed",
      });
      expect(transient.size()).toBe(0);
      expect(replacements).toEqual(["/callback"]);
    } finally {
      Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
      Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
    }
  });

  it("requires the configured static redirect query to match exactly", () => {
    const globals = globalThis as { window?: unknown; document?: unknown };
    const originalWindow = globals.window;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: {
          href: "https://console.test/callback?code=a&state=b",
          pathname: "/callback",
          search: "?code=a&state=b",
        },
        sessionStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
      },
    });
    try {
      const config = { ...makeConfig(), redirectUri: "https://console.test/callback?deployment=a" };
      const controller = new BrowserOidcController(
        { apiBaseUrl: "https://console.test/api", authMode: "oidc", oidc: config },
        new MemoryTokenStore(),
        new FakeTransientStore(),
      );
      expect(controller.isCallback()).toBe(false);
    } finally {
      Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
    }
  });
});

describe("Web Console runtime OIDC configuration", () => {
  const origin = "https://console.test";

  it("derives JWKS from the final injected issuer", () => {
    const config = resolveRuntimeConfig(
      { oidc: { issuer: "https://identity.example/" } },
      origin,
      {},
    );

    expect(config.oidc.issuer).toBe("https://identity.example/");
    expect(config.oidc.jwksUri).toBe("https://identity.example/.well-known/jwks.json");
  });

  it.each([
    [{ authMode: "unknown" }, /authMode/],
    [{ oidc: { tokenEndpoint: "http://identity.example/token" } }, /tokenEndpoint/],
    [{ oidc: { redirectUri: "https://attacker.example/callback" } }, /redirectUri/],
    [{ oidc: { allowedAlgorithms: ["HS256"] } }, /allowedAlgorithms/],
    [{ oidc: { allowedTenants: [] } }, /allowedTenants/],
    [{ oidc: { roleMap: { unknown: "owner" } } }, /roleMap/],
  ])("rejects unsafe injected runtime configuration %s", (injected, expected) => {
    expect(() => resolveRuntimeConfig(injected, origin, {})).toThrow(expected);
  });

  it("allows HTTP only for a loopback Local Console and API", () => {
    const config = resolveRuntimeConfig(
      { apiBaseUrl: "http://127.0.0.1:50555/api", oidc: { redirectUri: "http://127.0.0.1:5173/auth/callback" } },
      "http://127.0.0.1:5173",
      {},
    );
    expect(config.apiBaseUrl).toBe("http://127.0.0.1:50555/api");
  });

  it("rejects bootstrap mode outside loopback", () => {
    expect(() =>
      resolveRuntimeConfig({ authMode: "bootstrap" }, "https://console.example", {}),
    ).toThrow(/bootstrap/);
  });
});

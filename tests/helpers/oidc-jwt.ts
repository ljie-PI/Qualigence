import {
  createHash,
  createSign,
  generateKeyPairSync,
  randomBytes,
  timingSafeEqual,
  type KeyObject,
} from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { OidcAlgorithm, OidcSigningKey } from "@qualigence/oidc";

const execFileAsync = promisify(execFile);

export interface TestJwtIssuer {
  readonly kid: string;
  readonly alg: OidcAlgorithm;
  readonly signingKey: OidcSigningKey;
  readonly jwks: {
    readonly keys: readonly Readonly<Record<string, unknown>>[];
  };
  sign(claims: Readonly<Record<string, unknown>>, header?: Readonly<Record<string, unknown>>): string;
}

export interface TestOidcProvider {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
  readonly jwt: TestJwtIssuer;
  stop(): Promise<void>;
}

interface AuthorizationCode {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly nonce: string;
  readonly codeChallenge: string;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** Create a deterministic in-process JWT issuer for OIDC tests (RS256 or ES256). */
export function createTestJwtIssuer(
  alg: OidcAlgorithm = "RS256",
  kid = "test-key-1",
): TestJwtIssuer {
  const { privateKey, publicKey }: { privateKey: KeyObject; publicKey: KeyObject } =
    alg === "ES256"
      ? generateKeyPairSync("ec", { namedCurve: "P-256" })
      : generateKeyPairSync("rsa", { modulusLength: 2048 });

  const signingKey: OidcSigningKey = { kid, alg, publicKey };

  function sign(
    claims: Readonly<Record<string, unknown>>,
    header: Readonly<Record<string, unknown>> = {},
  ): string {
    const fullHeader = { alg, kid, typ: "JWT", ...header };
    const signingInput = `${base64url(JSON.stringify(fullHeader))}.${base64url(
      JSON.stringify(claims),
    )}`;
    const signer = createSign("SHA256");
    signer.update(signingInput);
    signer.end();
    const signature =
      alg === "ES256"
        ? signer.sign({ key: privateKey, dsaEncoding: "ieee-p1363" })
        : signer.sign(privateKey);
    return `${signingInput}.${base64url(signature)}`;
  }

  const jwk = publicKey.export({ format: "jwk" });
  const jwks = {
    keys: [{ ...jwk, kid, alg, use: "sig" }],
  };

  return { kid, alg, signingKey, jwks, sign };
}

/**
 * Real local HTTPS Authorization Code + PKCE provider used only by rendered
 * browser tests. It retains the authorization transaction server-side and
 * rejects changed redirect URIs, missing S256, bad code verifiers, and replayed
 * authorization codes. No access token is written to a browser storage API.
 */
export async function startTestOidcProvider(input: {
  readonly redirectUri: string;
  readonly clientId: string;
  readonly tenantId: string;
  readonly roles: readonly string[];
  readonly issueAccessToken: () => string;
  readonly jwt?: TestJwtIssuer;
}): Promise<TestOidcProvider> {
  const directory = await mkdtemp(join(tmpdir(), "qualigence-test-oidc-"));
  const keyPath = join(directory, "key.pem");
  const certPath = join(directory, "cert.pem");
  await execFileAsync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", keyPath, "-out", certPath, "-sha256", "-days", "1", "-nodes", "-subj", process.platform === "win32" ? "/CN=localhost" : "/CN=localhost"], { windowsHide: true });
  const [key, cert] = await Promise.all([readFile(keyPath), readFile(certPath)]);
  const jwt = input.jwt ?? createTestJwtIssuer();
  const codes = new Map<string, AuthorizationCode>();
  let server: Server | undefined;
  let issuer = "";

  server = createServer({ key, cert }, async (request, response) => {
    const url = new URL(request.url ?? "/", issuer);
    const cors = () => response.setHeader("access-control-allow-origin", new URL(input.redirectUri).origin);
    if (request.method === "GET" && url.pathname === "/.well-known/jwks.json") {
      cors();
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(jwt.jwks));
      return;
    }
    if (request.method === "GET" && url.pathname === "/authorize") {
      const clientId = url.searchParams.get("client_id");
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      const nonce = url.searchParams.get("nonce");
      const challenge = url.searchParams.get("code_challenge");
      const method = url.searchParams.get("code_challenge_method");
      if (url.searchParams.get("response_type") !== "code" || clientId !== input.clientId || redirectUri !== input.redirectUri || !state || !nonce || !challenge || method !== "S256") {
        response.writeHead(400).end("invalid authorization request");
        return;
      }
      const code = randomBytes(32).toString("base64url");
      codes.set(code, { clientId, redirectUri, nonce, codeChallenge: challenge });
      const callback = new URL(redirectUri);
      callback.searchParams.set("code", code);
      callback.searchParams.set("state", state);
      response.writeHead(302, { location: callback.toString(), "cache-control": "no-store" }).end();
      return;
    }
    if (request.method === "POST" && url.pathname === "/token") {
      cors();
      const body = await readRequestBody(request);
      const params = new URLSearchParams(body);
      const code = params.get("code") ?? "";
      const transaction = codes.get(code);
      const verifier = params.get("code_verifier") ?? "";
      const calculated = createHash("sha256").update(verifier).digest("base64url");
      const verifierMatches = calculated.length === (transaction?.codeChallenge.length ?? 0) && transaction !== undefined && timingSafeEqual(Buffer.from(calculated), Buffer.from(transaction.codeChallenge));
      if (params.get("grant_type") !== "authorization_code" || transaction === undefined || params.get("client_id") !== transaction.clientId || params.get("redirect_uri") !== transaction.redirectUri || !verifierMatches) {
        response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid_grant" }));
        return;
      }
      codes.delete(code);
      const now = Math.floor(Date.now() / 1000);
      const idToken = jwt.sign({ iss: issuer, aud: transaction.clientId, sub: "browser-tester", iat: now, nbf: now - 5, exp: now + 300, nonce: transaction.nonce, "https://qualigence.example/tenant": input.tenantId, "https://qualigence.example/roles": input.roles });
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify({ access_token: input.issueAccessToken(), id_token: idToken, token_type: "Bearer", expires_in: 300 }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  issuer = `https://localhost:${port}/`;
  return {
    issuer,
    authorizationEndpoint: `${issuer}authorize`,
    tokenEndpoint: `${issuer}token`,
    jwksUri: `${issuer}.well-known/jwks.json`,
    jwt,
    async stop() {
      await new Promise<void>((resolve, reject) => server!.close((error) => error === undefined ? resolve() : reject(error)));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function readRequestBody(request: import("node:http").IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) body += Buffer.from(chunk as Uint8Array).toString("utf8");
  return body;
}

/** Change a signed JWT payload while preserving its original signature bytes. */
export function tamperJwtPayload(
  token: string,
  mutate: (claims: Record<string, unknown>) => Record<string, unknown>,
): string {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("test JWT is not compact JWS");
  }
  const [header, payload, signature] = parts as [string, string, string];
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  return `${header}.${base64url(JSON.stringify(mutate(claims)))}.${signature}`;
}

/** Standard registered claims for a valid token, seconds-based exp/nbf. */
export function standardClaims(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return {
    iss: "https://oidc.example.test/",
    aud: "qualigence-self-hosted",
    sub: "user-123",
    iat: nowSeconds,
    nbf: nowSeconds - 5,
    exp: nowSeconds + 3600,
    ...overrides,
  };
}

import {
  createSign,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import type { OidcAlgorithm, OidcSigningKey } from "@qualigence/oidc";

export interface TestJwtIssuer {
  readonly kid: string;
  readonly alg: OidcAlgorithm;
  readonly signingKey: OidcSigningKey;
  sign(claims: Readonly<Record<string, unknown>>, header?: Readonly<Record<string, unknown>>): string;
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

  return { kid, alg, signingKey, sign };
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

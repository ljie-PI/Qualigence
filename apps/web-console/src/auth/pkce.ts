/**
 * Pure, isomorphic PKCE + OIDC nonce/state primitives. No `window`, `location`,
 * `localStorage` or React — only Web Crypto, which exists in both the browser
 * and the Node test runtime — so this logic is unit-testable without a DOM. The
 * browser wiring lives in `browser-oidc.ts`; everything security-sensitive
 * (unpredictable values, S256 challenge) is here and covered by tests.
 */

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Cryptographically-random URL-safe token of `byteLength` entropy bytes. */
export function randomUrlToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/** The three transient, per-authorization secrets validated on callback. */
export interface PkceMaterial {
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: "S256";
}

/** Generate fresh, independent `state`, `nonce` and PKCE S256 material. */
export async function createPkceMaterial(): Promise<PkceMaterial> {
  const state = randomUrlToken();
  const nonce = randomUrlToken();
  const codeVerifier = randomUrlToken(48);
  const codeChallenge = await computeS256Challenge(codeVerifier);
  return { state, nonce, codeVerifier, codeChallenge, codeChallengeMethod: "S256" };
}

/** SHA-256 → base64url of the verifier: the S256 `code_challenge`. */
export async function computeS256Challenge(codeVerifier: string): Promise<string> {
  const data = new TextEncoder().encode(codeVerifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(digest));
}

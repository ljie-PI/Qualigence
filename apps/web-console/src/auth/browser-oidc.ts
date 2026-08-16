import { MemoryTokenStore } from "./memory-token-store.js";
import { OidcSession, type TransientStore } from "./oidc-session.js";
import { RemoteJwksIdTokenVerifier } from "./id-token-verifier.js";
import type { ConsoleRuntimeConfig } from "../config.js";

const TTL_MS = 10 * 60 * 1000;

/**
 * Transient store backed by the browser's `sessionStorage`, used ONLY for the
 * short-lived `state`/`nonce`/`code_verifier` record between the authorization
 * redirect and the callback. Every entry is stamped with a TTL and expired
 * entries are dropped on read. The access token is NEVER routed here — it lives
 * exclusively in {@link MemoryTokenStore}.
 */
export class SessionStorageTransientStore implements TransientStore {
  set(key: string, value: string): void {
    window.sessionStorage.setItem(key, JSON.stringify({ value, storedAtMs: Date.now() }));
  }

  get(key: string): string | undefined {
    const raw = window.sessionStorage.getItem(key);
    if (raw === null) {
      return undefined;
    }
    try {
      const { value, storedAtMs } = JSON.parse(raw) as { value: string; storedAtMs: number };
      if (Date.now() - storedAtMs > TTL_MS) {
        window.sessionStorage.removeItem(key);
        return undefined;
      }
      return value;
    } catch {
      window.sessionStorage.removeItem(key);
      return undefined;
    }
  }

  remove(key: string): void {
    window.sessionStorage.removeItem(key);
  }
}

/**
 * Browser controller wiring {@link OidcSession} to real `window`/`location`.
 * `beginLogin` redirects to the IdP; `handleCallbackIfPresent` completes the
 * exchange when the app boots on the redirect URI, installs the session into the
 * in-memory store and scrubs the authorization `code`/`state` from the URL so
 * they never linger in history or proxy logs.
 */
export class BrowserOidcController {
  private readonly session: OidcSession;

  constructor(
    private readonly config: ConsoleRuntimeConfig,
    private readonly tokens: MemoryTokenStore,
    private readonly transient: TransientStore = new SessionStorageTransientStore(),
  ) {
    const verifier = new RemoteJwksIdTokenVerifier({
      jwksUri: config.oidc.jwksUri,
      allowedAlgorithms: config.oidc.allowedAlgorithms,
    });
    this.session = new OidcSession(config.oidc, transient, verifier);
  }

  async beginLogin(): Promise<void> {
    const { authorizationUrl } = await this.session.beginAuthorization();
    window.location.assign(authorizationUrl);
  }

  isCallback(): boolean {
    const params = new URLSearchParams(window.location.search);
    return params.has("code") && params.has("state");
  }

  async handleCallbackIfPresent(): Promise<boolean> {
    if (!this.isCallback()) {
      return false;
    }
    const params = new URLSearchParams(window.location.search);
    const consoleSession = await this.session.completeAuthorization({
      code: params.get("code") as string,
      state: params.get("state") as string,
    });
    this.tokens.set(consoleSession);
    // Scrub the sensitive code/state from the address bar and history.
    window.history.replaceState({}, document.title, window.location.pathname);
    return true;
  }

  logout(): void {
    this.tokens.clear();
  }
}

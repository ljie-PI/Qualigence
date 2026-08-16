import { MemoryTokenStore } from "./memory-token-store.js";
import { OidcSession, type TransientStore } from "./oidc-session.js";
import { RemoteJwksIdTokenVerifier } from "./id-token-verifier.js";
import type { ConsoleRuntimeConfig } from "../config.js";

const TTL_MS = 10 * 60 * 1000;

interface BrowserRuntime {
  readonly location: {
    readonly href: string;
    readonly pathname: string;
    readonly search: string;
    assign(url: string): void;
  };
  readonly history: {
    replaceState(state: unknown, title: string, url: string): void;
  };
  readonly sessionStorage: {
    setItem(key: string, value: string): void;
    getItem(key: string): string | null;
    removeItem(key: string): void;
  };
}

function browser(): BrowserRuntime {
  const runtime = (globalThis as { readonly window?: BrowserRuntime }).window;
  if (runtime === undefined) {
    throw new Error("Browser runtime is unavailable");
  }
  return runtime;
}

function documentTitle(): string {
  return (globalThis as { readonly document?: { readonly title: string } }).document?.title ?? "";
}

/**
 * Transient store backed by the browser's `sessionStorage`, used ONLY for the
 * short-lived `state`/`nonce`/`code_verifier` record between the authorization
 * redirect and the callback. Every entry is stamped with a TTL and expired
 * entries are dropped on read. The access token is NEVER routed here — it lives
 * exclusively in {@link MemoryTokenStore}.
 */
export class SessionStorageTransientStore implements TransientStore {
  set(key: string, value: string): void {
    browser().sessionStorage.setItem(key, JSON.stringify({ value, storedAtMs: Date.now() }));
  }

  get(key: string): string | undefined {
    const storage = browser().sessionStorage;
    const raw = storage.getItem(key);
    if (raw === null) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (
        typeof parsed !== "object" || parsed === null ||
        typeof (parsed as { value?: unknown }).value !== "string" ||
        typeof (parsed as { storedAtMs?: unknown }).storedAtMs !== "number" ||
        !Number.isFinite((parsed as { storedAtMs: number }).storedAtMs)
      ) {
        storage.removeItem(key);
        return undefined;
      }
      const { value, storedAtMs } = parsed as { value: string; storedAtMs: number };
      if (Date.now() - storedAtMs > TTL_MS) {
        storage.removeItem(key);
        return undefined;
      }
      return value;
    } catch {
      storage.removeItem(key);
      return undefined;
    }
  }

  remove(key: string): void {
    browser().sessionStorage.removeItem(key);
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
    browser().location.assign(authorizationUrl);
  }

  isCallback(): boolean {
    const runtime = browser();
    const current = new URL(runtime.location.href);
    const redirect = new URL(this.config.oidc.redirectUri);
    if (current.origin !== redirect.origin || current.pathname !== redirect.pathname) {
      return false;
    }
    const params = new URLSearchParams(runtime.location.search);
    return params.has("code") && params.has("state");
  }

  async handleCallbackIfPresent(): Promise<boolean> {
    if (!this.isCallback()) {
      return false;
    }
    const runtime = browser();
    const params = new URLSearchParams(runtime.location.search);
    try {
      const consoleSession = await this.session.completeAuthorization({
        code: params.get("code") as string,
        state: params.get("state") as string,
      });
      this.tokens.set(consoleSession);
      return true;
    } finally {
      // Scrub sensitive callback values even when validation fails.
      runtime.history.replaceState({}, documentTitle(), runtime.location.pathname);
    }
  }

  logout(): void {
    this.tokens.clear();
  }
}

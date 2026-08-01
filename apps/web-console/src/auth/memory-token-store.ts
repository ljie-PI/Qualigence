import type { PublicApiRole } from "@qualigence/public-api";

/** The authenticated user derived from a validated OIDC id/access token. */
export interface ConsoleSession {
  readonly subject: string;
  readonly tenantId: string;
  readonly roles: readonly PublicApiRole[];
  readonly accessToken: string;
  /** Epoch millis when the access token expires; used to gate silent refresh. */
  readonly expiresAtMs: number;
}

/**
 * The authenticated access token lives ONLY here, in a module-private field on
 * the heap. It is never written to any browser web-storage API or a
 * document cookie, so a successful XSS cannot exfiltrate a durable token and a
 * page reload requires a fresh Authorization Code exchange. Mirrors the
 * design's "access token only in memory, never persisted" rule.
 */
export class MemoryTokenStore {
  private session: ConsoleSession | undefined;
  private readonly subscribers = new Set<() => void>();

  get(): ConsoleSession | undefined {
    return this.session;
  }

  /** The raw bearer token for the API client, or `undefined` when logged out. */
  accessToken(): string | undefined {
    return this.session?.accessToken;
  }

  isAuthenticated(): boolean {
    return this.session !== undefined;
  }

  set(session: ConsoleSession): void {
    this.session = session;
    this.emit();
  }

  clear(): void {
    this.session = undefined;
    this.emit();
  }

  /** Subscribe to session changes (used by the React session context). */
  subscribe(listener: () => void): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of this.subscribers) {
      listener();
    }
  }
}

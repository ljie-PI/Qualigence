import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { decodeBootstrapCredential, encodeBootstrapCredential } from "@qualigence/local-control";

export class LocalAuthorizationError extends Error {
  readonly code = "Unauthorized" as const;
  constructor() { super("Unauthorized"); this.name = "LocalAuthorizationError"; }
}

export interface LocalSessionServiceOptions {
  readonly userBootstrap: Uint8Array;
  readonly supervisor: Uint8Array;
  readonly userBootstrapExpiresAtEpochMs: number;
  readonly userSessionTtlMs: number;
  readonly now?: () => number;
  readonly randomBytes?: () => Buffer;
}

export class LocalSessionService {
  private readonly bootstrapHash: Buffer;
  private readonly supervisorHash: Buffer;
  private readonly sessions = new Map<string, number>();
  private readonly now: () => number;
  private readonly generate: () => Buffer;
  private bootstrapConsumed = false;
  private supervisorConsumed = false;
  private quiesced = false;

  constructor(private readonly options: LocalSessionServiceOptions) {
    this.bootstrapHash = digest(options.userBootstrap);
    this.supervisorHash = digest(options.supervisor);
    this.now = options.now ?? Date.now;
    this.generate = options.randomBytes ?? (() => randomBytes(32));
  }

  exchangeBootstrap(presented: string): { readonly sessionToken: string; readonly expiresAt: string } {
    const createdAt = this.now();
    if (this.quiesced || this.bootstrapConsumed || this.options.userBootstrapExpiresAtEpochMs <= createdAt) throw new LocalAuthorizationError();
    const hash = presentedHash(presented);
    if (hash === undefined || !timingSafeEqual(hash, this.bootstrapHash)) throw new LocalAuthorizationError();
    this.bootstrapConsumed = true;
    const expiresAtMs = createdAt + this.options.userSessionTtlMs;
    if (!Number.isSafeInteger(expiresAtMs)) throw new LocalAuthorizationError();
    const raw = this.generate();
    try {
      const token = encodeBootstrapCredential(raw);
      this.sessions.set(digest(raw).toString("hex"), expiresAtMs);
      return { sessionToken: token, expiresAt: new Date(expiresAtMs).toISOString() };
    } finally { raw.fill(0); }
  }

  authorizeUser(presented: string): boolean {
    if (this.quiesced) return false;
    const hash = presentedHash(presented);
    if (hash === undefined) return false;
    const expiresAt = this.sessions.get(hash.toString("hex"));
    return expiresAt !== undefined && expiresAt > this.now();
  }

  authorizeSupervisor(presented: string): boolean {
    if (this.supervisorConsumed) return false;
    const hash = presentedHash(presented);
    if (hash === undefined || !timingSafeEqual(hash, this.supervisorHash)) return false;
    this.supervisorConsumed = true;
    this.quiesced = true;
    return true;
  }
}

function digest(bytes: Uint8Array): Buffer { return createHash("sha256").update(bytes).digest(); }
function presentedHash(text: string): Buffer | undefined { let raw: Buffer; try { raw = decodeBootstrapCredential(text); } catch { return undefined; } try { return digest(raw); } finally { raw.fill(0); } }

import { createHash, randomBytes } from "node:crypto";
import type {
  ResumePresentedIdentity,
  ResumeTokenBinding,
  RunnerControlStore,
} from "@qualigence/runner-control";
import { CoreApplicationError } from "./core-runner-protocol-application.js";

export type { ResumePresentedIdentity, ResumeTokenBinding };

export interface RunnerResumeTokenServiceOptions {
  readonly store: RunnerControlStore;
  readonly ttlMs?: number;
  readonly now?: () => number;
  readonly generateToken?: () => string;
}

export interface ResumeRedemption {
  readonly binding: ResumeTokenBinding;
  /** The next single-use resume credential, derived deterministically. */
  readonly resumeToken: string;
}

const DEFAULT_RESUME_TTL_MS = 5 * 60 * 1000;

/** Domain-separated derivation of the rotated replacement credential. */
const ROTATION_DERIVATION_PREFIX = "qualigence:resume-rotation:v1:";

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Issues and redeems the short-lived, single-use resume credentials described in
 * the LS-05 design §7. Only the token hash is stored; each token is bound to the
 * Runner certificate fingerprint, runnerId, previous sessionId and protocol
 * major and expires after a bounded TTL. Redemption atomically persists the
 * replacement credential alongside the consume, so a redemption that crashed
 * between the consume and the Welcome reply is replayed deterministically: the
 * replacement is derived from the presented credential, which the Runner
 * legitimately holds, and never depends on process memory.
 */
export class RunnerResumeTokenService {
  private readonly store: RunnerControlStore;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly generateToken: () => string;

  constructor(options: RunnerResumeTokenServiceOptions) {
    this.store = options.store;
    this.ttlMs = options.ttlMs ?? DEFAULT_RESUME_TTL_MS;
    this.now = options.now ?? ((): number => Date.now());
    this.generateToken = options.generateToken ?? ((): string => randomBytes(32).toString("base64url"));
  }

  async issue(binding: ResumeTokenBinding): Promise<string> {
    const token = this.generateToken();
    await this.store.issueResumeToken({
      tokenHash: hashToken(token),
      binding,
      expiresAt: new Date(this.now() + this.ttlMs).toISOString(),
    });
    return token;
  }

  /**
   * Redeem a resume token for a fresh session and produce its replacement
   * credential. Throws {@link CoreApplicationError} `RunnerResumeRejected` when
   * the token is unknown, expired, already consumed without a stored
   * replacement, or presented by a different Runner identity/protocol major.
   * A replay of an already-rotated token (a crashed redemption) returns the
   * identical replacement credential instead of a second consume, so the
   * reconnect handshake is idempotent.
   */
  async redeem(token: string, presented: ResumePresentedIdentity): Promise<ResumeRedemption> {
    const replacementToken = this.deriveReplacementToken(token);
    const result = await this.store.rotateResumeToken({
      presentedTokenHash: hashToken(token),
      replacementTokenHash: hashToken(replacementToken),
      replacementExpiresAt: new Date(this.now() + this.ttlMs).toISOString(),
      presented,
      rotatedAt: new Date(this.now()).toISOString(),
    });
    if (result === undefined) {
      throw new CoreApplicationError("RunnerResumeRejected", "unknown, expired, or already-consumed resume token");
    }
    return { binding: result.binding, resumeToken: replacementToken };
  }

  private deriveReplacementToken(presentedToken: string): string {
    return createHash("sha256")
      .update(ROTATION_DERIVATION_PREFIX + presentedToken, "utf8")
      .digest("base64url");
  }
}
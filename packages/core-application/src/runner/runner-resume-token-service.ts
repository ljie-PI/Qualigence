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

const DEFAULT_RESUME_TTL_MS = 5 * 60 * 1000;

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Issues and redeems the short-lived, single-use resume credentials described in
 * the LS-05 design §7. Only the token hash is stored; each token is bound to the
 * Runner certificate fingerprint, runnerId, previous sessionId and protocol
 * major and expires after a bounded TTL. Redemption is atomic and single-use, so
 * a token can never be replayed after rotation and can never be redeemed by a
 * different Runner identity.
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
   * Redeem a resume token. Throws {@link CoreApplicationError} `RunnerResumeRejected`
   * when the token is unknown, already consumed, expired, or presented by a
   * different Runner identity/protocol major. The token is consumed whether or
   * not the binding matches, so a leaked token cannot be probed repeatedly.
   */
  async use(token: string, presented: ResumePresentedIdentity): Promise<ResumeTokenBinding> {
    const binding = await this.store.consumeResumeToken({
      tokenHash: hashToken(token),
      presented,
      consumedAt: new Date(this.now()).toISOString(),
    });
    if (binding === undefined) {
      throw new CoreApplicationError("RunnerResumeRejected", "unknown, expired, or already-consumed resume token");
    }
    return binding;
  }
}

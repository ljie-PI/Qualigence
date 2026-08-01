import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { CoreDaemonError } from "../errors.js";

/**
 * The identity and protocol context a resume credential is bound to when it is
 * issued. A token can only ever be redeemed by presenting the exact same Runner
 * certificate identity and protocol major it was issued against.
 */
export interface ResumeTokenBinding {
  readonly runnerId: string;
  readonly certificateFingerprint: string;
  readonly previousSessionId: string;
  readonly protocolMajor: number;
}

/**
 * The identity a Runner presents on reconnect. It never carries the previous
 * session id; that is looked up from the stored record so a peer cannot spoof it.
 */
export interface ResumePresentedIdentity {
  readonly runnerId: string;
  readonly certificateFingerprint: string;
  readonly protocolMajor: number;
}

export interface RunnerResumeTokenServiceOptions {
  /** Time-to-live for a freshly issued resume token, in milliseconds. */
  readonly ttlMs?: number;
  readonly now?: () => number;
  readonly generateToken?: () => string;
}

interface StoredResumeRecord {
  readonly binding: ResumeTokenBinding;
  readonly expiresAtMs: number;
}

const DEFAULT_RESUME_TTL_MS = 5 * 60 * 1000;

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function constantTimeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
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
  private readonly records = new Map<string, StoredResumeRecord>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly generateToken: () => string;

  constructor(options: RunnerResumeTokenServiceOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_RESUME_TTL_MS;
    this.now = options.now ?? ((): number => Date.now());
    this.generateToken = options.generateToken ?? ((): string => randomBytes(32).toString("base64url"));
  }

  issue(binding: ResumeTokenBinding): string {
    const token = this.generateToken();
    this.records.set(hashToken(token), {
      binding,
      expiresAtMs: this.now() + this.ttlMs,
    });
    return token;
  }

  /**
   * Redeem a resume token. Throws {@link CoreDaemonError} `RunnerResumeRejected`
   * when the token is unknown, already consumed, expired, or presented by a
   * different Runner identity/protocol major. The token is consumed whether or
   * not the binding matches, so a leaked token cannot be probed repeatedly.
   */
  use(token: string, presented: ResumePresentedIdentity): ResumeTokenBinding {
    const hash = hashToken(token);
    const record = this.records.get(hash);
    this.records.delete(hash);
    if (record === undefined) {
      throw new CoreDaemonError("RunnerResumeRejected", "unknown or already-consumed resume token");
    }
    if (record.expiresAtMs <= this.now()) {
      throw new CoreDaemonError("RunnerResumeRejected", "resume token has expired");
    }
    if (
      !constantTimeEquals(record.binding.runnerId, presented.runnerId) ||
      !constantTimeEquals(record.binding.certificateFingerprint, presented.certificateFingerprint) ||
      record.binding.protocolMajor !== presented.protocolMajor
    ) {
      throw new CoreDaemonError("RunnerResumeRejected", "resume token identity binding does not match");
    }
    return record.binding;
  }
}

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Identity a resume token is bound to. A token is only ever accepted from the
 * same Runner (certificate identity) that was issued it.
 */
export interface ResumeBinding {
  readonly runnerId: string;
  readonly certificateFingerprint: string;
}

export interface ResumeRecord extends ResumeBinding {
  readonly previousSessionId: string;
}

/**
 * Issues and validates single-use resume credentials. The server persists only
 * the token hash (never the plaintext), binds each token to the Runner identity
 * that received it, and consumes it atomically on a successful resume so a token
 * can never be replayed.
 */
export interface ResumeTokenStore {
  issue(record: ResumeRecord): string;
  consume(token: string, binding: ResumeBinding): ResumeRecord | undefined;
}

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

export class InMemoryResumeTokenStore implements ResumeTokenStore {
  private readonly records = new Map<string, ResumeRecord>();

  issue(record: ResumeRecord): string {
    const token = randomBytes(32).toString("base64url");
    this.records.set(hashToken(token), record);
    return token;
  }

  consume(token: string, binding: ResumeBinding): ResumeRecord | undefined {
    const hash = hashToken(token);
    const record = this.records.get(hash);
    if (record === undefined) {
      return undefined;
    }
    // Single use: the token is invalidated whether or not the binding matches, so
    // a leaked token cannot be probed repeatedly.
    this.records.delete(hash);
    if (
      !constantTimeEquals(record.runnerId, binding.runnerId) ||
      !constantTimeEquals(record.certificateFingerprint, binding.certificateFingerprint)
    ) {
      return undefined;
    }
    return record;
  }
}

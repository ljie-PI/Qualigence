import type { SignedSkillBundle, UnsignedSkillBundle } from "../domain/skill-bundle.js";

/** The scope a Bundle is being verified for — used to reject cross-project reuse. */
export interface SkillVerificationScope {
  readonly projectId: string;
  readonly targetId: string;
  readonly origin?: string;
  readonly now?: string;
}

export type SkillSignatureVerification =
  | { readonly status: "valid" }
  | {
      readonly status: "invalid";
      readonly code:
        | "SkillSignatureInvalid"
        | "SkillTargetMismatch"
        | "SkillBundleExpired"
        | "SkillContentTampered";
      readonly message: string;
    };

export class SkillSigningError extends Error {
  readonly code: "SkillSigningFailed";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SkillSigningError";
    this.code = "SkillSigningFailed";
  }
}

/**
 * A local signing service. Signing uses a real Ed25519 private key; a signing
 * failure surfaces `SkillSigningFailed` and there is never an unsigned fallback.
 */
export interface SkillSigner {
  readonly keyId: string;
  sign(bundle: UnsignedSkillBundle): Promise<SignedSkillBundle>;
  verify(
    bundle: SignedSkillBundle,
    scope: SkillVerificationScope,
  ): Promise<SkillSignatureVerification>;
}

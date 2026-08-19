/**
 * Provider-neutral local configuration contract. The Launcher consumes this
 * shape; concrete loading, merging and validation live in the app. Secret
 * material never appears here: {@link LocalConfig.modelProfile.credentialRef}
 * is a reference resolved at runtime by a {@link SecretProvider}, and TLS keys
 * are referenced by path, not embedded.
 */

export type VisualInputMode = "disabled" | "on-demand";

export interface LocalConfig {
  readonly dataDir: string;
  readonly core: {
    readonly host: "127.0.0.1";
    readonly port: number;
    readonly httpPort?: number;
  };
  readonly runner: {
    readonly id: string;
    readonly spoolSoftBytes: number;
    readonly spoolHardBytes: number;
  };
  readonly modelProfile: {
    readonly provider: "openai-compatible";
    readonly baseUrl: string;
    readonly model: string;
    readonly credentialRef: string;
    readonly visualInput: VisualInputMode;
  };
  readonly auth: {
    readonly bootstrapTtlMs: number;
    readonly userSessionTtlMs: number;
  };
  readonly completionReconciliationRetryBaseMs: number;
  readonly completionReconciliationRetryMaximumMs: number;
  readonly completionReconciliationMaximumAttempts: number;
  readonly completionReconciliationPollIntervalMs: number;
  readonly completionReconciliationBatchSize: number;
  readonly shutdown: {
    readonly stopRequestPollIntervalMs: number;
    readonly stopRequestMaximumAgeMs: number;
    readonly stopRequestWaitTimeoutMs: number;
    readonly drainTimeoutMs: number;
  };
}

/** Resolves a `credentialRef` to a live secret value at the last moment. */
export interface ResolvedSecret {
  readonly value: string;
  readonly expiresAt?: string;
}

export interface SecretProvider {
  resolve(credentialRef: string): Promise<ResolvedSecret>;
}

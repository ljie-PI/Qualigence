import type { RunnerConnectionPort } from "@qualigence/grpc-runner-protocol";
import { WEB_OBSERVATION_V1_CAPABILITY_TOKENS } from "@qualigence/runner-protocol";

export class LocalReadinessService {
  private quiesced = false;
  constructor(private readonly options: {
    readonly schemaVersion: () => Promise<number>;
    readonly storageProbe: () => Promise<void>;
    readonly artifactProbe: () => Promise<void>;
    readonly listeners: () => { readonly http: boolean; readonly grpc: boolean };
    readonly reconciliationHealthy: () => boolean;
    readonly configuredRunnerId: string;
    readonly connection: () => RunnerConnectionPort | undefined;
  }) {}
  live(): boolean { return true; }
  async internalReady(): Promise<boolean> {
    if (this.quiesced || !this.options.reconciliationHealthy()) return false;
    const listeners = this.options.listeners(); if (!listeners.http || !listeners.grpc || await this.options.schemaVersion() !== 7) return false;
    try { await this.options.storageProbe(); await this.options.artifactProbe(); return true; } catch { return false; }
  }
  async ready(): Promise<boolean> {
    if (!await this.internalReady()) return false;
    const runner = this.options.connection()?.authenticatedRunner;
    if (runner?.runnerId !== this.options.configuredRunnerId || runner.scope.kind !== "local") return false;
    const capabilities = new Set(runner.capabilities);
    return capabilities.has("target:web-playwright") &&
      WEB_OBSERVATION_V1_CAPABILITY_TOKENS.every((token) => capabilities.has(token));
  }
  quiesce(): void { this.quiesced = true; }
}

import { createHash } from "node:crypto";
import type { ExecutionPolicySnapshot } from "@qualigence/runner-protocol";

export class LocalRunPolicyIssuer {
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly issuerVersion: string;
  constructor(options: { readonly now?: () => number; readonly ttlMs?: number; readonly issuerVersion?: string } = {}) {
    this.now = options.now ?? Date.now; this.ttlMs = options.ttlMs ?? 60_000; this.issuerVersion = options.issuerVersion ?? "v1";
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs <= 0) throw new Error("Invalid Local policy TTL.");
  }
  issue(target: { readonly kind: "web"; readonly url: string }): { readonly projectId: "local"; readonly policy: ExecutionPolicySnapshot } {
    const url = new URL(target.url);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "") throw new Error("Invalid Local target URL.");
    const issuedMs = this.now(); const expiresMs = issuedMs + this.ttlMs;
    if (!Number.isSafeInteger(expiresMs)) throw new Error("Local policy expiry overflow.");
    const body = { environment: "isolated_test" as const, allowedOrigins: [url.origin], allowedActionKinds: ["click"] as const, maximumRisk: "Normal" as const, explorationAllowed: false, issuedAt: new Date(issuedMs).toISOString(), expiresAt: new Date(expiresMs).toISOString() };
    const policyId = createHash("sha256").update(JSON.stringify({ issuerVersion: this.issuerVersion, ...body })).digest("hex");
    return { projectId: "local", policy: Object.freeze({ policyId, ...body }) };
  }
}

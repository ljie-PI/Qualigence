import { randomBytes } from "node:crypto";
import { encodeBootstrapFrame } from "@qualigence/local-control";

export interface LauncherBootstrapCredentials {
  readonly userBootstrap: Buffer;
  readonly supervisor: Buffer;
  readonly createdAtEpochMs: number;
  readonly userExpiresAtEpochMs: number;
  frame(): Buffer;
  destroy(): void;
}

export function createBootstrapCredentialHandoff(input: { readonly bootstrapTtlMs: number; readonly now?: () => number; readonly random?: (size: number) => Buffer }): LauncherBootstrapCredentials {
  const now = input.now ?? Date.now;
  const random = input.random ?? randomBytes;
  const createdAtEpochMs = now();
  const userExpiresAtEpochMs = createdAtEpochMs + input.bootstrapTtlMs;
  if (!Number.isSafeInteger(createdAtEpochMs) || createdAtEpochMs < 0 || !Number.isSafeInteger(userExpiresAtEpochMs) || createdAtEpochMs >= userExpiresAtEpochMs) throw new Error("Bootstrap credential timestamp is invalid.");
  const userBootstrap = random(32); const supervisor = random(32);
  return {
    userBootstrap, supervisor, createdAtEpochMs, userExpiresAtEpochMs,
    frame: () => encodeBootstrapFrame({ userBootstrap, supervisor, createdAtEpochMs, userExpiresAtEpochMs }),
    destroy: () => { userBootstrap.fill(0); supervisor.fill(0); },
  };
}

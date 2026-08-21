import { createHash } from "node:crypto";
import { validateAppTarget, type AppTarget } from "@qualigence/desktop-contracts";
import { ProjectTargetError } from "./app-target.js";

export interface WebTargetConfiguration {
  readonly kind: "web";
  readonly startUrl: string;
  readonly allowedOrigins: readonly string[];
  readonly browser: "chromium";
  readonly authenticationProfileId?: string;
}

export interface DesktopTargetConfiguration {
  readonly kind: "desktop";
  readonly app: AppTarget;
}

export type TargetConfiguration =
  | WebTargetConfiguration
  | DesktopTargetConfiguration;

export interface TargetRevision {
  readonly targetId: string;
  readonly projectId: string;
  readonly displayName: string;
  readonly runnerId: string;
  readonly version: number;
  readonly snapshotHash: string;
  readonly configuration: TargetConfiguration;
}

export interface CreateTargetRevisionInput {
  readonly targetId: string;
  readonly projectId: string;
  readonly displayName: string;
  readonly runnerId: string;
  readonly expectedVersion: number;
  readonly configuration: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProjectTargetError("InvalidTargetConfiguration", `${field} is required`);
  }
  return value.trim();
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function deepFreeze(value: unknown): void {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) deepFreeze(child);
  Object.freeze(value);
}

function validateWebTarget(value: Record<string, unknown>): WebTargetConfiguration {
  const startUrl = requiredString(value.startUrl, "configuration.startUrl");
  let parsed: URL;
  try {
    parsed = new URL(startUrl);
  } catch {
    throw new ProjectTargetError("InvalidTargetConfiguration", "startUrl must be an absolute URL");
  }
  if (parsed.protocol !== "https:" || parsed.username.length > 0 || parsed.password.length > 0) {
    throw new ProjectTargetError("TargetSecretRejected", "startUrl must be HTTPS and contain no credentials");
  }
  if (!Array.isArray(value.allowedOrigins) || value.allowedOrigins.length === 0) {
    throw new ProjectTargetError("InvalidTargetConfiguration", "allowedOrigins is required");
  }
  const allowedOrigins = value.allowedOrigins.map((entry) => {
    const origin = requiredString(entry, "configuration.allowedOrigins");
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new ProjectTargetError("InvalidTargetConfiguration", "allowedOrigins must contain absolute URLs");
    }
    if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password) {
      throw new ProjectTargetError("TargetSecretRejected", "allowedOrigins must be credential-free HTTPS origins");
    }
    return origin;
  });
  if (value.browser !== "chromium") {
    throw new ProjectTargetError("InvalidTargetConfiguration", "browser must be chromium");
  }
  const authenticationProfileId = value.authenticationProfileId === undefined
    ? undefined
    : requiredString(value.authenticationProfileId, "configuration.authenticationProfileId");
  return Object.freeze({
    kind: "web",
    startUrl: parsed.toString(),
    allowedOrigins: Object.freeze(allowedOrigins),
    browser: "chromium",
    ...(authenticationProfileId === undefined ? {} : { authenticationProfileId }),
  });
}

export function createTargetRevision(input: CreateTargetRevisionInput): TargetRevision {
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new ProjectTargetError("InvalidTargetConfiguration", "expectedVersion must be a non-negative integer");
  }
  const targetId = requiredString(input.targetId, "targetId");
  const projectId = requiredString(input.projectId, "projectId");
  const displayName = requiredString(input.displayName, "displayName");
  const runnerId = requiredString(input.runnerId, "runnerId");
  if (!isRecord(input.configuration)) {
    throw new ProjectTargetError("InvalidTargetConfiguration", "configuration must be an object");
  }

  let configuration: TargetConfiguration;
  if (input.configuration.kind === "web") {
    configuration = validateWebTarget(input.configuration);
  } else if (input.configuration.kind === "desktop") {
    try {
      const app = validateAppTarget(input.configuration.app);
      if (app.targetId !== targetId) {
        throw new ProjectTargetError("InvalidTargetConfiguration", "Desktop app targetId must match the Target revision");
      }
      deepFreeze(app);
      configuration = Object.freeze({ kind: "desktop", app });
    } catch (error) {
      if (error instanceof ProjectTargetError) throw error;
      throw new ProjectTargetError(
        "InvalidTargetConfiguration",
        error instanceof Error ? error.message : "invalid Desktop Target",
      );
    }
  } else {
    throw new ProjectTargetError("InvalidTargetConfiguration", "kind must be web or desktop");
  }

  const snapshot = {
    targetId,
    projectId,
    displayName,
    runnerId,
    version: input.expectedVersion + 1,
    configuration,
  };
  return Object.freeze({
    ...snapshot,
    snapshotHash: createHash("sha256").update(canonicalJson(snapshot), "utf8").digest("hex"),
  });
}

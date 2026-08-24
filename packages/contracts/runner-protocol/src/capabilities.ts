/**
 * Runner capability advertisement and negotiation for runner-protocol v1.
 *
 * Capabilities are declared by a Runner in its {@link RunnerHello} and are
 * negotiated against the requirements attached to an execution Offer. Negotiation
 * is deliberately strict: an unmet requirement produces an explicit
 * {@link CapabilityMismatch}, never a silent downgrade to a reduced feature set.
 */

export type RunnerOperatingSystem = "windows" | "macos" | "linux";
export type RunnerArchitecture = "x64" | "arm64";

export interface RunnerModelCapabilities {
  readonly structuredOutput: boolean;
  readonly visionInput: boolean;
}

export interface RunnerCapabilities {
  readonly operatingSystem: RunnerOperatingSystem;
  readonly architecture: RunnerArchitecture;
  readonly targetAdapters: readonly string[];
  readonly observationExtensions: readonly string[];
  readonly actionKinds: readonly string[];
  readonly model: RunnerModelCapabilities;
  readonly maximumArtifactBytes: number;
}

export const DEFAULT_MAXIMUM_ARTIFACT_BYTES = 8 * 1024 * 1024;
export const OBSERVATION_GRAPH_V1_CAPABILITY = "observation-graph/v1" as const;
export const WEB_OBSERVATION_EXTENSION_V1_CAPABILITY = "web/v1" as const;
export const OBSERVATION_GRAPH_V1_CAPABILITY_TOKEN =
  `observation:${OBSERVATION_GRAPH_V1_CAPABILITY}` as const;
export const WEB_OBSERVATION_EXTENSION_V1_CAPABILITY_TOKEN =
  `observation:${WEB_OBSERVATION_EXTENSION_V1_CAPABILITY}` as const;

export interface RunnerCapabilitiesOverride {
  readonly operatingSystem?: RunnerOperatingSystem;
  readonly architecture?: RunnerArchitecture;
  readonly targetAdapters?: readonly string[];
  readonly observationExtensions?: readonly string[];
  readonly actionKinds?: readonly string[];
  readonly model?: Partial<RunnerModelCapabilities>;
  readonly maximumArtifactBytes?: number;
}

/**
 * Build a fully populated {@link RunnerCapabilities} from a partial override.
 * Defaults describe the M1 local Linux Runner; callers layer on the adapters,
 * extensions and action kinds they actually support.
 */
export function capabilities(override: RunnerCapabilitiesOverride = {}): RunnerCapabilities {
  return {
    operatingSystem: override.operatingSystem ?? "linux",
    architecture: override.architecture ?? "x64",
    targetAdapters: override.targetAdapters ?? [],
    observationExtensions: override.observationExtensions ?? [],
    actionKinds: override.actionKinds ?? ["click"],
    model: {
      structuredOutput: override.model?.structuredOutput ?? true,
      visionInput: override.model?.visionInput ?? false,
    },
    maximumArtifactBytes: override.maximumArtifactBytes ?? DEFAULT_MAXIMUM_ARTIFACT_BYTES,
  };
}

/**
 * The canonical, namespaced capability tokens a Runner advertises. Offer
 * requirements are expressed in the same vocabulary so negotiation is a pure set
 * containment check.
 */
export function advertisedCapabilityTokens(caps: RunnerCapabilities): ReadonlySet<string> {
  const tokens = new Set<string>();
  for (const adapter of caps.targetAdapters) tokens.add(`target:${adapter}`);
  for (const extension of caps.observationExtensions) tokens.add(`observation:${extension}`);
  for (const kind of caps.actionKinds) tokens.add(`action:${kind}`);
  if (caps.model.structuredOutput) tokens.add("model:structured-output");
  if (caps.model.visionInput) tokens.add("model:vision-input");
  return tokens;
}

export interface CapabilityMismatch {
  readonly code: "CapabilityMismatch";
  readonly missingCapabilities: readonly string[];
}

export type CapabilityNegotiation =
  | { readonly outcome: "accepted" }
  | { readonly outcome: "rejected"; readonly rejection: CapabilityMismatch };

/**
 * Decide whether a Runner may accept an Offer given its advertised capabilities.
 * Any unmet requirement yields an explicit rejection listing the missing tokens;
 * the Offer's Job payload must not be delivered when this rejects.
 */
export function negotiateCapabilities(
  caps: RunnerCapabilities,
  requiredCapabilities: readonly string[],
): CapabilityNegotiation {
  const advertised = advertisedCapabilityTokens(caps);
  const missingCapabilities = requiredCapabilities.filter((token) => !advertised.has(token));
  if (missingCapabilities.length > 0) {
    return { outcome: "rejected", rejection: { code: "CapabilityMismatch", missingCapabilities } };
  }
  return { outcome: "accepted" };
}

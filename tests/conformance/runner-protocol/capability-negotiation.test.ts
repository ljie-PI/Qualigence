import { describe, expect, it } from "vitest";
import {
  DESKTOP_WINDOWS_UIA_TARGET_CAPABILITY,
  DESKTOP_WINDOWS_UIA_TARGET_CAPABILITY_TOKEN,
  OBSERVATION_GRAPH_V1_CAPABILITY,
  OBSERVATION_GRAPH_V1_CAPABILITY_TOKEN,
  UIA_OBSERVATION_EXTENSION_V1_CAPABILITY,
  UIA_OBSERVATION_EXTENSION_V1_CAPABILITY_TOKEN,
  WEB_OBSERVATION_EXTENSION_V1_CAPABILITY,
  WEB_OBSERVATION_EXTENSION_V1_CAPABILITY_TOKEN,
  advertisedCapabilityTokens,
  capabilities,
  negotiateCapabilities,
  negotiateProtocolMajor,
} from "@qualigence/runner-protocol";

describe("protocol major negotiation", () => {
  it("selects the shared major without downgrading", () => {
    expect(negotiateProtocolMajor([1])).toEqual({ outcome: "selected", selectedProtocolMajor: 1 });
  });

  it("selects only a supported major even when newer majors are offered first", () => {
    expect(negotiateProtocolMajor([2, 1])).toEqual({
      outcome: "selected",
      selectedProtocolMajor: 1,
    });
  });

  it("rejects an unsupported major instead of silently falling back", () => {
    expect(negotiateProtocolMajor([2])).toEqual({
      outcome: "rejected",
      rejection: {
        code: "ProtocolVersionMismatch",
        offeredProtocolMajors: [2],
        supportedProtocolMajors: [1],
      },
    });
  });

  it("rejects an empty offer", () => {
    const result = negotiateProtocolMajor([]);
    expect(result.outcome).toBe("rejected");
  });
});

describe("capability negotiation", () => {
  const runnerCapabilities = capabilities({
    targetAdapters: ["web-playwright"],
    observationExtensions: [
      OBSERVATION_GRAPH_V1_CAPABILITY,
      WEB_OBSERVATION_EXTENSION_V1_CAPABILITY,
    ],
    actionKinds: ["click"],
    model: { structuredOutput: true, visionInput: false },
  });

  it("advertises namespaced capability tokens", () => {
    const tokens = advertisedCapabilityTokens(runnerCapabilities);
    expect(tokens.has("target:web-playwright")).toBe(true);
    expect(tokens.has("action:click")).toBe(true);
    expect(tokens.has(OBSERVATION_GRAPH_V1_CAPABILITY_TOKEN)).toBe(true);
    expect(tokens.has(WEB_OBSERVATION_EXTENSION_V1_CAPABILITY_TOKEN)).toBe(true);
    expect(tokens.has("model:structured-output")).toBe(true);
    expect(tokens.has("model:vision-input")).toBe(false);
  });

  it("accepts a requirement the runner satisfies", () => {
    expect(
      negotiateCapabilities(runnerCapabilities, [
        "target:web-playwright",
        "action:click",
        OBSERVATION_GRAPH_V1_CAPABILITY_TOKEN,
        WEB_OBSERVATION_EXTENSION_V1_CAPABILITY_TOKEN,
      ]),
    ).toEqual({ outcome: "accepted" });
  });

  it("rejects a missing capability with a structured mismatch, never a downgrade", () => {
    expect(
      negotiateCapabilities(runnerCapabilities, ["target:web-playwright", "model:vision-input"]),
    ).toEqual({
      outcome: "rejected",
      rejection: {
        code: "CapabilityMismatch",
        missingCapabilities: ["model:vision-input"],
      },
    });
  });

  it("rejects incompatible observation and extension majors rather than downgrading", () => {
    expect(
      negotiateCapabilities(runnerCapabilities, [
        "observation:observation-graph/v2",
        "observation:web/v2",
      ]),
    ).toEqual({
      outcome: "rejected",
      rejection: {
        code: "CapabilityMismatch",
        missingCapabilities: [
          "observation:observation-graph/v2",
          "observation:web/v2",
        ],
      },
    });
  });

  it("advertises Desktop UIA capability tokens through the same fail-closed vocabulary", () => {
    const desktopCapabilities = capabilities({
      operatingSystem: "windows",
      targetAdapters: [DESKTOP_WINDOWS_UIA_TARGET_CAPABILITY],
      observationExtensions: [OBSERVATION_GRAPH_V1_CAPABILITY, UIA_OBSERVATION_EXTENSION_V1_CAPABILITY],
      actionKinds: ["click", "input", "select", "scroll", "window"],
    });

    const tokens = advertisedCapabilityTokens(desktopCapabilities);
    expect(tokens.has(DESKTOP_WINDOWS_UIA_TARGET_CAPABILITY_TOKEN)).toBe(true);
    expect(tokens.has(OBSERVATION_GRAPH_V1_CAPABILITY_TOKEN)).toBe(true);
    expect(tokens.has(UIA_OBSERVATION_EXTENSION_V1_CAPABILITY_TOKEN)).toBe(true);
    expect(negotiateCapabilities(desktopCapabilities, [
      DESKTOP_WINDOWS_UIA_TARGET_CAPABILITY_TOKEN,
      OBSERVATION_GRAPH_V1_CAPABILITY_TOKEN,
      UIA_OBSERVATION_EXTENSION_V1_CAPABILITY_TOKEN,
      "action:window",
    ])).toEqual({ outcome: "accepted" });
  });
});

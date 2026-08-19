import { describe, expect, it } from "vitest";
import {
  loadLocalConfig,
  loadYaml,
  redactSecrets,
  LocalConfigError,
  type ConfigSources,
} from "../../../apps/local-launcher/src/config.js";

function baseSources(overrides: Partial<ConfigSources> = {}): ConfigSources {
  return {
    yaml: {
      dataDir: "./.qualigence-local",
      core: { port: 4000, httpPort: 4001 },
      runner: { id: "runner-local", spoolSoftBytes: 1_000, spoolHardBytes: 2_000 },
      modelProfile: {
        provider: "openai-compatible",
        baseUrl: "https://model.test/v1",
        model: "gpt-test",
        credentialRef: "env:QUALIGENCE_MODEL_API_KEY",
        visualInput: "disabled",
      },
    },
    ...overrides,
  };
}

describe("loadLocalConfig precedence", () => {
  it("prefers environment over YAML for the core port", () => {
    const config = loadLocalConfig(
      baseSources({ env: { QUALIGENCE_CORE_PORT: "5000" } }),
    );
    expect(config.core.port).toBe(5000);
  });

  it("prefers a non-secret CLI flag over the environment", () => {
    const config = loadLocalConfig(
      baseSources({
        env: { QUALIGENCE_CORE_PORT: "5000" },
        cli: { corePort: 6000 },
      }),
    );
    expect(config.core.port).toBe(6000);
  });

  it("falls back to safe defaults when a field is unset everywhere", () => {
    const config = loadLocalConfig(baseSources());
    expect(config.core.host).toBe("127.0.0.1");
    expect(config.modelProfile.visualInput).toBe("disabled");
  });

  it("keeps YAML values that no higher source overrides", () => {
    const config = loadLocalConfig(baseSources({ env: {}, cli: {} }));
    expect(config.core.port).toBe(4000);
    expect(config.runner.id).toBe("runner-local");
  });
});

describe("loadLocalConfig validation", () => {
  it("forces the core host to loopback", () => {
    const config = loadLocalConfig(baseSources());
    expect(config.core.host).toBe("127.0.0.1");
  });

  it("rejects a spool soft limit that is not below the hard limit", () => {
    expect(() =>
      loadLocalConfig(
        baseSources({
          yaml: {
            ...(baseSources().yaml as Record<string, unknown>),
            runner: { id: "runner-local", spoolSoftBytes: 2_000, spoolHardBytes: 2_000 },
          },
        }),
      ),
    ).toThrowError(LocalConfigError);
  });

  it("rejects an empty credentialRef", () => {
    expect(() =>
      loadLocalConfig(
        baseSources({
          yaml: {
            ...(baseSources().yaml as Record<string, unknown>),
            modelProfile: {
              provider: "openai-compatible",
              baseUrl: "https://model.test/v1",
              model: "gpt-test",
              credentialRef: "",
              visualInput: "disabled",
            },
          },
        }),
      ),
    ).toThrowError(LocalConfigError);
  });
});

describe("secret rejection", () => {
  it("refuses an inline apiKey in YAML text", () => {
    try {
      loadYaml("modelProfile:\n  apiKey: secret\n");
      expect.unreachable("inline secret must fail");
    } catch (error) {
      expect(error).toMatchObject({ code: "SecretInConfiguration" });
    }
  });

  it("refuses an inline privateKey nested anywhere", () => {
    try {
      loadYaml("tls:\n  privateKey: |\n    -----BEGIN\n");
      expect.unreachable("inline secret must fail");
    } catch (error) {
      expect(error).toMatchObject({ code: "SecretInConfiguration" });
    }
  });

  it("allows a credentialRef because it is a reference, not a secret", () => {
    const parsed = loadYaml("modelProfile:\n  credentialRef: env:API_KEY\n");
    expect(parsed).toMatchObject({ modelProfile: { credentialRef: "env:API_KEY" } });
  });

  it("rejects a secret-bearing CLI flag", () => {
    expect(() =>
      loadLocalConfig(baseSources({ cli: { apiKey: "sk-live-123" } })),
    ).toThrowError(LocalConfigError);
  });
});

describe("secret redaction", () => {
  it("never emits a secret value in a log-safe view", () => {
    const redacted = redactSecrets({
      modelProfile: {
        credentialRef: "env:API_KEY",
        apiKey: "sk-live-abcdef",
      },
      tls: { key: "-----BEGIN PRIVATE KEY-----abc" },
    });

    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain("sk-live-abcdef");
    expect(serialized).not.toContain("BEGIN PRIVATE KEY");
    expect(serialized).toContain("env:API_KEY");
    expect(serialized).toContain("[redacted]");
  });
});

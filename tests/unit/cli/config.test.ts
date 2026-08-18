import { describe, expect, it } from "vitest";
import { loadConfig, parseRunRequest, CliConfigError } from "@qualigence/cli/config";

function baseEnv(): NodeJS.ProcessEnv {
  return {
    QUALIGENCE_MODEL_BASE_URL: "https://models.test/v1",
    QUALIGENCE_MODEL_API_KEY: "sk-secret-value",
    QUALIGENCE_MODEL_NAME: "test-model",
  };
}

describe("loadConfig", () => {
  it("reads model settings from the environment", () => {
    const config = loadConfig({ ...baseEnv(), QUALIGENCE_DATA_DIR: "/data" });
    expect(config).toEqual({
      model: {
        baseUrl: "https://models.test/v1",
        apiKey: "sk-secret-value",
        modelName: "test-model",
      },
      dataDir: "/data",
    });
  });

  it("fails with InvalidConfiguration when the model secret is missing", () => {
    try {
      loadConfig({ ...baseEnv(), QUALIGENCE_MODEL_API_KEY: undefined });
      expect.unreachable("missing model secret must fail");
    } catch (error) {
      expect(error).toMatchObject({ code: "InvalidConfiguration" });
      expect(error).toBeInstanceOf(CliConfigError);
    }
  });
});

describe("parseRunRequest", () => {
  it("builds a request from url/objective with safe defaults", () => {
    const invocation = parseRunRequest([
      "run",
      "--url",
      "http://127.0.0.1:3000/",
      "--objective",
      "add one item",
    ]);

    expect(invocation.output).toBe("human");
    expect(invocation.request).toEqual({
      target: { kind: "web", url: "http://127.0.0.1:3000/" },
      objective: "add one item",
      policy: expect.objectContaining({ environment: "isolated_test", allowedOrigins: ["http://127.0.0.1:3000"], allowedActionKinds: ["click"] }),
      executionProfile: {
        modelProfileId: "default",
        headed: false,
        navigationTimeoutMs: 30_000,
        actionTimeoutMs: 15_000,
      },
    });
  });

  it("supports json output and the headed flag", () => {
    const invocation = parseRunRequest([
      "run",
      "--url",
      "http://127.0.0.1:3000/",
      "--objective",
      "add one item",
      "--output",
      "json",
      "--headed",
    ]);
    expect(invocation.output).toBe("json");
    expect(invocation.request.executionProfile.headed).toBe(true);
  });

  it("has no --api-key option so secrets cannot be passed as arguments", () => {
    expect(() =>
      parseRunRequest([
        "run",
        "--url",
        "http://127.0.0.1:3000/",
        "--objective",
        "add one item",
        "--api-key",
        "sk-leak",
      ]),
    ).toThrow(CliConfigError);
  });

  it("rejects a missing required option as InvalidConfiguration", () => {
    try {
      parseRunRequest(["run", "--objective", "add one item"]);
      expect.unreachable("missing --url must fail");
    } catch (error) {
      expect(error).toMatchObject({ code: "InvalidConfiguration" });
    }
  });

  it("rejects an invalid output mode", () => {
    expect(() =>
      parseRunRequest([
        "run",
        "--url",
        "http://127.0.0.1:3000/",
        "--objective",
        "add one item",
        "--output",
        "xml",
      ]),
    ).toThrow(CliConfigError);
  });

  it("rejects a malformed target URL with a stable CLI configuration error", () => {
    try {
      parseRunRequest([
        "run",
        "--url",
        "not-a-url",
        "--objective",
        "add one item",
      ]);
      expect.unreachable("malformed URL must fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CliConfigError);
      expect(error).toMatchObject({ code: "InvalidConfiguration", name: "CliConfigError" });
    }
  });

  it.each([
    "ftp://example.test/path",
    "file:///tmp/target.html",
    "data:text/html,hello",
    "https://user:secret@example.test/",
  ])("rejects unsafe target URL %s with CliConfigError", (url) => {
    expect(() => parseRunRequest(["run", "--url", url, "--objective", "add one item"])).toThrow(CliConfigError);
  });
});

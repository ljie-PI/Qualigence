import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ModelGateway,
  ModelGatewayError,
  type ModelProvider,
  type StructuredOutputContract,
} from "@qualigence/model-gateway";
import type {
  ModelDataPolicy,
  ModelImageInput,
  ModelProviderRequest,
  StructuredModelRequest,
} from "@qualigence/model-provider";

const PNG_MARKER = "QUALIGENCE_SECRET_PIXELS_DO_NOT_LOG";

const passthroughContract: StructuredOutputContract<{ readonly ok: true }> = {
  name: "vision-decision",
  jsonSchema: { type: "object" },
  parse() {
    return { ok: true };
  },
};

describe("ModelGateway visual input policy", () => {
  it("rejects an image-bearing request that carries no data policy before any provider call", async () => {
    const provider = fakeProvider({ visionInput: true });
    const gateway = new ModelGateway({ provider });

    await expect(
      gateway.invokeStructured(requestWithImage({ dataPolicy: undefined }), passthroughContract),
    ).rejects.toMatchObject({ code: "VisionNotAllowed" } satisfies Partial<ModelGatewayError>);
    expect(provider.requests).toHaveLength(0);
  });

  it("rejects a disabled-vision data policy before any provider call", async () => {
    const provider = fakeProvider({ visionInput: true });
    const gateway = new ModelGateway({ provider });

    await expect(
      gateway.invokeStructured(
        requestWithImage({ dataPolicy: dataPolicy({ visualInput: "disabled" }) }),
        passthroughContract,
      ),
    ).rejects.toMatchObject({ code: "VisionNotAllowed" } satisfies Partial<ModelGatewayError>);
    expect(provider.requests).toHaveLength(0);
  });

  it("rejects when the provider lacks vision capability before any provider call", async () => {
    const provider = fakeProvider({ visionInput: false });
    const gateway = new ModelGateway({ provider });

    await expect(
      gateway.invokeStructured(requestWithImage({ dataPolicy: dataPolicy() }), passthroughContract),
    ).rejects.toMatchObject({
      code: "VisionCapabilityMismatch",
    } satisfies Partial<ModelGatewayError>);
    expect(provider.requests).toHaveLength(0);
  });

  it("rejects a corrupted image hash before any provider call", async () => {
    const provider = fakeProvider({ visionInput: true });
    const gateway = new ModelGateway({ provider });

    await expect(
      gateway.invokeStructured(
        requestWithImage({ dataPolicy: dataPolicy(), sha256: "0".repeat(64) }),
        passthroughContract,
      ),
    ).rejects.toMatchObject({
      code: "ImageIntegrityViolation",
    } satisfies Partial<ModelGatewayError>);
    expect(provider.requests).toHaveLength(0);
  });

  it("rejects a sensitivity the data policy does not allow before any provider call", async () => {
    const provider = fakeProvider({ visionInput: true });
    const gateway = new ModelGateway({ provider });

    await expect(
      gateway.invokeStructured(
        requestWithImage({
          dataPolicy: dataPolicy({ allowedImageSensitivities: ["public"] }),
          sensitivity: "sensitive",
        }),
        passthroughContract,
      ),
    ).rejects.toMatchObject({ code: "VisionNotAllowed" } satisfies Partial<ModelGatewayError>);
    expect(provider.requests).toHaveLength(0);
  });

  it("rejects an image larger than the data policy maximum before any provider call", async () => {
    const provider = fakeProvider({ visionInput: true });
    const gateway = new ModelGateway({ provider });

    await expect(
      gateway.invokeStructured(
        requestWithImage({ dataPolicy: dataPolicy({ maximumImageBytes: 1 }) }),
        passthroughContract,
      ),
    ).rejects.toMatchObject({ code: "VisionNotAllowed" } satisfies Partial<ModelGatewayError>);
    expect(provider.requests).toHaveLength(0);
  });

  it("forwards a fully permitted image to the provider exactly once", async () => {
    const provider = fakeProvider({ visionInput: true }, [{ ok: true }]);
    const gateway = new ModelGateway({ provider });

    const result = await gateway.invokeStructured(
      requestWithImage({ dataPolicy: dataPolicy() }),
      passthroughContract,
    );

    expect(result.value).toEqual({ ok: true });
    expect(provider.requests).toHaveLength(1);
    const forwarded = provider.requests[0]?.messages[0]?.images;
    expect(forwarded).toHaveLength(1);
  });

  it("never leaks base64 image data in a rejection error", async () => {
    const provider = fakeProvider({ visionInput: false });
    const gateway = new ModelGateway({ provider });

    let captured: unknown;
    try {
      await gateway.invokeStructured(requestWithImage({ dataPolicy: dataPolicy() }), passthroughContract);
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(ModelGatewayError);
    const serialized = JSON.stringify({
      message: (captured as Error).message,
      stack: (captured as Error).stack,
      value: captured,
    });
    expect(serialized).not.toContain(PNG_MARKER);
    expect(serialized).not.toContain(base64Payload());
  });
});

function base64Payload(): string {
  return Buffer.from(PNG_MARKER, "utf8").toString("base64");
}

function image(overrides: { readonly sha256?: string; readonly sensitivity?: ModelImageInput["sensitivity"] } = {}): ModelImageInput {
  const dataBase64 = base64Payload();
  return {
    mediaType: "image/png",
    dataBase64,
    sha256: overrides.sha256 ?? createHash("sha256").update(Buffer.from(dataBase64, "base64")).digest("hex"),
    sensitivity: overrides.sensitivity ?? "internal",
    sourceArtifactId: "artifact-1",
  };
}

function dataPolicy(overrides: Partial<ModelDataPolicy> = {}): ModelDataPolicy {
  return {
    visualInput: overrides.visualInput ?? "on-demand",
    allowedImageSensitivities:
      overrides.allowedImageSensitivities ?? ["public", "internal", "sensitive"],
    maximumImageBytes: overrides.maximumImageBytes ?? 5_000_000,
  };
}

function requestWithImage(options: {
  readonly dataPolicy: ModelDataPolicy | undefined;
  readonly sha256?: string;
  readonly sensitivity?: ModelImageInput["sensitivity"];
}): StructuredModelRequest {
  const overrides: { sha256?: string; sensitivity?: ModelImageInput["sensitivity"] } = {};
  if (options.sha256 !== undefined) {
    overrides.sha256 = options.sha256;
  }
  if (options.sensitivity !== undefined) {
    overrides.sensitivity = options.sensitivity;
  }
  return {
    operation: "execution.decision",
    model: "vision-model",
    messages: [
      {
        role: "user",
        content: "describe the screenshot",
        images: [image(overrides)],
      },
    ],
    timeoutMs: 1_000,
    ...(options.dataPolicy === undefined ? {} : { dataPolicy: options.dataPolicy }),
  };
}

function fakeProvider(
  capabilities: { readonly visionInput: boolean },
  responses: unknown[] = [],
) {
  const requests: ModelProviderRequest[] = [];
  const provider: ModelProvider & { readonly requests: ModelProviderRequest[] } = {
    capabilities: {
      structuredOutput: true,
      visionInput: capabilities.visionInput,
      toolCalling: false,
      streaming: false,
    },
    requests,
    async invoke(providerRequest) {
      requests.push(providerRequest);
      return {
        output: responses.shift() ?? { ok: true },
        model: providerRequest.model,
        finishReason: "stop",
      };
    },
  };

  return provider;
}

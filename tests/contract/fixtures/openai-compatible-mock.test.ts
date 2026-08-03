import { afterEach, describe, expect, it } from "vitest";
import {
  startMockModelServer,
  type MockModelHandle,
} from "../../fixtures/openai-compatible/mock-server.js";
import {
  decisionRequest,
  graphWithAddButton,
  verificationRequest,
  type ChatCompletionRequestBody,
  type ObservationGraphLike,
} from "../../fixtures/openai-compatible/responses.js";

interface InvokeResult {
  readonly status: number;
  readonly output: Record<string, unknown>;
}

async function invoke(
  baseUrl: string,
  body: ChatCompletionRequestBody,
): Promise<InvokeResult> {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.status !== 200) {
    return { status: response.status, output: {} };
  }
  const completion = (await response.json()) as {
    choices: readonly { message: { content: string } }[];
  };
  return {
    status: response.status,
    output: JSON.parse(completion.choices[0]!.message.content) as Record<string, unknown>,
  };
}

function beforeGraph(): ObservationGraphLike {
  return {
    graphId: "g-before",
    nodes: [
      { id: "n-price", role: "text", text: "$19" },
      { id: "n-total-before", role: "text", text: "Cart total: $0" },
    ],
  };
}

function afterGraph(total: string): ObservationGraphLike {
  return {
    graphId: "g-after",
    nodes: [
      { id: "n-price", role: "text", text: "$19" },
      { id: "n-total-after", role: "text", text: `Cart total: ${total}` },
    ],
  };
}

describe("openai-compatible mock model server", () => {
  const open: MockModelHandle[] = [];

  afterEach(async () => {
    while (open.length > 0) {
      await open.pop()?.close();
    }
  });

  async function start(
    mode?: "dynamic" | "blocked" | "unauthorized",
  ): Promise<MockModelHandle> {
    const handle = await startMockModelServer(mode ? { mode } : {});
    open.push(handle);
    return handle;
  }

  it("derives the decision nodeId dynamically from the observation", async () => {
    const model = await start();
    const decision = await invoke(model.url, decisionRequest(graphWithAddButton("n-live")));
    expect(decision.status).toBe(200);
    expect(decision.output.action).toMatchObject({ kind: "click", nodeId: "n-live" });
  });

  it("passes verification when the after total equals the item price", async () => {
    const model = await start();
    const verification = await invoke(
      model.url,
      verificationRequest(beforeGraph(), afterGraph("$19")),
    );
    expect(verification.output.status).toBe("passed");
    expect(verification.output.claims).toEqual([]);
  });

  it("cites dynamic before/after graph IDs and $19/$29 on a Finding", async () => {
    const model = await start();
    const verification = await invoke(
      model.url,
      verificationRequest(beforeGraph(), afterGraph("$29")),
    );
    expect(verification.output.status).toBe("failed");
    const claims = verification.output.claims as readonly {
      expected: { graphId: string; text: string };
      observed: { graphId: string; text: string };
    }[];
    expect(claims[0]!.expected.graphId).toBe("g-before");
    expect(claims[0]!.expected.text).toBe("$19");
    expect(claims[0]!.observed.graphId).toBe("g-after");
    expect(claims[0]!.observed.text).toBe("Cart total: $29");
  });

  it("returns a nonexistent nodeId in blocked mode", async () => {
    const model = await start("blocked");
    const decision = await invoke(model.url, decisionRequest(graphWithAddButton("n-live")));
    expect(decision.output.action).toMatchObject({ kind: "click" });
    expect((decision.output.action as { nodeId: string }).nodeId).not.toBe("n-live");
  });

  it("returns HTTP 401 in unauthorized mode and counts each request", async () => {
    const model = await start("unauthorized");
    const decision = await invoke(model.url, decisionRequest(graphWithAddButton("n-live")));
    expect(decision.status).toBe(401);
    expect(model.requestCount()).toBe(1);
  });

  it("answers /health and recycles the port", async () => {
    const model = await start();
    const health = await fetch(new URL("/health", `${model.url}/`));
    expect(health.status).toBe(200);
  });
});

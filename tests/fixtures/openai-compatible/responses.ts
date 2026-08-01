/**
 * Pure builders for the deterministic OpenAI-compatible fake. They translate a
 * captured Observation into the structured Decision/Verification payloads the
 * Model Gateway expects, deriving every graphId/nodeId/text from the request so
 * no runtime identifier is ever hard-coded (see the LS-04 design, §3).
 */

export interface ObservationNodeLike {
  readonly id: string;
  readonly role?: string;
  readonly name?: string;
  readonly text?: string | null;
}

export interface ObservationGraphLike {
  readonly graphId: string;
  readonly nodes: readonly ObservationNodeLike[];
}

export type ChatMessage = { readonly role: string; readonly content: string };

export interface ChatCompletionRequestBody {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly response_format: {
    readonly type: "json_schema";
    readonly json_schema: { readonly name: string };
  };
}

const ADD_TO_CART_NAME = "Add to cart";

export function findAddButton(graph: ObservationGraphLike): ObservationNodeLike {
  const node =
    graph.nodes.find((candidate) => candidate.name === ADD_TO_CART_NAME) ??
    graph.nodes.find((candidate) => candidate.role === "button");
  if (node === undefined) {
    throw new Error("mock model: no add-to-cart button node in observation");
  }
  return node;
}

export function findCartTotal(graph: ObservationGraphLike): ObservationNodeLike {
  const node = graph.nodes.find(
    (candidate) =>
      typeof candidate.text === "string" && candidate.text.includes("Cart total"),
  );
  if (node === undefined) {
    throw new Error("mock model: no cart-total node in observation");
  }
  return node;
}

export function findItemPrice(graph: ObservationGraphLike): ObservationNodeLike {
  const node = graph.nodes.find(
    (candidate) =>
      typeof candidate.text === "string" && /^\$\d+$/.test(candidate.text.trim()),
  );
  if (node === undefined) {
    throw new Error("mock model: no item-price node in observation");
  }
  return node;
}

function amountOf(text: string | null | undefined): number {
  const match = /\$(\d+)/.exec(text ?? "");
  return match ? Number(match[1]) : Number.NaN;
}

export function decisionPayload(observation: ObservationGraphLike): unknown {
  const button = findAddButton(observation);
  return {
    action: { kind: "click", nodeId: button.id },
    reason: "click the add-to-cart control to add the single item",
  };
}

/** A decision that references a node absent from the observation, forcing the
 * gateway's single structured-output correction to fail and the run to block. */
export function blockedDecisionPayload(observation: ObservationGraphLike): unknown {
  const missing = `n-not-in-graph-${observation.graphId}`;
  return {
    action: { kind: "click", nodeId: missing },
    reason: "attempt to click a control that does not exist",
  };
}

export function verificationPayload(
  before: ObservationGraphLike,
  after: ObservationGraphLike,
): unknown {
  const priceNode = findItemPrice(before);
  const totalNode = findCartTotal(after);
  const expectedAmount = amountOf(priceNode.text);
  const observedAmount = amountOf(totalNode.text);

  if (observedAmount === expectedAmount) {
    return {
      status: "passed",
      summary: "cart total matches the single item price",
      claims: [],
    };
  }

  return {
    status: "failed",
    summary: "cart total does not match the single item price",
    severitySuggestion: "medium",
    claims: [
      {
        expected: { graphId: before.graphId, nodeId: priceNode.id, text: priceNode.text },
        observed: { graphId: after.graphId, nodeId: totalNode.id, text: totalNode.text },
      },
    ],
  };
}

/** Wraps a structured payload in an OpenAI chat-completion envelope. */
export function completion(model: string, payload: unknown): string {
  return JSON.stringify({
    id: "chatcmpl-qualigence-mock",
    object: "chat.completion",
    created: 0,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: JSON.stringify(payload) },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

function chatRequest(operation: string, userPayload: unknown): ChatCompletionRequestBody {
  return {
    model: "qualigence-mock-model",
    messages: [
      { role: "system", content: "system" },
      { role: "user", content: JSON.stringify(userPayload) },
    ],
    response_format: { type: "json_schema", json_schema: { name: operation } },
  };
}

export function graphWithAddButton(nodeId: string): ObservationGraphLike {
  return {
    graphId: "g-decision",
    nodes: [
      { id: nodeId, role: "button", name: ADD_TO_CART_NAME },
      { id: "n-price", role: "text", text: "$19" },
    ],
  };
}

export function decisionRequest(
  observation: ObservationGraphLike,
): ChatCompletionRequestBody {
  return chatRequest("execution_decision", { objective: "add one item", observation });
}

export function verificationRequest(
  before: ObservationGraphLike,
  after: ObservationGraphLike,
): ChatCompletionRequestBody {
  return chatRequest("execution_verification", {
    objective: "add one item",
    before,
    after,
  });
}

/**
 * Extracts the first user message that parses as a JSON object. The Gateway's
 * correction retry appends a plain-text user message, which is skipped so the
 * fake always reads the original Observation context.
 */
export function parseUserContext(messages: readonly ChatMessage[]): {
  readonly objective?: string;
  readonly observation?: ObservationGraphLike;
  readonly before?: ObservationGraphLike;
  readonly after?: ObservationGraphLike;
} {
  for (const message of messages) {
    if (message.role !== "user") {
      continue;
    }
    try {
      const parsed = JSON.parse(message.content) as unknown;
      if (parsed !== null && typeof parsed === "object") {
        return parsed as ReturnType<typeof parseUserContext>;
      }
    } catch {
      // Not the JSON context message (e.g. the correction prompt); keep looking.
    }
  }
  return {};
}

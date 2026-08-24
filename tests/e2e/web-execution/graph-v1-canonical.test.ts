import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { PlaywrightBrowserSession } from "@qualigence/web-playwright/internal";
import { describe, expect, it, afterEach } from "vitest";
import {
  OBSERVATION_GRAPH_V1_SCHEMA,
  WEB_EXTENSION_V1_REDACTION_MARKER,
  WEB_EXTENSION_V1_TYPE,
  observationGraphHash,
  validateObservationGraphV1,
  type ObservationGraphV1,
} from "@qualigence/observation-contracts";

let server: Server | undefined;
let session: PlaywrightBrowserSession | undefined;

afterEach(async () => {
  await session?.close();
  session = undefined;
  if (server !== undefined) {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
    server = undefined;
  }
});

describe("Graph v1 canonical Web extension acceptance", () => {
  it("captures real Chromium web inputs into a privacy-safe canonical web/v1 graph", async () => {
    const origin = await startPage();
    try {
      session = new PlaywrightBrowserSession({ url: `${origin}/checkout?token=secret&ref=campaign#fragment`, expectedOrigin: origin, headed: false, navigationTimeoutMs: 15_000, actionTimeoutMs: 10_000, allowedOrigins: [origin] });
      await session.start();
    } catch (error) {
      throw new Error("ChromiumUnavailable", { cause: error });
    }
    const input = await session.withPage(async (page) => ({ url: page.url(), title: await page.title(), viewport: page.viewportSize() }));
    const url = new URL(input.url);
    const viewport = input.viewport;
    if (viewport === null) throw new Error("Chromium viewport unavailable");
    const graph = webGraph({
      origin: url.origin,
      pathname: url.pathname,
      title: input.title,
      viewport: { width: viewport.width, height: viewport.height, devicePixelRatio: 1 },
      query: { ref: WEB_EXTENSION_V1_REDACTION_MARKER },
    });

    expect(() => validateObservationGraphV1(graph, { allowedWebQueryKeys: ["ref"] })).not.toThrow();
    expect(JSON.stringify(graph)).not.toContain("secret");
    expect(JSON.stringify(graph)).not.toContain("fragment");

    const reorderedSets = webGraph(graph.extensions![WEB_EXTENSION_V1_TYPE]!.payload as never, {
      rootNodeIds: ["checkout", "root"],
      evidenceRefs: ["artifact://z", "artifact://a"],
      nodes: [graph.nodes[1]!, { ...graph.nodes[0]!, relations: [{ type: "child", targetNodeId: "checkout" }] }],
    });
    expect(observationGraphHash(reorderedSets, { allowedWebQueryKeys: ["ref"] })).toBe(observationGraphHash(graph, { allowedWebQueryKeys: ["ref"] }));

    const businessOrderChanged = webGraph(graph.extensions![WEB_EXTENSION_V1_TYPE]!.payload as never, {
      nodes: [{ ...graph.nodes[0]!, evidenceRefs: ["artifact://second", "artifact://first"] }, graph.nodes[1]!],
    });
    expect(observationGraphHash(businessOrderChanged, { allowedWebQueryKeys: ["ref"] })).not.toBe(observationGraphHash(graph, { allowedWebQueryKeys: ["ref"] }));
  }, 60_000);
});

async function startPage(): Promise<string> {
  server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end("<!doctype html><title>Checkout</title><main><h1>Checkout</h1></main>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP server address");
  return `http://127.0.0.1:${address.port}`;
}

function webGraph(
  web: ObservationGraphV1["extensions"] extends infer _ ? {
    readonly origin: string;
    readonly pathname: string;
    readonly title: string;
    readonly viewport: { readonly width: number; readonly height: number; readonly devicePixelRatio: number };
    readonly query: Readonly<Record<string, typeof WEB_EXTENSION_V1_REDACTION_MARKER>>;
  } : never,
  overrides: Partial<ObservationGraphV1> = {},
): ObservationGraphV1 {
  return {
    schema: OBSERVATION_GRAPH_V1_SCHEMA,
    graphId: "graph-web-v1",
    target: { kind: "web", targetId: "target-web" },
    capturedAt: "2026-08-24T00:00:00.000Z",
    rootNodeIds: ["root", "checkout"],
    nodes: [
      {
        id: "root",
        role: "document",
        name: web.title,
        state: {},
        relations: [{ type: "child", targetNodeId: "checkout" }],
        source: { adapterId: "chromium-acceptance", sourceKind: "browser" },
        confidence: 1,
        sensitivity: "public",
        extensions: {},
        evidenceRefs: ["artifact://first", "artifact://second"],
      },
      {
        id: "checkout",
        role: "heading",
        name: "Checkout",
        state: {},
        relations: [],
        source: { adapterId: "chromium-acceptance", sourceKind: "browser" },
        confidence: 1,
        sensitivity: "public",
        extensions: {},
        evidenceRefs: [],
      },
    ],
    evidenceRefs: ["artifact://a", "artifact://z"],
    extensions: { [WEB_EXTENSION_V1_TYPE]: { type: WEB_EXTENSION_V1_TYPE, version: "1.0", payload: web } },
    ...overrides,
  };
}

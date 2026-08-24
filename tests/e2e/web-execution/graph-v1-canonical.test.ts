import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { PlaywrightBrowserSession, WebTargetError } from "@qualigence/web-playwright/internal";
import { describe, expect, it, afterEach } from "vitest";
import {
  OBSERVATION_GRAPH_V1_SCHEMA,
  WEB_EXTENSION_V1_REDACTION_MARKER,
  WEB_EXTENSION_V1_TYPE,
  observationGraphHash,
  validateObservationGraphV1,
  type ObservationGraphV1,
  type ObservationJsonValue,
} from "@qualigence/observation-contracts";

const require = createRequire(import.meta.url);
const schemaPath = require.resolve("@qualigence/observation-contracts/schema");
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
    session = new PlaywrightBrowserSession({ url: `${origin}/checkout?token=secret&ref=campaign#fragment`, expectedOrigin: origin, headed: false, navigationTimeoutMs: 15_000, actionTimeoutMs: 10_000, allowedOrigins: [origin] });
    try {
      await session.start();
    } catch (error) {
      if (error instanceof WebTargetError && error.code === "BrowserLaunchFailed") {
        throw new Error("ChromiumUnavailable", { cause: error });
      }
      throw error;
    }
    const input = await session.withPage(async (page) => ({ url: page.url(), title: await page.title(), viewport: page.viewportSize(), devicePixelRatio: await page.evaluate("window.devicePixelRatio") as number }));
    const url = new URL(input.url);
    const viewport = input.viewport;
    if (viewport === null) throw new Error("Chromium viewport unavailable");
    const query = Object.fromEntries([...url.searchParams.keys()].filter((key) => key === "ref").map((key) => [key, WEB_EXTENSION_V1_REDACTION_MARKER] as const));
    const graph = webGraph({
      origin: url.origin,
      pathname: url.pathname,
      title: input.title,
      viewport: { width: viewport.width, height: viewport.height, devicePixelRatio: input.devicePixelRatio },
      query,
    });

    expect(() => validateObservationGraphV1(graph, { allowedWebQueryKeys: ["ref"] })).not.toThrow();
    expect(await schemaAcceptsGraph(graph)).toBe(true);
    expect(JSON.stringify(graph)).not.toContain("secret");
    expect(JSON.stringify(graph)).not.toContain("fragment");

    const reorderedSets = webGraph(graph.extensions![WEB_EXTENSION_V1_TYPE]!.payload as never, {
      rootNodeIds: ["checkout", "root"],
      evidenceRefs: ["artifact://z", "artifact://a"],
      nodes: [graph.nodes[1]!, { ...graph.nodes[0]!, relations: [{ type: "owns", targetNodeId: "checkout" }, { type: "child", targetNodeId: "checkout" }] }],
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

async function schemaAcceptsGraph(graph: ObservationGraphV1): Promise<boolean> {
  const schema = JSON.parse(await readFile(schemaPath, "utf8")) as {
    properties: { extensions: { properties: Record<string, unknown> } };
    $defs: { webExtensionV1: { properties: { payload: { properties: Record<string, unknown> } } } };
  };
  const web = graph.extensions?.[WEB_EXTENSION_V1_TYPE]?.payload as WebPayload | undefined;
  if (web === undefined) return false;
  const payload = schema.$defs.webExtensionV1.properties.payload.properties as {
    readonly origin?: { readonly pattern?: string };
    readonly pathname?: { readonly pattern?: string };
  };
  return new RegExp(payload.origin?.pattern ?? "a^").test(web.origin) &&
    new RegExp(payload.pathname?.pattern ?? "a^").test(web.pathname) &&
    Number.isSafeInteger(web.viewport.width) && web.viewport.width >= 1 && web.viewport.width <= 32768 &&
    Number.isSafeInteger(web.viewport.height) && web.viewport.height >= 1 && web.viewport.height <= 32768 &&
    Number.isFinite(web.viewport.devicePixelRatio) && web.viewport.devicePixelRatio > 0 && web.viewport.devicePixelRatio <= 16 &&
    Object.values(web.query).every((value) => value === WEB_EXTENSION_V1_REDACTION_MARKER) &&
    schema.properties.extensions.properties[WEB_EXTENSION_V1_TYPE] !== undefined;
}

interface WebViewport extends Readonly<Record<string, ObservationJsonValue>> {
  readonly width: number;
  readonly height: number;
  readonly devicePixelRatio: number;
}

interface WebPayload extends Readonly<Record<string, ObservationJsonValue>> {
  readonly origin: string;
  readonly pathname: string;
  readonly title: string;
  readonly viewport: WebViewport;
  readonly query: Readonly<Record<string, typeof WEB_EXTENSION_V1_REDACTION_MARKER>>;
}

function webGraph(
  web: WebPayload,
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
        relations: [{ type: "child", targetNodeId: "checkout" }, { type: "owns", targetNodeId: "checkout" }],
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

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
    expect(await schemaAcceptsGraph(graph)).toEqual([]);
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

async function schemaAcceptsGraph(graph: ObservationGraphV1): Promise<readonly string[]> {
  const schema = JSON.parse(await readFile(schemaPath, "utf8")) as JsonSchema;
  return validateSchema(graph, schema, schema, "graph");
}

type JsonSchema = Readonly<Record<string, unknown>> & { readonly $defs?: Readonly<Record<string, JsonSchema>> };

function validateSchema(value: unknown, schema: JsonSchema, root: JsonSchema, path: string): string[] {
  const ref = schema.$ref;
  if (typeof ref === "string") {
    const resolved = resolveRef(ref, root);
    return resolved === undefined ? [`${path}: unresolved ref ${ref}`] : validateSchema(value, resolved, root, path);
  }
  const errors: string[] = [];
  const notSchema = schema.not;
  if (isSchema(notSchema) && validateSchema(value, notSchema, root, path).length === 0) {
    errors.push(`${path}: matched forbidden schema`);
  }
  const type = schema.type;
  if (type !== undefined && !matchesType(value, type)) errors.push(`${path}: expected ${String(type)}`);
  if (schema.const !== undefined && value !== schema.const) errors.push(`${path}: expected const ${String(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value as never)) errors.push(`${path}: not in enum`);
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) errors.push(`${path}: too short`);
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: pattern mismatch`);
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${path}: below minimum`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${path}: above maximum`);
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) errors.push(`${path}: below exclusiveMinimum`);
  }
  if (Array.isArray(value) && isSchema(schema.items)) {
    value.forEach((item, index) => errors.push(...validateSchema(item, schema.items as JsonSchema, root, `${path}[${index}]`)));
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Readonly<Record<string, unknown>>;
    const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [];
    for (const key of required) if (!(key in record)) errors.push(`${path}.${key}: missing required`);
    const properties = isRecord(schema.properties) ? schema.properties : {};
    if (isSchema(schema.propertyNames)) {
      for (const key of Object.keys(record)) {
        errors.push(...validateSchema(key, schema.propertyNames, root, `${path}.${key}<name>`));
      }
    }
    for (const [key, item] of Object.entries(record)) {
      const propertySchema = properties[key];
      if (propertySchema === false) {
        errors.push(`${path}.${key}: forbidden property`);
      } else if (isSchema(propertySchema)) {
        errors.push(...validateSchema(item, propertySchema, root, `${path}.${key}`));
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}.${key}: additional property`);
      } else if (isSchema(schema.additionalProperties)) {
        errors.push(...validateSchema(item, schema.additionalProperties, root, `${path}.${key}`));
      }
    }
  }
  return errors;
}

function resolveRef(ref: string, root: JsonSchema): JsonSchema | undefined {
  if (!ref.startsWith("#/$defs/")) return undefined;
  return root.$defs?.[ref.slice("#/$defs/".length)];
}

function matchesType(value: unknown, type: unknown): boolean {
  if (Array.isArray(type)) return type.some((item) => matchesType(value, item));
  switch (type) {
    case "object": return value !== null && typeof value === "object" && !Array.isArray(value);
    case "array": return Array.isArray(value);
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    default: return true;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSchema(value: unknown): value is JsonSchema {
  return isRecord(value);
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

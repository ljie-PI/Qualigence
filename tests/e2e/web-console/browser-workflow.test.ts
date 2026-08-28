import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join, normalize } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PlaywrightBrowserSession, type BrowserLauncher } from "@qualigence/web-playwright/internal";
import playwright from "../../../packages/target-adapters/web-playwright/node_modules/playwright/index.js";
import { requireInfrastructure } from "../../helpers/infrastructure-preflight.js";
import { createTestJwtIssuer, startTestOidcProvider, type TestOidcProvider } from "../../helpers/oidc-jwt.js";
import { setupServerFixture, type ServerFixture } from "../../helpers/server-fixture.js";

const execFileAsync = promisify(execFile);

/**
 * The rendered acceptance uses the production Vite dist, a real Fastify server,
 * and Authorization Code + PKCE rather than a Console API client or browser
 * fetch substitute. It intentionally fails (rather than skips) without Docker,
 * OpenSSL, or Chromium.
 */
describe("rendered Web Console browser workflow", () => {
  let fixture: ServerFixture | undefined;
  let oidc: TestOidcProvider | undefined;
  let proxy: Server | undefined;
  let consoleUrl = "";
  let browser: PlaywrightBrowserSession | undefined;
  const browserErrors: string[] = [];

  beforeAll(async () => {
    requireInfrastructure(["chromium", "openssl", "docker"]);
    await buildConsoleDist();
    proxy = await startConsoleProxy(() => ({
      apiBaseUrl: `${consoleUrl}/api`,
      authMode: "oidc",
      oidc: oidc === undefined ? {} : {
        issuer: oidc.issuer,
        authorizationEndpoint: oidc.authorizationEndpoint,
        tokenEndpoint: oidc.tokenEndpoint,
        jwksUri: oidc.jwksUri,
        clientId: "qualigence-console",
        redirectUri: `${consoleUrl}/auth/callback`,
        allowedAlgorithms: ["RS256"],
        allowedTenants: ["tenant-a"],
      },
    }), () => fixture?.baseUrl);
    consoleUrl = serverUrl(proxy);
    const jwt = createTestJwtIssuer();
    oidc = await startTestOidcProvider({
      redirectUri: `${consoleUrl}/auth/callback`,
      clientId: "qualigence-console",
      tenantId: "tenant-a",
      roles: ["qa-admin"],
      jwt,
      issueAccessToken: () => fixture!.token("tenant-a", ["admin"]),
    });
    fixture = await setupServerFixture({ oidc: { issuer: oidc.issuer, jwt } });
    const launcher: BrowserLauncher = {
      launch: (options) => playwright.chromium.launch({ ...options, args: ["--ignore-certificate-errors"] }),
    };
    browser = new PlaywrightBrowserSession({
      url: consoleUrl,
      expectedOrigin: consoleUrl,
      allowedOrigins: [consoleUrl],
      actionTimeoutMs: 20_000,
      navigationTimeoutMs: 20_000,
      headed: false,
    }, launcher);
    await browser.start();
    await browser.withPage(async (page) => {
      page.on("pageerror", (error) => browserErrors.push(error.message));
      await page.reload({ waitUntil: "domcontentloaded" });
    });
  }, 240_000);

  afterAll(async () => {
    await browser?.close().catch(() => undefined);
    await closeServer(proxy);
    await oidc?.stop().catch(() => undefined);
    await fixture?.stop().catch(() => undefined);
  });

  it("clicks SSO then creates Project, PRD, Test Plan, Mission, and Run through visible controls", async () => {
    await browser!.withPage(async (page) => {
      try {
        await page.getByRole("button", { name: "Sign in with SSO" }).waitFor();
      } catch {
        throw new Error(`Console did not render: ${browserErrors.join(" | ")}`);
      }
      await page.getByRole("button", { name: "Sign in with SSO" }).click();
      await page.getByRole("heading", { name: "Projects" }).waitFor();
      expect(page.url()).toBe(`${consoleUrl}/projects`);
      expect(await page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) }))).toMatchObject({ local: [] });

      await page.getByLabel("New project name").fill("Browser journey");
      await page.getByRole("button", { name: "Create" }).click();
      await page.getByRole("link", { name: "Browser journey" }).click();
      await page.getByLabel("Target ID").fill("browser-target");
      await page.getByLabel("Target name").fill("Browser target");
      await page.getByLabel("Runner ID").fill("browser-runner");
      await page.getByRole("button", { name: "Create Target revision" }).click();
      await page.getByLabel("PRD title").fill("Browser requirements");
      const requirement = "Customers can complete checkout.";
      await page.getByLabel("PRD content").fill(requirement);
      await page.getByRole("button", { name: "Ingest PRD" }).click();
      await page.getByRole("link", { name: "r1: Browser requirements" }).click();

      const sourceRef = { prdId: "browser-journey", revision: 1, startOffset: 0, endOffset: requirement.length, quotedTextSha256: createHash("sha256").update(requirement).digest("hex") };
      await page.getByLabel("Grounded Test Plan proposal JSON").fill(JSON.stringify({
        expectedClaims: [{ semanticKey: "checkout", statement: requirement, sourceRefs: [sourceRef], confidence: 1 }],
        testCases: [{ title: "Checkout", objective: "Verify checkout", preconditions: [], steps: [{ kind: "verify", claimSemanticKeys: ["checkout"] }], expectedClaimSemanticKeys: ["checkout"], sourceRefs: [sourceRef], priority: "high" }],
      }));
      await page.getByRole("button", { name: "Create draft Test Plan" }).click();
      await page.getByRole("link", { name: "Review created Test Plan" }).click();
      await page.getByRole("button", { name: "Approve (v1)" }).click();
      await page.getByLabel("Approved Target revision").selectOption("browser-target");
      await page.getByRole("button", { name: "Create Mission from snapshots" }).click();
      await page.getByRole("link", { name: "Open created Mission" }).click();
      await page.getByRole("button", { name: "Start Mission (v1)" }).click();
    });
  }, 90_000);
});

async function buildConsoleDist(): Promise<void> {
  if (process.platform === "win32") {
    await execFileAsync("cmd.exe", ["/d", "/s", "/c", "corepack pnpm --filter @qualigence/web-console run build"], { timeout: 120_000 });
    return;
  }
  await execFileAsync("corepack", ["pnpm", "--filter", "@qualigence/web-console", "run", "build"], { timeout: 120_000 });
}

async function startConsoleProxy(config: () => Record<string, unknown>, apiBaseUrl: () => string | undefined): Promise<Server> {
  const dist = join(process.cwd(), "apps/web-console/dist");
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path === "/runtime-config.js") {
      response.writeHead(200, { "content-type": "application/javascript", "cache-control": "no-store" }).end(`window.__QUALIGENCE_CONFIG__=${JSON.stringify(config()).replace(/</g, "\\u003c")};`);
      return;
    }
    if (path === "/api" || path.startsWith("/api/")) {
      const upstream = apiBaseUrl();
      if (upstream === undefined) return response.writeHead(503).end();
      const target = `${upstream}${path.slice(4)}${new URL(request.url ?? "/", "http://localhost").search}`;
      const headers = Object.fromEntries(Object.entries(request.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
      const method = request.method ?? "GET";
      const init = method === "GET" || method === "HEAD"
        ? { method, headers }
        : { method, headers, body: request };
      const upstreamResponse = await fetch(target, init);
      response.writeHead(upstreamResponse.status, Object.fromEntries(upstreamResponse.headers));
      response.end(Buffer.from(await upstreamResponse.arrayBuffer()));
      return;
    }
    const requested = path === "/" || path === "/auth/callback" ? "index.html" : normalize(path).replace(/^[/\\]+/, "");
    try {
      const body = await readFile(join(dist, requested));
      if (requested === "index.html") {
        const html = body.toString("utf8").replace("</head>", `<script src="/runtime-config.js"></script></head>`);
        response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" }).end(html);
      } else {
        const contentType = requested.endsWith(".js") ? "application/javascript" : requested.endsWith(".css") ? "text/css" : "application/octet-stream";
        response.writeHead(200, { "content-type": contentType }).end(body);
      }
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return server;
}

function serverUrl(server: Server): string {
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("Console proxy did not bind a TCP address");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (server === undefined) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))).catch(() => undefined);
}

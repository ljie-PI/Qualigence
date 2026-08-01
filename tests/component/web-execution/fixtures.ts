import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface FixtureServer {
  readonly origin: string;
  readonly url: string;
  close(): Promise<void>;
}

/**
 * Serves fixed HTML routes over loopback HTTP so component tests can exercise
 * real same-origin / cross-origin navigation with an actual Chromium instance.
 * Uses only the Node standard library — no extra runtime dependency.
 */
export async function startFixtureServer(
  routes: Record<string, string>,
): Promise<FixtureServer> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    const body = routes[path];
    if (body === undefined) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(body);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;

  return {
    origin,
    url: `${origin}/`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

export function htmlDocument(body: string, title = "Fixture"): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
}

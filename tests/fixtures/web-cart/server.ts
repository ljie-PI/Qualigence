import Fastify, { type FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { renderCartPage, type CartMode } from "./page.js";
import type { FixtureHandle } from "../openai-compatible/mock-server.js";

export type { FixtureHandle };

/**
 * Serves the deterministic cart page over a loopback random port. The test
 * process owns the lifecycle: it starts the server, probes `/health` and
 * terminates it, recycling the port. No fixed port, sleep or public URL.
 */
export async function startCartFixture(mode: CartMode): Promise<FixtureHandle> {
  const app: FastifyInstance = Fastify();
  const html = renderCartPage(mode);

  app.get("/health", async () => ({ status: "ok" }));
  app.get("/", async (_request, reply) =>
    reply.code(200).header("content-type", "text/html; charset=utf-8").send(html),
  );

  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: async () => {
      await app.close();
    },
  };
}

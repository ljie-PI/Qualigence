import { afterEach, describe, expect, it } from "vitest";
import { startCartFixture, type FixtureHandle } from "../../fixtures/web-cart/server.js";
import { CART_ORACLE } from "../../fixtures/web-cart/page.js";

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  return response.text();
}

describe("cart fixture", () => {
  const open: FixtureHandle[] = [];

  afterEach(async () => {
    while (open.length > 0) {
      await open.pop()?.close();
    }
  });

  async function start(mode: "normal" | "fault"): Promise<FixtureHandle> {
    const handle = await startCartFixture(mode);
    open.push(handle);
    return handle;
  }

  it("serves the fault cart page with the constant $19 item price", async () => {
    const cart = await start("fault");
    const html = await fetchText(cart.url);
    expect(html).toContain(CART_ORACLE.itemPrice);
    expect(html).toContain(CART_ORACLE.totalBefore);
  });

  it("exposes a /health probe on a loopback random port", async () => {
    const cart = await start("normal");
    expect(cart.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const health = await fetch(new URL("/health", cart.url));
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });
  });

  it("bakes the buggy $29 total only into fault mode", async () => {
    const normal = await start("normal");
    const fault = await start("fault");
    expect(await fetchText(normal.url)).toContain('"$19"');
    expect(await fetchText(fault.url)).toContain('"$29"');
  });

  it("recycles the port so sequential fixtures start cleanly", async () => {
    const first = await startCartFixture("normal");
    await first.close();
    const second = await start("normal");
    expect(await (await fetch(new URL("/health", second.url))).json()).toEqual({
      status: "ok",
    });
  });
});

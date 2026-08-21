// @vitest-environment jsdom
import { createHash } from "node:crypto";
// React is intentionally loaded from the Console's isolated dependency tree.
// @ts-expect-error the root test project does not own the Console's React types
import { createElement } from "../../../apps/web-console/node_modules/react/index.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "../../../apps/web-console/node_modules/@tanstack/react-query/build/modern/index.js";
import { RouterProvider } from "../../../apps/web-console/node_modules/@tanstack/react-router/dist/esm/index.js";
// @ts-expect-error the root test project does not own the Console's Testing Library types
import { cleanup, render, screen, waitFor, within } from "../../../apps/web-console/node_modules/@testing-library/react/dist/@testing-library/react.esm.js";
// @ts-expect-error the root test project does not own the Console's user-event types
import userEvent from "../../../apps/web-console/node_modules/@testing-library/user-event/dist/esm/index.js";
import { PublicApiClient } from "../../../apps/web-console/src/api/client.js";
// @ts-expect-error the root test project does not compile Console JSX
import { ConsoleServicesProvider } from "../../../apps/web-console/src/auth/session-context.js";
import { MemoryTokenStore } from "../../../apps/web-console/src/auth/memory-token-store.js";
// @ts-expect-error the root test project does not compile Console JSX
import { router } from "../../../apps/web-console/src/routes/router.js";
import { dockerAvailable } from "../../helpers/docker-container.js";
import { setupServerFixture, type ServerFixture } from "../../helpers/server-fixture.js";

if (!dockerAvailable()) {
  throw new Error("DockerUnavailable: Web Console Target/Test Plan E2E requires Docker.");
}

(globalThis as unknown as { window: { scrollTo: () => void } }).window.scrollTo = vi.fn();

describe("rendered Web Console Target to Test Plan to Mission acceptance", () => {
  let fx: ServerFixture;
  let client: PublicApiClient;
  let queryClient: QueryClient;

  beforeAll(async () => {
    fx = await setupServerFixture();
    const tokens = new MemoryTokenStore();
    tokens.set({
      subject: "acceptance-tester",
      tenantId: "tenant-a",
      roles: ["tester"],
      accessToken: fx.token("tenant-a", ["tester"]),
      expiresAtMs: Date.now() + 3_600_000,
    });
    client = new PublicApiClient({ baseUrl: fx.baseUrl, accessToken: () => tokens.accessToken() });
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 5_000 } } });
    const services = { tokens, api: client, queryClient, oidc: {}, config: {} } as never;

    await client.createProject({ name: "Checkout acceptance" }, { idempotencyKey: "acceptance-project" });
    await client.ingestPrd(
      "acceptance-project",
      { title: "Checkout requirements", content: "The checkout page shows the total." },
      { idempotencyKey: "acceptance-prd" },
    );
    await router.navigate({ to: "/projects/$projectId", params: { projectId: "acceptance-project" } });
    render(createElement(QueryClientProvider, { client: queryClient }, createElement(ConsoleServicesProvider, { services }, createElement(RouterProvider, { router }))));
  }, 180_000);

  afterAll(async () => {
    cleanup();
    queryClient?.clear();
    await fx?.stop();
  });

  it("uses visible product forms and navigation with a real Server conflict reload", async () => {
    const user = userEvent.setup();
    expect(await screen.findByRole("heading", { name: "Project acceptance-project" })).toBeTruthy();

    await user.type(screen.getByLabelText("Target ID"), "acceptance-web");
    await user.type(screen.getByLabelText("Target name"), "Checkout Web");
    await user.type(screen.getByLabelText("Runner ID"), "runner-web");
    await user.clear(screen.getByLabelText("Start URL"));
    await user.type(screen.getByLabelText("Start URL"), "https://shop.example.test/checkout");
    await user.click(screen.getByRole("button", { name: "Create Target revision" }));

    let webTarget = await screen.findByTestId("target-acceptance-web");
    expect(webTarget.textContent).toContain("v1");
    expect(webTarget.textContent).toContain("https://shop.example.test/checkout");
    await user.click(within(webTarget.parentElement!).getByRole("button", { name: "Revise v1" }));
    await user.clear(screen.getByLabelText("Target name"));
    await user.type(screen.getByLabelText("Target name"), "Checkout Web revised");
    await user.clear(screen.getByLabelText("Start URL"));
    await user.type(screen.getByLabelText("Start URL"), "https://shop.example.test/checkout-v2");
    await user.click(screen.getByRole("button", { name: "Update Target revision" }));
    await waitFor(() => {
      webTarget = screen.getByTestId("target-acceptance-web");
      expect(webTarget.textContent).toContain("Checkout Web revised");
      expect(within(webTarget.parentElement!).getByRole("button", { name: "Revise v2" })).toBeTruthy();
    });

    await user.type(screen.getByLabelText("Target ID"), "acceptance-desktop");
    await user.type(screen.getByLabelText("Target name"), "Checkout Desktop");
    await user.type(screen.getByLabelText("Runner ID"), "runner-desktop");
    await user.selectOptions(screen.getByLabelText("Target kind"), "desktop");
    await user.clear(screen.getByLabelText("Desktop executable"));
    await user.type(screen.getByLabelText("Desktop executable"), "C:\\Apps\\Checkout\\Checkout.exe");
    await user.click(screen.getByRole("button", { name: "Create Target revision" }));

    let desktopTarget = await screen.findByTestId("target-acceptance-desktop");
    expect(desktopTarget.textContent).toContain("v1");
    expect(desktopTarget.textContent).toContain("Checkout.exe");
    await user.click(within(desktopTarget.parentElement!).getByRole("button", { name: "Revise v1" }));
    await user.clear(screen.getByLabelText("Desktop executable"));
    await user.type(screen.getByLabelText("Desktop executable"), "C:\\Apps\\Checkout\\Checkout-v2.exe");
    await user.click(screen.getByRole("button", { name: "Update Target revision" }));
    await waitFor(() => {
      desktopTarget = screen.getByTestId("target-acceptance-desktop");
      expect(desktopTarget.textContent).toContain("Checkout-v2.exe");
      expect(within(desktopTarget.parentElement!).getByRole("button", { name: "Revise v2" })).toBeTruthy();
    });

    const staleWebTarget = await client.getTarget("acceptance-web", "acceptance-project");
    expect(staleWebTarget?.version).toBe(2);
    await client.createTarget("acceptance-project", {
      targetId: "acceptance-web",
      displayName: "Checkout Web server revision",
      runnerId: "runner-web",
      expectedVersion: 2,
      configuration: staleWebTarget!.configuration,
    }, { idempotencyKey: "acceptance-web-competing-revision" });

    await user.click(within(webTarget.parentElement!).getByRole("button", { name: "Revise v2" }));
    await user.click(screen.getByRole("button", { name: "Update Target revision" }));
    expect((await screen.findByRole("alert")).textContent).toContain("current version 3");
    await waitFor(() => {
      webTarget = screen.getByTestId("target-acceptance-web");
      expect(webTarget.textContent).toContain("Checkout Web server revision");
      expect(within(webTarget.parentElement!).getByRole("button", { name: "Revise v3" })).toBeTruthy();
    });

    await user.click(screen.getByRole("link", { name: "r1: Checkout requirements" }));
    expect(await screen.findByRole("heading", { name: "PRD revision r1" })).toBeTruthy();
    const content = "The checkout page shows the total.";
    const sourceRef = {
      prdId: "acceptance-prd",
      revision: 1,
      startOffset: 0,
      endOffset: content.length,
      quotedTextSha256: createHash("sha256").update(content).digest("hex"),
    };
    const proposal = {
      expectedClaims: [{ semanticKey: "checkout.total", statement: content, sourceRefs: [sourceRef], confidence: 1 }],
      testCases: [{ title: "Checkout total", objective: "Verify checkout total", preconditions: [], steps: [{ kind: "verify", claimSemanticKeys: ["checkout.total"] }], expectedClaimSemanticKeys: ["checkout.total"], sourceRefs: [sourceRef], priority: "high" }],
    };
    await user.click(screen.getByLabelText("Grounded Test Plan proposal JSON"));
    await user.paste(JSON.stringify(proposal));
    await user.click(screen.getByRole("button", { name: "Create draft Test Plan" }));
    await user.click(await screen.findByRole("link", { name: "Review created Test Plan" }));

    expect(await screen.findByText("Checkout total")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Approve (v1)" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Approve (v1)" })).toBeNull());
    await screen.findByRole("option", { name: "Checkout Web server revision v3 · runner-web" });
    await user.selectOptions(screen.getByLabelText("Approved Target revision"), "acceptance-web");
    await user.click(screen.getByRole("button", { name: "Create Mission from snapshots" }));
    await user.click(await screen.findByRole("link", { name: "Open created Mission" }));

    const missionHeading = await screen.findByRole("heading", { name: /^Mission / });
    expect(missionHeading).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByText("acceptance-web")).toBeTruthy();
      expect(screen.getByText(/^v3 \(/)).toBeTruthy();
      expect(screen.getByText("runner-web")).toBeTruthy();
    });
  }, 60_000);
});

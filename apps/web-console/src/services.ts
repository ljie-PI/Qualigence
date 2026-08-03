import { QueryClient } from "@tanstack/react-query";
import { PublicApiClient } from "./api/client.js";
import { BrowserOidcController } from "./auth/browser-oidc.js";
import { MemoryTokenStore } from "./auth/memory-token-store.js";
import type { ConsoleServices } from "./auth/session-context.js";
import { loadRuntimeConfig } from "./config.js";

/** Wire the singleton Console services once at boot from runtime config. */
export function createConsoleServices(): ConsoleServices {
  const config = loadRuntimeConfig();
  const tokens = new MemoryTokenStore();
  const api = new PublicApiClient({
    baseUrl: config.apiBaseUrl,
    accessToken: () => tokens.accessToken(),
  });
  const oidc = new BrowserOidcController(config, tokens);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 5_000 } },
  });
  return { config, tokens, api, oidc, queryClient };
}

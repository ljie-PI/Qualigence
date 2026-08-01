import { createContext, useCallback, useContext, useSyncExternalStore, type ReactNode } from "react";
import type { QueryClient } from "@tanstack/react-query";
import type { PublicApiClient } from "../api/client.js";
import type { ConsoleRuntimeConfig } from "../config.js";
import type { BrowserOidcController } from "./browser-oidc.js";
import type { ConsoleSession, MemoryTokenStore } from "./memory-token-store.js";

/** The singleton services wired once at boot and shared through React context. */
export interface ConsoleServices {
  readonly tokens: MemoryTokenStore;
  readonly api: PublicApiClient;
  readonly oidc: BrowserOidcController;
  readonly config: ConsoleRuntimeConfig;
  readonly queryClient: QueryClient;
}

const ServicesContext = createContext<ConsoleServices | null>(null);

export function ConsoleServicesProvider(props: {
  readonly services: ConsoleServices;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <ServicesContext.Provider value={props.services}>{props.children}</ServicesContext.Provider>
  );
}

export function useServices(): ConsoleServices {
  const services = useContext(ServicesContext);
  if (services === null) {
    throw new Error("useServices must be used within a ConsoleServicesProvider");
  }
  return services;
}

/** Reactively read the current in-memory session (re-renders on login/logout). */
export function useSession(): ConsoleSession | undefined {
  const { tokens } = useServices();
  return useSyncExternalStore(
    (listener) => tokens.subscribe(listener),
    () => tokens.get(),
    () => tokens.get(),
  );
}

export interface AuthController {
  readonly session: ConsoleSession | undefined;
  readonly isAuthenticated: boolean;
  login(): Promise<void>;
  logout(): void;
}

export function useAuth(): AuthController {
  const services = useServices();
  const session = useSession();
  const login = useCallback(() => services.oidc.beginLogin(), [services]);
  const logout = useCallback(() => {
    services.oidc.logout();
    // Drop every cached query so no tenant data survives a logout.
    services.queryClient.clear();
  }, [services]);
  return { session, isAuthenticated: session !== undefined, login, logout };
}

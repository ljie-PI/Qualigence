import { useEffect, useRef, useState, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { ConsoleServicesProvider, useAuth } from "./auth/session-context.js";
import { router } from "./routes/router.js";
import { createConsoleServices } from "./services.js";
import type { ConsoleServices } from "./auth/session-context.js";

function Login(): ReactNode {
  const { login } = useAuth();
  return (
    <div className="login">
      <h1>Qualigence Console</h1>
      <p>Sign in with your organization identity provider to continue.</p>
      <button type="button" onClick={() => void login()}>
        Sign in with SSO
      </button>
    </div>
  );
}

function Gate(): ReactNode {
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) {
    return <Login />;
  }
  return <RouterProvider router={router} />;
}

/**
 * Root application: builds the singleton services once, completes any pending
 * OIDC callback on boot (installing the in-memory session and scrubbing the
 * code/state from the URL), then renders either the login gate or the router.
 */
export function App(): ReactNode {
  const servicesRef = useRef<ConsoleServices | undefined>(undefined);
  servicesRef.current ??= createConsoleServices();
  const services = servicesRef.current;
  const callbackCompletionRef = useRef<Promise<boolean | undefined> | undefined>(undefined);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // StrictMode re-runs effects while retaining refs. Share this completion
    // promise so one callback URL can consume its one-use code only once.
    const completion = callbackCompletionRef.current ??= services.oidc.handleCallbackIfPresent()
      .catch(() => undefined);
    void completion.finally(() => {
      if (!cancelled) {
        setReady(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [services]);

  return (
    <QueryClientProvider client={services.queryClient}>
      <ConsoleServicesProvider services={services}>
        {ready ? <Gate /> : <div className="booting">Loading…</div>}
      </ConsoleServicesProvider>
    </QueryClientProvider>
  );
}

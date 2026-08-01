/**
 * A {@link DesktopEnvironmentProvider} that brokers the whole process lifecycle
 * through the Companion. It NEVER calls a Node process API for the target: it
 * only sends `app.launch` / `app.reset` / `app.shutdown` IPC requests and holds
 * the opaque {@link AppSession} the Companion returns (which exposes only a
 * process-group id, never a native Job handle).
 */

import {
  validateAppTarget,
  type AppSession,
  type AppTarget,
  type DesktopEnvironmentProvider,
} from "@qualigence/desktop-contracts";
import type { CompanionClient } from "./companion-client.js";

export class AppEnvironmentProvider implements DesktopEnvironmentProvider {
  constructor(private readonly companion: CompanionClient) {}

  async launch(target: AppTarget): Promise<AppSession> {
    // Re-validate defensively: only a canonical, argv-based AppTarget is ever
    // handed to the Companion.
    const canonical = validateAppTarget(target);
    return this.companion.launch(canonical);
  }

  async reset(session: AppSession): Promise<void> {
    await this.companion.reset(session.sessionId);
  }

  async shutdown(session: AppSession): Promise<void> {
    await this.companion.shutdown(session.sessionId);
  }
}

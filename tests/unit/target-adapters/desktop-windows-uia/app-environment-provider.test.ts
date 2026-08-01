import { describe, expect, it } from "vitest";
import { validateAppTarget, type AppSession, type AppTarget } from "@qualigence/desktop-contracts";
import {
  AppEnvironmentProvider,
  type CompanionClient,
} from "@qualigence/desktop-windows-uia";

function makeTarget(): AppTarget {
  return validateAppTarget({
    targetId: "reference-app",
    platform: "windows",
    launch: { executable: "C:\\Apps\\ReferenceApp.exe", args: ["--kiosk"] },
    process: { expectedImageName: "ReferenceApp.exe", allowedChildImageNames: [] },
    window: {},
    reset: { command: "C:\\Apps\\reset.exe", args: [], timeoutMs: 5000 },
    shutdown: { gracefulTimeoutMs: 3000, forceAfterTimeout: true },
  });
}

class RecordingCompanion implements CompanionClient {
  readonly calls: string[] = [];
  session: AppSession = {
    sessionId: "sess-1",
    processId: 4242,
    processCreationTime: "2026-08-02T00:00:01.000Z",
    processGroupId: "pg-opaque",
    rootWindowHandle: "0x00010",
    startedAt: "2026-08-02T00:00:01.000Z",
  };

  async launch(target: AppTarget): Promise<AppSession> {
    this.calls.push(`launch:${target.targetId}`);
    return this.session;
  }
  async reset(sessionId: string): Promise<void> {
    this.calls.push(`reset:${sessionId}`);
  }
  async shutdown(sessionId: string): Promise<void> {
    this.calls.push(`shutdown:${sessionId}`);
  }
  async capture(): Promise<never> {
    throw new Error("not used");
  }
  async requestPermit(): Promise<never> {
    throw new Error("not used");
  }
  async execute(): Promise<never> {
    throw new Error("not used");
  }
}

describe("AppEnvironmentProvider", () => {
  it("launches a target only by brokering app.launch through the Companion", async () => {
    const companion = new RecordingCompanion();
    const provider = new AppEnvironmentProvider(companion);

    const session = await provider.launch(makeTarget());

    expect(session.processId).toBe(4242);
    // It exposes only an opaque process-group id, never a native handle.
    expect(session.processGroupId).toBe("pg-opaque");
    expect(companion.calls).toEqual(["launch:reference-app"]);
  });

  it("resets and shuts down by session id through the Companion", async () => {
    const companion = new RecordingCompanion();
    const provider = new AppEnvironmentProvider(companion);
    const session = await provider.launch(makeTarget());

    await provider.reset(session);
    await provider.shutdown(session);

    expect(companion.calls).toEqual(["launch:reference-app", "reset:sess-1", "shutdown:sess-1"]);
  });

  it("rejects a non-canonical AppTarget before touching the Companion", async () => {
    const companion = new RecordingCompanion();
    const provider = new AppEnvironmentProvider(companion);

    await expect(
      provider.launch({
        targetId: "bad",
        platform: "windows",
        launch: { executable: "cmd.exe /c evil", args: [] },
        process: { expectedImageName: "ReferenceApp.exe", allowedChildImageNames: [] },
        window: {},
        reset: { command: "C:\\Apps\\reset.exe", args: [], timeoutMs: 5000 },
        shutdown: { gracefulTimeoutMs: 3000, forceAfterTimeout: true },
      } as unknown as AppTarget),
    ).rejects.toThrow();
    expect(companion.calls).toEqual([]);
  });
});

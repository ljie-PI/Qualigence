import type { AcceptedExecutionJob } from "@qualigence/runner-protocol";
import {
  DESKTOP_UIA_V1_CAPABILITY_TOKENS,
  WEB_OBSERVATION_V1_CAPABILITY_TOKENS,
} from "@qualigence/runner-protocol";
import type {
  ActionExecutor,
  ActionResolver,
  AnyProposedAction,
  ExecutionTargetErrorStatus,
  Observer,
  ResolvedAction,
  Verifier,
} from "@qualigence/runner-kernel";
import { ExecutionTargetError } from "@qualigence/runner-kernel";
import { PlaywrightWebTargetAdapter } from "@qualigence/web-playwright";
import {
  AppEnvironmentProvider,
  DesktopExecutionError,
  UiaActionExecutor,
  UiaActionResolver,
  WindowsDesktopAdapter,
  type CompanionClient,
} from "@qualigence/desktop-windows-uia";
import type { RunnerConfig } from "./config.js";
import type { ActionValueProvider } from "./action-value-provider.js";

export interface TargetRuntimeResourceSet {
  readonly observer: Observer;
  readonly resolver: ActionResolver;
  readonly actionExecutor: ActionExecutor;
  readonly verifier: Verifier;
  close(): Promise<void>;
}

export interface DesktopCompanionRuntimeClient extends CompanionClient {
  authenticate?(): Promise<void>;
  probe?(): Promise<void>;
  close?(): void;
}

export interface TargetRuntimeFactoryOptions {
  readonly config: RunnerConfig;
  readonly verifier: Verifier;
  readonly valueProvider?: ActionValueProvider;
  readonly companion?: DesktopCompanionRuntimeClient;
  readonly platform?: NodeJS.Platform;
  readonly createWebTarget?: (options: ConstructorParameters<typeof PlaywrightWebTargetAdapter>[0]) => PlaywrightWebTargetAdapter;
}

class DesktopObserver implements Observer {
  constructor(
    private readonly adapter: WindowsDesktopAdapter,
    private readonly sessionId: string,
    private readonly deadlineMs: number,
  ) {}

  async capture(): ReturnType<Observer["capture"]> {
    return this.adapter.capture({ sessionId: this.sessionId, deadlineMs: this.deadlineMs });
  }
}

class DesktopResolver implements ActionResolver {
  private sequence = 0;
  private readonly resolver = new UiaActionResolver();

  constructor(private readonly runId: string) {}

  async resolve(action: AnyProposedAction, graph: Parameters<ActionResolver["resolve"]>[1]): Promise<ResolvedAction> {
    try {
      this.sequence += 1;
      return this.resolver.resolve(action, graph, { actionId: `${this.runId}:action:${this.sequence}` });
    } catch (error) {
      throw mapDesktopOpenError(error, "blocked");
    }
  }
}

export class TargetRuntimeFactory {
  private readonly createWebTarget: NonNullable<TargetRuntimeFactoryOptions["createWebTarget"]>;
  private readonly platform: NodeJS.Platform;

  constructor(private readonly options: TargetRuntimeFactoryOptions) {
    this.createWebTarget = options.createWebTarget ?? ((targetOptions) => new PlaywrightWebTargetAdapter(targetOptions));
    this.platform = options.platform ?? process.platform;
  }

  async open(job: AcceptedExecutionJob, signal?: AbortSignal): Promise<TargetRuntimeResourceSet> {
    switch (job.target.kind) {
      case "web":
        return this.openWeb(job, signal);
      case "desktop":
        return this.openDesktop(job, signal);
    }
  }

  private async openWeb(job: AcceptedExecutionJob, signal?: AbortSignal): Promise<TargetRuntimeResourceSet> {
    assertWebJob(job);
    const targetUrl = job.target.url;
    const target = this.createWebTarget({
      url: targetUrl,
      expectedOrigin: new URL(targetUrl).origin,
      headed: this.options.config.headed,
      navigationTimeoutMs: this.options.config.navigationTimeoutMs,
      actionTimeoutMs: this.options.config.actionTimeoutMs,
      allowedOrigins: job.policy.allowedOrigins,
      ...(this.options.valueProvider === undefined ? {} : { valueProvider: this.options.valueProvider }),
    });
    try {
      await target.start(signal);
      return {
        observer: target,
        resolver: target,
        actionExecutor: target,
        verifier: this.options.verifier,
        close: () => target.close(),
      };
    } catch (error) {
      await closeIgnoring(target);
      throw error;
    }
  }

  private async openDesktop(job: AcceptedExecutionJob, _signal?: AbortSignal): Promise<TargetRuntimeResourceSet> {
    if (job.target.kind !== "desktop") throw new ExecutionTargetError("CapabilityMismatch", "blocked");
    const target = job.target;
    if (this.platform !== "win32") {
      throw new ExecutionTargetError("CapabilityMismatch", "blocked", "Desktop UIA targets require Windows");
    }
    const companion = this.options.companion;
    if (companion === undefined) {
      throw new ExecutionTargetError("CompanionUnavailable", "blocked", "Desktop Companion is not configured");
    }
    try {
      await companion.authenticate?.();
      await companion.probe?.();
      const provider = new AppEnvironmentProvider(companion);
      const session = await provider.launch(target.app);
      let closed = false;
      return {
        observer: new DesktopObserver(new WindowsDesktopAdapter(companion), session.sessionId, this.options.config.actionTimeoutMs),
        resolver: new DesktopResolver(job.runId),
        actionExecutor: new UiaActionExecutor(companion, {
          sessionId: session.sessionId,
          runId: job.runId,
          deadlineMs: this.options.config.actionTimeoutMs,
          ...(this.options.valueProvider === undefined ? {} : { valueProvider: this.options.valueProvider }),
        }),
        verifier: this.options.verifier,
        close: async () => {
          if (closed) return;
          closed = true;
          try {
            await provider.shutdown(session);
          } finally {
            companion.close?.();
          }
        },
      };
    } catch (error) {
      throw mapDesktopOpenError(error, error instanceof DesktopExecutionError && error.code === "ActionOutcomeUnknown" ? "error" : "blocked");
    }
  }
}

function assertWebJob(job: AcceptedExecutionJob): asserts job is AcceptedExecutionJob & { readonly target: { readonly kind: "web"; readonly url: string } } {
  if (job.target.kind !== "web") throw new ExecutionTargetError("CapabilityMismatch", "blocked");
}

function mapDesktopOpenError(error: unknown, status: ExecutionTargetErrorStatus): Error {
  if (error instanceof ExecutionTargetError) return error;
  const code = typeof (error as { readonly code?: unknown })?.code === "string"
    ? String((error as { readonly code: string }).code)
    : "CompanionUnavailable";
  if (code === "CompanionUnavailable" || code === "CompanionUnauthenticated" || code === "CompanionIdentityRejected") {
    return new ExecutionTargetError("CompanionUnavailable", "blocked", "Desktop Companion is unavailable");
  }
  if (code === "ActionOutcomeUnknown") {
    return new ExecutionTargetError("ActionOutcomeUnknown", "error", "Desktop action outcome is unknown");
  }
  return new ExecutionTargetError(
    code === "PlanDiverged" || code === "UiaPatternUnsupported" || code === "UnsupportedTargetKind" ? "CapabilityMismatch" : code,
    status,
  );
}

async function closeIgnoring(target: { close(): Promise<void> }): Promise<void> {
  try {
    await target.close();
  } catch {
    // Preserve the original startup/open failure.
  }
}

export { DESKTOP_UIA_V1_CAPABILITY_TOKENS, WEB_OBSERVATION_V1_CAPABILITY_TOKENS };

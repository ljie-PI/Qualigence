import type {
  AcceptedExecutionJob,
  ObservationGraphV1,
} from "@qualigence/runner-protocol";
import type {
  ActionExecutor,
  ActionOutcome,
  ActionResolver,
  AnyProposedAction,
  AnyResolvedAction,
  AnyResolvedWebAction,
  ExecutionPermit,
  Observer,
  ProposedAction,
  ResolvedAction,
  ResolvedWebAction,
} from "@qualigence/runner-kernel";
import {
  PlaywrightBrowserSession,
  WebTargetError,
  type BrowserLauncher,
  type WebSessionOptions,
} from "./browser-session.js";
import { PlaywrightObserver } from "./playwright-observer.js";
import { PlaywrightActionResolver } from "./playwright-action-resolver.js";
import { PlaywrightActionExecutor, type ActionValueProvider } from "./playwright-action-executor.js";
import type { CapturedArtifact } from "./types.js";

export interface WebTargetSession {
  start(signal?: AbortSignal): Promise<void>;
  captureArtifacts(graphId: string): Promise<readonly CapturedArtifact[]>;
  close(): Promise<void>;
}

export interface PlaywrightWebTargetOptions extends WebSessionOptions {
  readonly valueProvider?: ActionValueProvider;
}

/**
 * Composition-root facade wiring the isolated Session, Observer, Resolver and
 * Executor internals together. It only coordinates and enforces serialized
 * access; the actual observation/resolution/execution algorithms stay in their
 * dedicated collaborators. No Playwright object is exposed here.
 */
export class PlaywrightWebTargetAdapter
  implements Observer, ActionResolver<import("@qualigence/runner-kernel").ProposedActionKind>, ActionExecutor, WebTargetSession
{
  private readonly session: PlaywrightBrowserSession;
  private readonly observer: PlaywrightObserver;
  private readonly resolver: PlaywrightActionResolver;
  private readonly executor: PlaywrightActionExecutor;
  private busy = false;
  private closed = false;

  constructor(options: PlaywrightWebTargetOptions, launcher?: BrowserLauncher) {
    this.session = new PlaywrightBrowserSession(options, launcher);
    this.observer = new PlaywrightObserver(this.session);
    this.resolver = new PlaywrightActionResolver(this.session);
    this.executor = new PlaywrightActionExecutor(this.session, options.valueProvider);
  }

  async start(signal?: AbortSignal): Promise<void> {
    await this.session.start(signal);
  }

  async capture(job: AcceptedExecutionJob, signal?: AbortSignal): Promise<ObservationGraphV1> {
    signal?.throwIfAborted();
    return this.guard(() => this.observer.capture(job));
  }

  resolve(
    action: ProposedAction,
    graph: ObservationGraphV1,
    signal?: AbortSignal,
  ): Promise<ResolvedWebAction>;
  resolve(
    action: AnyProposedAction,
    graph: ObservationGraphV1,
    signal?: AbortSignal,
  ): Promise<AnyResolvedWebAction>;
  async resolve(
    action: AnyProposedAction,
    graph: ObservationGraphV1,
    signal?: AbortSignal,
  ): Promise<AnyResolvedWebAction> {
    signal?.throwIfAborted();
    return this.guard(() => this.resolver.resolve(action, graph));
  }

  execute(
    action: ResolvedAction,
    permit: ExecutionPermit,
    signal?: AbortSignal,
  ): Promise<ActionOutcome>;
  execute(
    action: AnyResolvedAction,
    permit: ExecutionPermit,
    signal?: AbortSignal,
  ): Promise<ActionOutcome>;
  async execute(
    action: AnyResolvedAction,
    permit: ExecutionPermit,
    signal?: AbortSignal,
  ): Promise<ActionOutcome> {
    signal?.throwIfAborted();
    return this.guard(() => this.executor.execute(action, permit, signal));
  }

  async captureArtifacts(graphId: string): Promise<readonly CapturedArtifact[]> {
    return this.guard(() => this.session.withPage(async (page) => {
      this.session.assertPageTargetOrigin(page);
      const artifacts = this.session.artifactsFor(graphId);
      this.session.assertPageTargetOrigin(page);
      return artifacts;
    }));
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.session.close();
  }

  private async guard<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) {
      throw new WebTargetError("SessionClosed", "The session is closed.");
    }
    if (this.busy) {
      throw new WebTargetError(
        "ConcurrentSessionOperation",
        "Another target operation is already in progress.",
      );
    }
    this.busy = true;
    try {
      return await operation();
    } finally {
      this.busy = false;
    }
  }
}

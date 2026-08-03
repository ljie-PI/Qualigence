import type {
  AcceptedExecutionJob,
  ObservationGraph,
} from "@qualigence/runner-protocol";
import type {
  ActionExecutor,
  ActionOutcome,
  ActionResolver,
  ExecutionPermit,
  Observer,
  ProposedAction,
  ResolvedAction,
} from "@qualigence/runner-kernel";
import {
  PlaywrightBrowserSession,
  WebTargetError,
  type BrowserLauncher,
  type WebSessionOptions,
} from "./browser-session.js";
import { PlaywrightObserver } from "./playwright-observer.js";
import { PlaywrightActionResolver } from "./playwright-action-resolver.js";
import { PlaywrightActionExecutor } from "./playwright-action-executor.js";
import type { CapturedArtifact } from "./types.js";

export interface WebTargetSession {
  start(): Promise<void>;
  captureArtifacts(graphId: string): Promise<readonly CapturedArtifact[]>;
  close(): Promise<void>;
}

/**
 * Composition-root facade wiring the isolated Session, Observer, Resolver and
 * Executor internals together. It only coordinates and enforces serialized
 * access; the actual observation/resolution/execution algorithms stay in their
 * dedicated collaborators. No Playwright object is exposed here.
 */
export class PlaywrightWebTargetAdapter
  implements Observer, ActionResolver, ActionExecutor, WebTargetSession
{
  private readonly session: PlaywrightBrowserSession;
  private readonly observer: PlaywrightObserver;
  private readonly resolver: PlaywrightActionResolver;
  private readonly executor: PlaywrightActionExecutor;
  private busy = false;
  private closed = false;

  constructor(options: WebSessionOptions, launcher?: BrowserLauncher) {
    this.session = new PlaywrightBrowserSession(options, launcher);
    this.observer = new PlaywrightObserver(this.session);
    this.resolver = new PlaywrightActionResolver(this.session);
    this.executor = new PlaywrightActionExecutor(this.session);
  }

  async start(): Promise<void> {
    await this.session.start();
  }

  async capture(job: AcceptedExecutionJob): Promise<ObservationGraph> {
    return this.guard(() => this.observer.capture(job));
  }

  async resolve(
    action: ProposedAction,
    graph: ObservationGraph,
  ): Promise<ResolvedAction> {
    return this.guard(() => this.resolver.resolve(action, graph));
  }

  async execute(
    action: ResolvedAction,
    permit: ExecutionPermit,
  ): Promise<ActionOutcome> {
    return this.guard(() => this.executor.execute(action, permit));
  }

  async captureArtifacts(graphId: string): Promise<readonly CapturedArtifact[]> {
    return this.guard(async () => this.session.artifactsFor(graphId));
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

import type {
  RunnerHello,
  RunnerWelcome,
  ResumeToken,
} from "@qualigence/runner-protocol";
import type {
  RunnerClientPort,
  RunnerSession,
} from "@qualigence/grpc-runner-protocol";
import type { RunnerSpool, SpoolBatchLimit } from "@qualigence/runner-spool";
import { RunnerAppError } from "./errors.js";
import type { LeasedJobExecutor } from "./job-executor.js";
import { TraceUploadPump } from "./trace-upload-pump.js";

export interface RunnerClientDependencies {
  readonly clientPort: RunnerClientPort;
  /** Build the handshake; the resume token is supplied on reconnect. */
  readonly makeHello: (resumeToken?: ResumeToken) => RunnerHello;
  readonly executor: Pick<LeasedJobExecutor, "execute">;
  readonly spool: RunnerSpool;
}

export interface ServedOffer {
  readonly runId: string;
  readonly status: string;
}

/**
 * Drives the Runner side of a session (LS-05 design §5): connect, pull Offers,
 * execute each leased Job, and drain spooled Trace to Core. On a transport
 * failure the current session is dropped but the Spool still holds every
 * unacknowledged event; {@link RunnerClient.reconnect} re-establishes the session
 * with the single-use {@link ResumeToken} and {@link RunnerClient.replay} pushes
 * the spooled events back in order — losing none and duplicating none past the
 * Core cursor.
 */
export class RunnerClient {
  private session: RunnerSession | undefined;
  private resumeToken: ResumeToken | undefined;

  constructor(private readonly deps: RunnerClientDependencies) {}

  get activeSession(): RunnerSession | undefined {
    return this.session;
  }

  /** Establish the first session and remember the rotating resume token. */
  async connect(): Promise<RunnerWelcome> {
    const session = await this.deps.clientPort.connect(this.deps.makeHello());
    this.session = session;
    this.resumeToken = session.welcome.resumeToken;
    return session.welcome;
  }

  /** Re-establish a session after a disconnect, presenting the resume token. */
  async reconnect(): Promise<RunnerWelcome> {
    if (this.resumeToken === undefined) {
      throw new RunnerAppError("TransportError", "cannot reconnect before an initial connect");
    }
    const session = await this.deps.clientPort.connect(this.deps.makeHello(this.resumeToken));
    this.session = session;
    this.resumeToken = session.welcome.resumeToken;
    return session.welcome;
  }

  /** Accept and run the next offered Job, then drain its Trace to Core. */
  async serveNextOffer(signal: AbortSignal): Promise<ServedOffer> {
    const session = this.requireSession();
    const offer = await session.nextOffer(signal);
    const result = await this.deps.executor.execute(offer, session, signal);
    await this.drain(offer.job.runId);
    await session.complete(result.lease, result.completion);
    return { runId: offer.job.runId, status: result.completion.status };
  }

  /** Drain the spool for a Run to the active session; safe to call repeatedly. */
  async drain(runId: string): Promise<void> {
    const session = this.requireSession();
    const pump = new TraceUploadPump(this.deps.spool, session, runId, this.batchLimit(session));
    await pump.drain();
  }

  /** Replay all spooled Trace for a Run after a reconnect. */
  async replay(runId: string): Promise<void> {
    await this.drain(runId);
  }

  async close(): Promise<void> {
    if (this.session !== undefined) {
      await this.session.close();
      this.session = undefined;
    }
  }

  private requireSession(): RunnerSession {
    if (this.session === undefined) {
      throw new RunnerAppError("TransportError", "no active session; call connect() first");
    }
    return this.session;
  }

  private batchLimit(session: RunnerSession): SpoolBatchLimit {
    return {
      maximumEvents: session.welcome.traceBatchMaximumEvents,
      maximumBytes: session.welcome.traceBatchMaximumBytes,
    };
  }
}

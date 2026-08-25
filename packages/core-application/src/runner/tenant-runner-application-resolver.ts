import { TraceIngestor, type TraceStore } from "@qualigence/evidence";
import type {
  AuthenticatedRunnerContext,
  RunnerControlIntegrityEventSink,
  RunnerControlStore,
  RunnerProtocolApplication,
  RunnerProtocolApplicationResolver,
} from "@qualigence/runner-control";
import type { AcceptedExecutionJob, ExecutionCompletion } from "@qualigence/runner-protocol";
import { CoreApplicationError } from "./core-runner-protocol-application.js";
import type { RunCompletionSink } from "./core-runner-protocol-application.js";
import { CoreRunnerProtocolApplication } from "./core-runner-protocol-application.js";
import { ExecutionJobService } from "./execution-job-service.js";
import { RunOwnershipService } from "./run-ownership-service.js";
import { RunnerResumeTokenService } from "./runner-resume-token-service.js";
import {
  RunnerSessionService,
  type SessionWelcomeParameters,
} from "./runner-session-service.js";

export interface TenantRunnerApplicationGraph {
  readonly application: RunnerProtocolApplication;
  readonly store: RunnerControlStore;
  readonly traceStore: TraceStore;
}

export interface TenantRunnerApplicationResolverOptions {
  readonly welcome: SessionWelcomeParameters;
  /**
   * Must return a long-lived facade whose individual methods open short
   * tenant-scoped operations. It must not return a transaction-backed store tied
   * to an already-completed transaction.
   */
  readonly runnerControlStore: (tenantId: string) => RunnerControlStore;
  /** Same lifetime rule as {@link runnerControlStore}, for Trace ingestion. */
  readonly traceStore: (tenantId: string) => TraceStore;
  readonly integrityEvents: RunnerControlIntegrityEventSink;
  readonly now?: () => number;
  readonly leaseDurationMs?: number;
  readonly generateSessionId?: () => string;
  readonly generateOfferId?: () => string;
  readonly generateLeaseToken?: () => string;
  readonly generateRecoveryRunId?: () => string;
  readonly generateRecoveryJobId?: () => string;
  readonly completionSink?: RunCompletionSink;
  readonly recordRun?: (tenantId: string, job: AcceptedExecutionJob) => Promise<void>;
}

/**
 * Resolves each authenticated Self-hosted Runner to the tenant-local application
 * graph used for protocol sessions. Graphs are cached only at tenant granularity;
 * the stores injected into them are expected to be operation-scoped facades so a
 * long-lived connection never retains a PostgreSQL transaction or an unscoped
 * storage handle.
 */
export class TenantRunnerApplicationResolver implements RunnerProtocolApplicationResolver {
  private readonly graphs = new Map<string, TenantRunnerApplicationGraph>();

  constructor(private readonly options: TenantRunnerApplicationResolverOptions) {}

  resolve(identity: AuthenticatedRunnerContext): RunnerProtocolApplication {
    if (identity.scope.kind !== "tenant") {
      throw new CoreApplicationError(
        "RunIdentityMismatch",
        "Self-hosted Runner protocol requires an authenticated tenant scope",
      );
    }
    return this.graphForTenant(identity.scope.tenantId).application;
  }

  graphForTenant(tenantId: string): TenantRunnerApplicationGraph {
    const existing = this.graphs.get(tenantId);
    if (existing !== undefined) return existing;

    const store = this.options.runnerControlStore(tenantId);
    const traceStore = this.options.traceStore(tenantId);
    const ownership = new RunOwnershipService({
      store,
      integrityEvents: this.options.integrityEvents,
      ...(this.options.leaseDurationMs === undefined ? {} : { leaseDurationMs: this.options.leaseDurationMs }),
      ...(this.options.now === undefined ? {} : { now: this.options.now }),
      ...(this.options.generateLeaseToken === undefined ? {} : { generateToken: this.options.generateLeaseToken }),
      ...(this.options.generateRecoveryRunId === undefined ? {} : { generateRunId: this.options.generateRecoveryRunId }),
      ...(this.options.generateRecoveryJobId === undefined ? {} : { generateJobId: this.options.generateRecoveryJobId }),
    });
    const resumeTokens = new RunnerResumeTokenService({
      store,
      ...(this.options.now === undefined ? {} : { now: this.options.now }),
    });
    const sessions = new RunnerSessionService({
      store,
      welcome: this.options.welcome,
      resumeTokens,
      traceIngestor: new TraceIngestor(traceStore),
      ownership,
      ...(this.options.now === undefined ? {} : { now: this.options.now }),
      ...(this.options.generateSessionId === undefined ? {} : { generateSessionId: this.options.generateSessionId }),
    });
    const jobs = new ExecutionJobService(ownership, {
      store,
      ...(this.options.leaseDurationMs === undefined ? {} : { leaseDurationMs: this.options.leaseDurationMs }),
      ...(this.options.now === undefined ? {} : { now: this.options.now }),
      ...(this.options.generateOfferId === undefined ? {} : { generateOfferId: this.options.generateOfferId }),
    });
    const application = new CoreRunnerProtocolApplication({
      sessions,
      jobs,
      ownership,
      ...(this.options.completionSink === undefined ? {} : { completionSink: this.options.completionSink }),
      ...(this.options.recordRun === undefined
        ? {}
        : { recordRun: (job: AcceptedExecutionJob) => this.options.recordRun?.(tenantId, job) ?? Promise.resolve() }),
    });

    const graph = { application, store, traceStore };
    this.graphs.set(tenantId, graph);
    return graph;
  }
}

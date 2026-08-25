import type {
  AcceptedExecutionJob,
  ExecutionCompletion,
  ExecutionEventAck,
  ExecutionEventBatch,
  ExecutionJobLease,
  ExecutionJobOffer,
  RunnerHello,
  RunnerWelcome,
} from "@qualigence/runner-protocol";

export type RunnerAuthorizationScope =
  | { readonly kind: "local" }
  | {
      readonly kind: "tenant";
      readonly tenantId: string;
      readonly projectIds: readonly string[];
    };

export interface AuthenticatedRunnerContext {
  readonly runnerId: string;
  readonly certificateFingerprint: string;
  readonly scope: RunnerAuthorizationScope;
}

export interface RunnerProtocolApplication {
  openSession(
    hello: RunnerHello,
    identity: AuthenticatedRunnerContext,
  ): Promise<RunnerWelcome>;
  createOffer(
    sessionId: string,
    job: AcceptedExecutionJob,
    requirements: readonly string[],
  ): Promise<ExecutionJobOffer>;
  accept(sessionId: string, offerId: string): Promise<ExecutionJobLease>;
  renew(sessionId: string, lease: ExecutionJobLease): Promise<ExecutionJobLease>;
  ingest(sessionId: string, batch: ExecutionEventBatch): Promise<ExecutionEventAck>;
  complete(
    sessionId: string,
    lease: ExecutionJobLease,
    completion: ExecutionCompletion,
  ): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
}

export interface RunnerProtocolApplicationResolver {
  resolve(identity: AuthenticatedRunnerContext): Promise<RunnerProtocolApplication> | RunnerProtocolApplication;
}

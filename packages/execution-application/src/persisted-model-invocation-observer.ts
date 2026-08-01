import type {
  ModelInvocationStore,
  ModelInvocationSummary,
} from "@qualigence/evidence";
import type {
  ModelInvocationObserver,
  ModelInvocationReport,
} from "@qualigence/model-gateway";

/**
 * Adapts a provider-neutral {@link ModelInvocationReport} emitted by the Model
 * Gateway into the LS-01 {@link ModelInvocationSummary} and persists it. This
 * mapping lives in the application layer so the Model Gateway never depends on
 * the Evidence module. It records only audit metadata — never prompt messages
 * or raw model output.
 */
export class PersistedModelInvocationObserver implements ModelInvocationObserver {
  constructor(private readonly store: ModelInvocationStore) {}

  async record(report: ModelInvocationReport): Promise<void> {
    const summary: ModelInvocationSummary = {
      invocationId: report.context.invocationId,
      runId: report.context.runId,
      operation: report.operation,
      model: report.model,
      status: report.status,
      latencyMs: report.latencyMs,
      occurredAt: report.occurredAt,
      ...(report.inputTokens === undefined
        ? {}
        : { inputTokens: report.inputTokens }),
      ...(report.outputTokens === undefined
        ? {}
        : { outputTokens: report.outputTokens }),
      ...(report.providerRequestId === undefined
        ? {}
        : { providerRequestId: report.providerRequestId }),
      ...(report.errorCode === undefined ? {} : { errorCode: report.errorCode }),
    };
    await this.store.append(summary);
  }
}

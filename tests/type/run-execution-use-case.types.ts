import type {
  RunExecutionResult,
  RunExecutionUseCase,
} from "@qualigence/execution-application";

declare const useCase: RunExecutionUseCase;

export async function exerciseUseCaseTypes(): Promise<void> {
  const result = await useCase.execute({
    target: { kind: "web", url: "http://127.0.0.1:3000" },
    objective: "add one item",
    executionProfile: {
      modelProfileId: "default",
      headed: false,
      navigationTimeoutMs: 10_000,
      actionTimeoutMs: 5_000,
    },
  });
  result satisfies RunExecutionResult;
}

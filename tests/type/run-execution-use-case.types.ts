import type {
  RunExecutionResult,
  RunExecutionUseCase,
} from "@qualigence/execution-application";

declare const useCase: RunExecutionUseCase;

export async function exerciseUseCaseTypes(): Promise<void> {
  const result = await useCase.execute({
    projectId: "project-1",
    target: { kind: "web", url: "http://127.0.0.1:3000" },
    objective: "add one item",
    policy: { policyId: "policy-1", environment: "isolated_test", allowedOrigins: ["http://127.0.0.1:3000"], allowedActionKinds: ["click"], maximumRisk: "Normal", explorationAllowed: false, issuedAt: "2026-08-18T00:00:00.000Z", expiresAt: "2026-08-18T00:01:00.000Z" },
    executionProfile: {
      modelProfileId: "default",
      headed: false,
      navigationTimeoutMs: 10_000,
      actionTimeoutMs: 5_000,
    },
  });
  result satisfies RunExecutionResult;

  // @ts-expect-error RunExecutionRequest must reject a projectless value
  await useCase.execute({
    target: { kind: "web", url: "http://127.0.0.1:3000" },
    objective: "must not dispatch without project provenance",
    policy: { policyId: "policy-1", environment: "isolated_test", allowedOrigins: ["http://127.0.0.1:3000"], allowedActionKinds: ["click"], maximumRisk: "Normal", explorationAllowed: false, issuedAt: "2026-08-18T00:00:00.000Z", expiresAt: "2026-08-18T00:01:00.000Z" },
    executionProfile: { modelProfileId: "default", headed: false, navigationTimeoutMs: 10_000, actionTimeoutMs: 5_000 },
  });
}

import { PostgresPrdMissionRepository, type TenantTransactionProvider } from "@qualigence/postgres-runtime";
import type {
  AcceptedMissionDispatch,
  BlockedMissionDispatch,
  MissionDispatchAcceptanceReceipt,
  PendingMissionDispatch,
  PrdMissionRepository,
} from "@qualigence/mission";

/**
 * Long-lived Mission dispatch repository facade for Server loops. Each method
 * opens a fresh tenant-scoped PostgreSQL transaction, so a background dispatch
 * loop never retains an expired transaction-backed store or bypasses RLS.
 */
export class OperationScopedMissionDispatchRepository implements Pick<PrdMissionRepository, "pendingDispatches" | "markDispatchAccepted" | "markDispatchBlocked"> {
  constructor(
    private readonly provider: TenantTransactionProvider,
    private readonly tenantId: string,
  ) {}

  pendingDispatches(limit: number): Promise<readonly PendingMissionDispatch[]> {
    return this.withRepository((repository) => repository.pendingDispatches(limit));
  }

  markDispatchAccepted(
    attemptId: string,
    receipt: MissionDispatchAcceptanceReceipt,
    expectedVersion: number,
  ): Promise<AcceptedMissionDispatch> {
    return this.withRepository((repository) => repository.markDispatchAccepted(attemptId, receipt, expectedVersion));
  }

  markDispatchBlocked(attemptId: string, expectedVersion: number): Promise<BlockedMissionDispatch> {
    return this.withRepository((repository) => repository.markDispatchBlocked(attemptId, expectedVersion));
  }

  private withRepository<T>(operation: (repository: PostgresPrdMissionRepository) => Promise<T>): Promise<T> {
    return this.provider.withTenant(this.tenantId, ({ db }) =>
      operation(new PostgresPrdMissionRepository(db, this.tenantId)),
    );
  }
}

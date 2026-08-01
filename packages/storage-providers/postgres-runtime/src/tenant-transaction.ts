import { Kysely, sql, type Transaction } from "kysely";
import type { PostgresDatabase } from "./postgres-database.js";

/** The tenant-scoped stores exposed inside a tenant transaction. */
export interface RuntimeStores {
  /** A transaction whose `app.tenant_id` GUC is already set. */
  readonly db: Transaction<PostgresDatabase>;
}

/**
 * The only way to obtain an application transaction. It always opens a
 * transaction and binds the tenant context before running the operation, so an
 * unscoped query is not representable through this API.
 */
export interface TenantTransactionProvider {
  withTenant<T>(
    tenantId: string,
    operation: (stores: RuntimeStores) => Promise<T>,
  ): Promise<T>;
  close(): Promise<void>;
}

export class PostgresTenantTransactionProvider
  implements TenantTransactionProvider
{
  constructor(private readonly db: Kysely<PostgresDatabase>) {}

  async withTenant<T>(
    tenantId: string,
    operation: (stores: RuntimeStores) => Promise<T>,
  ): Promise<T> {
    if (tenantId.length === 0) {
      throw new Error("A tenant context requires a non-empty tenantId.");
    }
    return this.db.transaction().execute(async (trx) => {
      await sql`select set_config('app.tenant_id', ${tenantId}, true)`.execute(
        trx,
      );
      return operation({ db: trx });
    });
  }

  async close(): Promise<void> {
    await this.db.destroy();
  }
}

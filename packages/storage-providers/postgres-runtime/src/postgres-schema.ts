import { type Kysely, type ColumnDataType, sql } from "kysely";
import {
  RELATIONAL_TABLES,
  type ColumnSpec,
  type LogicalColumnType,
  type RelationalTableSpec,
} from "@qualigence/relational-kysely";

const TENANT_COLUMN = "tenant_id";

function pgType(type: LogicalColumnType): ColumnDataType {
  switch (type) {
    case "text":
      return "text";
    case "integer":
      return "integer";
    case "real":
      return "real";
    case "blob":
      return "bytea";
  }
}

function tenantColumns(table: RelationalTableSpec): readonly ColumnSpec[] {
  if (!table.tenantOwned || table.hasNativeTenantColumn) {
    return table.columns;
  }
  return [{ name: TENANT_COLUMN, type: "text", notNull: true }, ...table.columns];
}

function compositeKey(
  table: RelationalTableSpec,
  columns: readonly string[],
): string[] {
  if (!table.tenantOwned) {
    return [...columns];
  }
  if (columns.includes(TENANT_COLUMN)) {
    return [...columns];
  }
  return [TENANT_COLUMN, ...columns];
}

/**
 * Create every tenant-scoped table described by the shared relational catalog.
 * The DDL is intentionally derived from the same catalog the tenant-isolation
 * layer inspects, so the composite tenant primary keys and tenant-inclusive
 * foreign keys always match the RLS policies applied on top.
 */
export async function createTenantSchema(db: Kysely<any>): Promise<void> {
  for (const table of RELATIONAL_TABLES) {
    // The builder tracks added columns in its type; because it is reassigned in
    // a loop we treat it structurally and rely on the catalog for correctness.
    let builder: any = db.schema.createTable(table.name);

    for (const column of tenantColumns(table)) {
      builder = builder.addColumn(column.name, pgType(column.type), (col: any) =>
        column.notNull ? col.notNull() : col,
      );
    }

    builder = builder.addPrimaryKeyConstraint(
      `${table.name}_pkey`,
      compositeKey(table, table.primaryKey),
    );

    for (const unique of table.uniques) {
      builder = builder.addUniqueConstraint(
        unique.name,
        compositeKey(table, unique.columns),
      );
    }

    for (const [index, fk] of table.foreignKeys.entries()) {
      const withTenant = (columns: readonly string[]): string[] =>
        table.tenantOwned && !columns.includes(TENANT_COLUMN)
          ? [TENANT_COLUMN, ...columns]
          : [...columns];
      builder = builder.addForeignKeyConstraint(
        `${table.name}_fk_${index}`,
        withTenant(fk.columns),
        fk.references.table,
        withTenant(fk.references.columns),
      );
    }

    for (const check of table.checks) {
      builder = builder.addCheckConstraint(check.name, sql.raw(check.predicate));
    }

    await builder.execute();
  }
}

import {
  type ColumnDataType,
  type ColumnDefinitionBuilder,
  type CreateTableBuilder,
  type SchemaModule,
  type SqlBool,
  sql,
} from "kysely";
import {
  RELATIONAL_TABLES,
  type ColumnSpec,
  type LogicalColumnType,
  type RelationalTableSpec,
} from "@qualigence/relational-kysely";

const TENANT_COLUMN = "tenant_id";

interface SchemaConnection {
  readonly schema: SchemaModule;
}

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
export async function createTenantSchema(db: SchemaConnection): Promise<void> {
  await createTenantSchemaTables(db, RELATIONAL_TABLES.map(({ name }) => name));
}

export async function createTenantSchemaTables(
  db: SchemaConnection,
  tableNames: readonly string[],
): Promise<void> {
  const selected = new Set(tableNames);
  for (const table of RELATIONAL_TABLES) {
    if (!selected.has(table.name)) {
      continue;
    }
    // Catalog column names are dynamic, so widen the builder's tracked column
    // union while retaining its complete Kysely schema-builder contract.
    let builder: CreateTableBuilder<string, string> = db.schema.createTable(table.name);

    for (const column of tenantColumns(table)) {
      builder = builder.addColumn(
        column.name,
        pgType(column.type),
        (col: ColumnDefinitionBuilder) => column.notNull ? col.notNull() : col,
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

    for (const index of table.partialIndexes ?? []) {
      let indexBuilder = db.schema
        .createIndex(index.name)
        .on(table.name)
        .columns(compositeKey(table, index.columns))
        .where(sql.raw<SqlBool>(index.predicate));
      if (index.unique === true) {
        indexBuilder = indexBuilder.unique();
      }
      await indexBuilder.execute();
    }
  }
}

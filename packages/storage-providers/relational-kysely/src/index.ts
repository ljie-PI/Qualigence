export type { Database } from "./schema.js";

export { MIGRATIONS, SUPPORTED_SCHEMA_VERSION } from "./migrations.js";

export type { Migration } from "./migrations.js";

export {
  RELATIONAL_TABLES,
  RELATIONAL_SCHEMA_VERSIONS,
  TENANT_OWNED_TABLES,
  WORKER_ACCESSIBLE_TABLES,
  tenantOwnedTableNames,
  tenantOwnedTableNamesThroughVersion,
  relationalTableNames,
} from "./catalog.js";

export type {
  ColumnSpec,
  ForeignKeySpec,
  LogicalColumnType,
  RelationalTableSpec,
  RelationalSchemaVersion,
} from "./catalog.js";

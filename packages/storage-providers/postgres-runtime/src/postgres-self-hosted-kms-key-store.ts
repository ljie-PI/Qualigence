import type { SelfHostedKmsKeyStore, StoredKmsKeyVersion } from "@qualigence/kms-self-hosted";
import type { TenantTransactionProvider } from "./tenant-transaction.js";

/**
 * Tenant-scoped PostgreSQL persistence for the Self-hosted KMS wrapping keys
 * and capsule revocations used by the production Server composition.
 *
 * Each operation opens its own short tenant transaction through the existing
 * runtime provider. That preserves RLS isolation without leaking a long-lived
 * transaction-backed store into the KMS provider.
 */
export class PostgresSelfHostedKmsKeyStore implements SelfHostedKmsKeyStore {
  constructor(private readonly provider: TenantTransactionProvider) {}

  async putVersion(version: StoredKmsKeyVersion): Promise<void> {
    const tenantId = tenantFromScopeId(version.scopeId);
    await this.provider.withTenant(tenantId, async ({ db }) => {
      await db
        .insertInto("self_hosted_kms_key_versions")
        .values({
          tenant_id: tenantId,
          scope_id: version.scopeId,
          key_id: version.keyId,
          revision: version.revision,
          public_key_pem: version.publicKeyPem,
          wrapped_private_key_base64: version.wrappedPrivateKeyBase64,
          private_key_nonce_base64: version.privateKeyNonceBase64,
          private_key_tag_base64: version.privateKeyTagBase64,
          status: version.status,
          created_at: version.createdAt,
          is_primary: version.isPrimary ? 1 : 0,
        } as never)
        .onConflict((oc) => oc.columns(["tenant_id", "scope_id", "key_id"]).doNothing())
        .execute();
    });
  }

  async listVersions(scopeId: string): Promise<readonly StoredKmsKeyVersion[]> {
    const tenantId = tenantFromScopeId(scopeId);
    return this.provider.withTenant(tenantId, async ({ db }) => {
      const rows = await db
        .selectFrom("self_hosted_kms_key_versions")
        .selectAll()
        .where("tenant_id", "=", tenantId)
        .where("scope_id", "=", scopeId)
        .orderBy("revision", "asc")
        .execute();
      return rows.map((row) => rowToVersion(row));
    });
  }

  async getByKeyId(keyId: string, scopeId: string): Promise<StoredKmsKeyVersion | undefined> {
    const tenantId = tenantFromScopeId(scopeId);
    return this.provider.withTenant(tenantId, async ({ db }) => {
      const row = await db
        .selectFrom("self_hosted_kms_key_versions")
        .selectAll()
        .where("tenant_id", "=", tenantId)
        .where("scope_id", "=", scopeId)
        .where("key_id", "=", keyId)
        .executeTakeFirst();
      return row === undefined ? undefined : rowToVersion(row);
    });
  }

  async primaryVersion(scopeId: string): Promise<StoredKmsKeyVersion | undefined> {
    const tenantId = tenantFromScopeId(scopeId);
    return this.provider.withTenant(tenantId, async ({ db }) => {
      const row = await db
        .selectFrom("self_hosted_kms_key_versions")
        .selectAll()
        .where("tenant_id", "=", tenantId)
        .where("scope_id", "=", scopeId)
        .where("status", "=", "active")
        .where("is_primary", "=", 1)
        .orderBy("revision", "desc")
        .executeTakeFirst();
      return row === undefined ? undefined : rowToVersion(row);
    });
  }

  async setPrimary(scopeId: string, keyId: string): Promise<void> {
    const tenantId = tenantFromScopeId(scopeId);
    await this.provider.withTenant(tenantId, async ({ db }) => {
      await db
        .updateTable("self_hosted_kms_key_versions")
        .set({ is_primary: 0 } as never)
        .where("tenant_id", "=", tenantId)
        .where("scope_id", "=", scopeId)
        .execute();
      await db
        .updateTable("self_hosted_kms_key_versions")
        .set({ is_primary: 1 } as never)
        .where("tenant_id", "=", tenantId)
        .where("scope_id", "=", scopeId)
        .where("key_id", "=", keyId)
        .where("status", "=", "active")
        .execute();
    });
  }

  async markScopeRevoked(scopeId: string): Promise<void> {
    const tenantId = tenantFromScopeId(scopeId);
    await this.provider.withTenant(tenantId, async ({ db }) => {
      await db
        .updateTable("self_hosted_kms_key_versions")
        .set({ status: "revoked", is_primary: 0 } as never)
        .where("tenant_id", "=", tenantId)
        .where("scope_id", "=", scopeId)
        .execute();
    });
  }

  async isCapsuleRevoked(scopeId: string, capsuleId: string): Promise<boolean> {
    const tenantId = tenantFromScopeId(scopeId);
    return this.provider.withTenant(tenantId, async ({ db }) => {
      const row = await db
        .selectFrom("self_hosted_kms_capsule_revocations")
        .select("capsule_id")
        .where("tenant_id", "=", tenantId)
        .where("scope_id", "=", scopeId)
        .where("capsule_id", "=", capsuleId)
        .executeTakeFirst();
      return row !== undefined;
    });
  }

  async markCapsuleRevoked(input: {
    readonly scopeId?: string;
    readonly capsuleId: string;
    readonly reason: string;
    readonly occurredAt: string;
  }): Promise<void> {
    if (input.scopeId === undefined) {
      throw new Error("Postgres KMS capsule revocation requires a tenant-bound scope.");
    }
    const tenantId = tenantFromScopeId(input.scopeId);
    await this.provider.withTenant(tenantId, async ({ db }) => {
      await db
        .insertInto("self_hosted_kms_capsule_revocations")
        .values({
          tenant_id: tenantId,
          scope_id: input.scopeId,
          capsule_id: input.capsuleId,
          reason: input.reason,
          revoked_at: input.occurredAt,
        } as never)
        .onConflict((oc) => oc.columns(["tenant_id", "capsule_id"]).doUpdateSet({
          scope_id: input.scopeId,
          reason: input.reason,
          revoked_at: input.occurredAt,
        } as never))
        .execute();
    });
  }
}

type KmsKeyVersionRow = {
  readonly scope_id: string;
  readonly key_id: string;
  readonly revision: number;
  readonly public_key_pem: string;
  readonly wrapped_private_key_base64: string;
  readonly private_key_nonce_base64: string;
  readonly private_key_tag_base64: string;
  readonly status: string;
  readonly created_at: string;
  readonly is_primary: number;
};

function rowToVersion(row: KmsKeyVersionRow): StoredKmsKeyVersion {
  return {
    scopeId: row.scope_id,
    keyId: row.key_id,
    revision: row.revision,
    publicKeyPem: row.public_key_pem,
    wrappedPrivateKeyBase64: row.wrapped_private_key_base64,
    privateKeyNonceBase64: row.private_key_nonce_base64,
    privateKeyTagBase64: row.private_key_tag_base64,
    status: row.status === "revoked" ? "revoked" : "active",
    createdAt: row.created_at,
    isPrimary: row.is_primary === 1,
  };
}

function tenantFromScopeId(scopeId: string): string {
  const tenantId = scopeId.split("|", 1)[0];
  if (tenantId === undefined || tenantId.length === 0) {
    throw new Error("KMS scope id is missing a tenant id.");
  }
  return tenantId;
}

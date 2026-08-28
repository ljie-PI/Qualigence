import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalSkillSigner } from "@qualigence/kms-local";
import {
  bundlePayloadContentSha256,
  SkillSigningError,
} from "@qualigence/skill";
import type {
  ProcedureSkillVersion,
  SignedSkillBundle,
  UnsignedSkillBundle,
} from "@qualigence/skill";
import { readWindowsFileAcl } from "../../helpers/windows-file-acl.js";

function payload(
  overrides: Partial<ProcedureSkillVersion> = {},
): ProcedureSkillVersion {
  return {
    skillId: "skill-1",
    version: 3,
    state: "verified",
    projectId: "proj-1",
    targetScope: {
      targetId: "web-cart",
      allowedOrigins: ["https://shop.example"],
    },
    parameters: [
      {
        name: "quantity",
        valueRef: "test-data.cart.quantity",
        required: true,
        sensitivity: "public",
      },
    ],
    steps: [
      {
        stepId: "step-001",
        intent: { kind: "click", target: { purpose: "add to cart" } },
        preconditions: [],
        checkpoint: [{ kind: "url_path", path: "/cart" }],
        recovery: "stop",
        sourceNodeId: "node-1",
      },
    ],
    sourceRecordingIds: ["rec-1"],
    observationSchemaEpoch: "pre-v1",
    locatorSchemaVersion: "semantic-locator/v1",
    compilerVersion: "skill-compiler/v1",
    contentSha256: "will-be-overwritten",
    ...overrides,
  };
}

function unsignedBundle(
  signerKeyId: string,
  overrides: Partial<ProcedureSkillVersion> = {},
): UnsignedSkillBundle {
  const base = payload(overrides);
  const contentSha256 = bundlePayloadContentSha256(base);
  const fullPayload = { ...base, contentSha256 };
  return {
    bundleId: "bundle-1",
    skillId: fullPayload.skillId,
    skillVersion: fullPayload.version,
    schemaVersion: "skill-bundle/v1",
    compilerVersion: fullPayload.compilerVersion,
    contentSha256,
    signerKeyId,
    signatureAlgorithm: "Ed25519",
    issuedAt: "2026-08-01T00:00:00.000Z",
    payload: fullPayload,
  };
}

const projectScope = {
  projectId: "proj-1",
  targetId: "web-cart",
  origin: "https://shop.example",
};

describe("LocalSkillSigner", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(process.cwd(), ".tmp-kms-"));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("generates a private key protected for the current user and required system principals", async () => {
    const signer = LocalSkillSigner.open(dataDir);
    expect(signer.keyId).toMatch(/^[0-9a-f]{32}$/);
    const privateKeyPath = join(dataDir, "skill-signing.key");

    if (process.platform !== "win32") {
      const mode = statSync(privateKeyPath).mode & 0o777;
      expect(mode).toBe(0o600);
      return;
    }

    const acl = await readWindowsFileAcl(privateKeyPath);
    const allowedSids = new Set([acl.currentSid, "S-1-5-18", "S-1-5-32-544"]);
    expect(acl.rules).not.toHaveLength(0);
    expect(acl.rules.every((rule) => !rule.inherited && allowedSids.has(rule.sid))).toBe(true);
    expect(acl.rules.some((rule) => rule.sid === acl.currentSid && rule.access === "Allow")).toBe(true);
  });

  it("fails closed and returns no signer when private-key permission verification fails", async () => {
    LocalSkillSigner.open(dataDir);
    const privateKeyPath = join(dataDir, "skill-signing.key");
    if (process.platform === "win32") {
      execFileSync("icacls.exe", [privateKeyPath, "/grant", "*S-1-1-0:(R)"], { stdio: "ignore", windowsHide: true });
    } else {
      await chmod(privateKeyPath, 0o644);
    }

    expect(() => LocalSkillSigner.open(dataDir)).toThrow(SkillSigningError);
  });

  it("reuses the same key across reopen", () => {
    const first = LocalSkillSigner.open(dataDir).keyId;
    const second = LocalSkillSigner.open(dataDir).keyId;
    expect(second).toBe(first);
  });

  it("signs a canonical bundle and verifies it as valid", async () => {
    const signer = LocalSkillSigner.open(dataDir);
    const signed = await signer.sign(unsignedBundle(signer.keyId));
    expect(signed.manifest.signatureBase64.length).toBeGreaterThan(0);
    expect(await signer.verify(signed, projectScope)).toEqual({ status: "valid" });
  });

  it("rejects a bundle whose payload was tampered (one byte flipped)", async () => {
    const signer = LocalSkillSigner.open(dataDir);
    const signed = await signer.sign(unsignedBundle(signer.keyId));
    const tampered: SignedSkillBundle = {
      manifest: signed.manifest,
      payload: {
        ...signed.payload,
        steps: [
          {
            ...signed.payload.steps[0]!,
            intent: { kind: "click", target: { purpose: "remove from cart" } },
          },
        ],
      },
    };
    await expect(signer.verify(tampered, projectScope)).resolves.toMatchObject({
      status: "invalid",
      code: "SkillContentTampered",
    });
  });

  it("rejects a manifest whose signature byte was flipped", async () => {
    const signer = LocalSkillSigner.open(dataDir);
    const signed = await signer.sign(unsignedBundle(signer.keyId));
    const bytes = Buffer.from(signed.manifest.signatureBase64, "base64");
    bytes[0] = bytes[0]! ^ 0xff;
    const tampered: SignedSkillBundle = {
      manifest: { ...signed.manifest, signatureBase64: bytes.toString("base64") },
      payload: signed.payload,
    };
    await expect(signer.verify(tampered, projectScope)).resolves.toMatchObject({
      status: "invalid",
      code: "SkillSignatureInvalid",
    });
  });

  it("rejects a bundle signed by a different key", async () => {
    const signerA = LocalSkillSigner.generate();
    const signerB = LocalSkillSigner.generate();
    const signed = await signerA.sign(unsignedBundle(signerA.keyId));
    await expect(signerB.verify(signed, projectScope)).resolves.toMatchObject({
      status: "invalid",
      code: "SkillSignatureInvalid",
    });
  });

  it("rejects cross-project reuse", async () => {
    const signer = LocalSkillSigner.open(dataDir);
    const signed = await signer.sign(unsignedBundle(signer.keyId));
    await expect(
      signer.verify(signed, { ...projectScope, projectId: "other-project" }),
    ).resolves.toMatchObject({ status: "invalid", code: "SkillTargetMismatch" });
  });

  it("rejects an expired bundle", async () => {
    const signer = LocalSkillSigner.open(dataDir);
    const unsigned: UnsignedSkillBundle = {
      ...unsignedBundle(signer.keyId),
      expiresAt: "2026-08-01T00:00:00.000Z",
    };
    const signed = await signer.sign(unsigned);
    await expect(
      signer.verify(signed, { ...projectScope, now: "2026-09-01T00:00:00.000Z" }),
    ).resolves.toMatchObject({ status: "invalid", code: "SkillBundleExpired" });
  });

  it("raises SkillSigningFailed with no unsigned fallback when signing fails", async () => {
    const signer = LocalSkillSigner.generate();
    // A bundle whose signerKeyId does not match the signer must never yield a
    // silently-unsigned bundle.
    await expect(
      signer.sign(unsignedBundle("00000000000000000000000000000000")),
    ).rejects.toBeInstanceOf(SkillSigningError);
  });
});

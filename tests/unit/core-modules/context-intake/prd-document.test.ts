import { describe, expect, it } from "vitest";
import {
  PrdDocument,
  PrdIntakeService,
  sha256Hex,
  verifySourceRef,
} from "@qualigence/context-intake";
import type { PrdSourceRef } from "@qualigence/context-intake";
import type { Clock } from "@qualigence/shared-kernel";

const fixedClock: Clock = { now: () => "2026-08-01T00:00:00.000Z" };

function ref(
  document: PrdDocument,
  startOffset: number,
  endOffset: number,
  quotedTextSha256: string,
): PrdSourceRef {
  return {
    prdId: document.prdId,
    revision: document.revision,
    startOffset,
    endOffset,
    quotedTextSha256,
  };
}

describe("PrdDocument source references", () => {
  it("verifies an exact offset/hash range", () => {
    const doc = PrdDocument.create(
      { projectId: "p", title: "Cart", content: "Total equals item price." },
      fixedClock,
    );

    expect(verifySourceRef(doc, ref(doc, 0, 5, sha256Hex("Total")))).toBe(true);
  });

  it("rejects a range whose hash no longer matches the quoted text", () => {
    const doc = PrdDocument.create(
      { projectId: "p", title: "Cart", content: "Total equals item price." },
      fixedClock,
    );

    expect(verifySourceRef(doc, ref(doc, 0, 6, sha256Hex("Total")))).toBe(false);
  });

  it("rejects out-of-bounds and inverted ranges", () => {
    const doc = PrdDocument.create(
      { projectId: "p", title: "Cart", content: "Total" },
      fixedClock,
    );

    expect(verifySourceRef(doc, ref(doc, 0, 99, sha256Hex("Total")))).toBe(false);
    expect(verifySourceRef(doc, ref(doc, 3, 1, sha256Hex("")))).toBe(false);
  });

  it("rejects a ref pointing at a different document or revision", () => {
    const doc = PrdDocument.create(
      { prdId: "prd-1", revision: 1, projectId: "p", title: "Cart", content: "Total" },
      fixedClock,
    );

    const wrongDoc = { ...ref(doc, 0, 5, sha256Hex("Total")), prdId: "prd-2" };
    const wrongRevision = { ...ref(doc, 0, 5, sha256Hex("Total")), revision: 2 };

    expect(verifySourceRef(doc, wrongDoc)).toBe(false);
    expect(verifySourceRef(doc, wrongRevision)).toBe(false);
  });

  it("addresses ranges by UTF-16 code units, not bytes", () => {
    const content = "café ☕ total";
    const doc = PrdDocument.create(
      { projectId: "p", title: "Cart", content },
      fixedClock,
    );

    const start = content.indexOf("total");
    const end = start + "total".length;
    expect(verifySourceRef(doc, ref(doc, start, end, sha256Hex("total")))).toBe(
      true,
    );
  });
});

describe("PrdDocument content hashing", () => {
  it("derives a stable SHA-256 for identical content", () => {
    const a = PrdDocument.create(
      { projectId: "p", title: "Cart", content: "Total equals item price." },
      fixedClock,
    );
    const b = PrdDocument.create(
      { projectId: "p", title: "Cart", content: "Total equals item price." },
      fixedClock,
    );

    expect(a.contentSha256).toBe(b.contentSha256);
    expect(a.contentSha256).toBe(sha256Hex("Total equals item price."));
  });

  it("freezes the produced document", () => {
    const doc = PrdDocument.create(
      { projectId: "p", title: "Cart", content: "Total" },
      fixedClock,
    );
    expect(Object.isFrozen(doc)).toBe(true);
  });
});

describe("PrdIntakeService revisioning", () => {
  it("rejects empty content with PrdEmpty", async () => {
    const service = new PrdIntakeService(fixedClock);
    const result = await service.ingest({
      projectId: "p",
      title: "Cart",
      content: "",
    });

    expect(result).toMatchObject({ ok: false, error: { code: "PrdEmpty" } });
  });

  it("is idempotent for identical content (same revision and hash)", async () => {
    const service = new PrdIntakeService(fixedClock);
    const first = await service.ingest({
      projectId: "p",
      title: "Cart",
      content: "Total equals item price.",
    });
    const second = await service.ingest({
      projectId: "p",
      title: "Cart",
      content: "Total equals item price.",
    });

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.prdId).toBe(first.value.prdId);
    expect(second.value.revision).toBe(1);
    expect(second.value.contentSha256).toBe(first.value.contentSha256);
    expect(second.value).toEqual(first.value);
  });

  it("creates the next revision when content changes, keeping the prdId", async () => {
    const service = new PrdIntakeService(fixedClock);
    const first = await service.ingest({
      projectId: "p",
      title: "Cart",
      content: "Total equals item price.",
    });
    const second = await service.ingest({
      projectId: "p",
      title: "Cart",
      content: "Total equals item price including tax.",
    });

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.prdId).toBe(first.value.prdId);
    expect(second.value.revision).toBe(2);
    expect(second.value.contentSha256).not.toBe(first.value.contentSha256);
  });
});

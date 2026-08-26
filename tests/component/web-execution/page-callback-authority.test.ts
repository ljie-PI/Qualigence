import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const productionFiles = [
  "packages/target-adapters/web-playwright/src/browser-session.ts",
  "packages/target-adapters/web-playwright/src/playwright-action-executor.ts",
  "packages/target-adapters/web-playwright/src/playwright-observer.ts",
];

interface CallbackInventoryEntry {
  readonly file: string;
  readonly pattern: string;
  readonly occurrence?: number;
  readonly authority: string;
}

const callbackInventory: readonly CallbackInventoryEntry[] = [
  { file: "browser-session.ts", pattern: "page.addInitScript((input", authority: "nativeDomAuthority" },
  { file: "browser-session.ts", pattern: "page.evaluate(validateSensitivePromiseOwnerRegistryInPage", authority: "validateSensitivePromiseOwnerRegistryInPage" },
  { file: "browser-session.ts", pattern: "page.exposeFunction(SENSITIVE_EVIDENCE_MUTATION_NOTIFICATION_FUNCTION", authority: "SENSITIVE_EVIDENCE_MUTATION_NOTIFICATION_FUNCTION" },
  { file: "playwright-action-executor.ts", pattern: "page.evaluate(", authority: "window.scrollBy" },
  { file: "playwright-action-executor.ts", pattern: "await locator.evaluate((element, options) =>", authority: "scrollIntoView" },
  { file: "playwright-action-executor.ts", pattern: "return locator.evaluate((element, input): PageSensitiveEpochResult =>", authority: "beginPageSensitiveActionEpoch" },
  { file: "playwright-action-executor.ts", pattern: "return locator.evaluate((element, input): PageSensitiveEpochResult =>", occurrence: 2, authority: "endPageSensitiveActionEpoch" },
  { file: "playwright-action-executor.ts", pattern: "input.markerId.replace(/[^A-Za-z0-9_-]/g", authority: "markSensitiveTarget" },
  { file: "playwright-action-executor.ts", pattern: "return locator.evaluate((element, input) =>", authority: "readInputSensitiveForms" },
  { file: "playwright-action-executor.ts", pattern: "return locator.evaluate((element, input) =>", occurrence: 2, authority: "readSelectSensitiveForms" },
  { file: "playwright-observer.ts", pattern: "page.evaluate(\n      collectPageObservation", authority: "collectPageObservation" },
  { file: "playwright-observer.ts", pattern: "page.evaluate(\n      retirePageSensitiveEvidence", authority: "retirePageSensitiveEvidence" },
];

describe("page callback authority inventory", () => {
  const sources = new Map(productionFiles.map((path) => [path.split("/").at(-1)!, readFileSync(path, "utf8")]));
  const combinedSource = [...sources.values()].join("\n");

  it("enumerates every Node-to-page callback in the allowed production files", () => {
    const actualCount = countOccurrences(combinedSource, ".evaluate(") +
      countOccurrences(combinedSource, ".addInitScript(") +
      countOccurrences(combinedSource, ".exposeFunction(");
    expect(callbackInventory).toHaveLength(actualCount);
    for (const item of callbackInventory) {
      const source = sources.get(item.file);
      expect(source, `missing inventory file ${item.file}`).toBeDefined();
      expect(countOccurrences(source!, item.pattern), `${item.authority} callback`).toBeGreaterThanOrEqual(item.occurrence ?? 1);
    }
  });

  it("requires sensitive DOM reads to use the captured native DOM authority vault", () => {
    const browserSessionSource = sources.get("browser-session.ts")!;
    expect(browserSessionSource).toContain("nativeDomAuthority");
    for (const approved of [
      "nativeElementGetAttribute",
      "nativeElementGetClientRects",
      "nativeHTMLElementHiddenGet",
      "nativeHTMLInputElementValueGet",
      "nativeHTMLTextAreaElementValueGet",
      "nativeHTMLSelectElementValueGet",
      "nativeHTMLSelectElementSelectedOptionsGet",
      "nativeNodeTextContentGet",
      "nativeCharacterDataDataGet",
      "nativeShadowRootHostGet",
      "nativeShadowRootModeGet",
    ]) {
      expect(browserSessionSource).toContain(approved);
    }
    expect(combinedSource).not.toContain("getBoundingClientRect");
    expect(combinedSource).not.toContain("maskColor");
    expect(combinedSource).not.toContain("{ mask:");
  });

  it("keeps production screenshot masking on CDP/backend-node authority", () => {
    const observerSource = sources.get("playwright-observer.ts")!;
    expect(observerSource).toContain("DOM.getBoxModel");
    expect(observerSource).toContain("Page.getLayoutMetrics");
    expect(observerSource).toContain("DOM.getDocument");
    expect(observerSource).toContain("DOM.performSearch");
    expect(observerSource).toContain("decodePngRgba");
    expect(observerSource).toContain("encodePngRgba");
  });
});

function countOccurrences(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

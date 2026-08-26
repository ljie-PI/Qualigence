import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const productionFiles = [
  "packages/target-adapters/web-playwright/src/browser-session.ts",
  "packages/target-adapters/web-playwright/src/playwright-action-executor.ts",
  "packages/target-adapters/web-playwright/src/playwright-observer.ts",
];

interface CallbackInventoryEntry {
  readonly id: string;
  readonly file: string;
  readonly marker: string;
  readonly occurrence?: number;
  readonly sensitiveDomAuthority: boolean;
  readonly authority: readonly string[];
}

const callbackInventory: readonly CallbackInventoryEntry[] = [
  {
    id: "installSensitiveEvidenceRuntime",
    file: "browser-session.ts",
    marker: "page.addInitScript((input",
    sensitiveDomAuthority: false,
    authority: ["nativeObjectGetOwnPropertyDescriptor", "nativeDomAuthority"],
  },
  {
    id: "validateSensitivePromiseOwnerRegistryInPage",
    file: "browser-session.ts",
    marker: "page.evaluate(validateSensitivePromiseOwnerRegistryInPage",
    sensitiveDomAuthority: false,
    authority: ["validatePromiseOwners"],
  },
  {
    id: "SENSITIVE_EVIDENCE_MUTATION_NOTIFICATION_FUNCTION",
    file: "browser-session.ts",
    marker: "page.exposeFunction(SENSITIVE_EVIDENCE_MUTATION_NOTIFICATION_FUNCTION",
    sensitiveDomAuthority: false,
    authority: ["markSensitiveEvidenceUnavailable"],
  },
  {
    id: "pageScrollBy",
    file: "playwright-action-executor.ts",
    marker: "await page.evaluate(\n            ({ direction, distance }) => {",
    sensitiveDomAuthority: false,
    authority: ["window.scrollBy"],
  },
  {
    id: "locatorScrollIntoView",
    file: "playwright-action-executor.ts",
    marker: "await locator.evaluate((element, options) =>",
    sensitiveDomAuthority: false,
    authority: ["scrollIntoView"]
  },
  {
    id: "beginPageSensitiveActionEpoch",
    file: "playwright-action-executor.ts",
    marker: "return locator.evaluate((element, input): PageSensitiveEpochResult =>",
    sensitiveDomAuthority: true,
    authority: ["nativeDomAuthority", "dom.reflectApply", "dom.elementGetAttribute", "dom.nodeTextContentGet"],
  },
  {
    id: "endPageSensitiveActionEpoch",
    file: "playwright-action-executor.ts",
    marker: "return locator.evaluate((element, input): PageSensitiveEpochResult =>",
    occurrence: 2,
    sensitiveDomAuthority: true,
    authority: ["nativeDomAuthority", "dom.reflectApply", "dom.elementGetAttribute", "dom.nodeTextContentGet"],
  },
  {
    id: "markSensitiveTarget",
    file: "playwright-action-executor.ts",
    marker: "async function markSensitiveTarget",
    sensitiveDomAuthority: true,
    authority: ["nativeDomAuthority", "dom.reflectApply", "dom.objectDefineProperty"],
  },
  {
    id: "readInputSensitiveForms",
    file: "playwright-action-executor.ts",
    marker: "return locator.evaluate((element, input) =>",
    sensitiveDomAuthority: true,
    authority: ["nativeDomAuthority", "dom.reflectApply", "dom.htmlInputElementValueGet"],
  },
  {
    id: "readSelectSensitiveForms",
    file: "playwright-action-executor.ts",
    marker: "return locator.evaluate((element, input) =>",
    occurrence: 2,
    sensitiveDomAuthority: true,
    authority: ["nativeDomAuthority", "dom.reflectApply", "dom.htmlSelectElementValueGet"],
  },
  {
    id: "collectPageObservation",
    file: "playwright-observer.ts",
    marker: "page.evaluate(\n      collectPageObservation",
    sensitiveDomAuthority: true,
    authority: ["NativeDomAuthority", "dom.elementSetAttribute", "dom.elementGetClientRects", "DOM.getBoxModel"]
  },
  {
    id: "retirePageSensitiveEvidence",
    file: "playwright-observer.ts",
    marker: "page.evaluate(\n      retirePageSensitiveEvidence",
    sensitiveDomAuthority: false,
    authority: ["retirePageSensitiveEvidence"]
  },
  {
    id: "cdpMaskNodeHasValidatedSensitiveAssociation",
    file: "playwright-observer.ts",
    marker: "functionDeclaration: `function(input) {",
    sensitiveDomAuthority: true,
    authority: ["Runtime.callFunctionOn", "classifiedElements", "dom.reflectApply", "dom.elementGetAttribute"],
  },
];

const forbiddenSensitiveDomReads: readonly RegExp[] = [
  /\b(?:candidate|target|element|node|root|option)\.tagName\b/,
  /\b(?:candidate|target|element|node|root|option)\.value\b/,
  /\b(?:candidate|target|element|node|root|option)\.textContent\b/,
  /\b(?:candidate|target|element|node|root|option)\.getAttribute\s*\(/,
  /\b(?:candidate|target|element|node|root|option)\.hasAttribute\s*\(/,
  /\b(?:candidate|target|element|node|root|option)\.querySelector(?:All)?\s*\(/,
  /\b(?:candidate|target|element|node|root|option)\.childNodes\b/,
  /\b(?:candidate|target|element|node|root|option)\.data\b/,
  /\b(?:candidate|target|element|node|root|option)\.shadowRoot\b/,
  /\b(?:candidate|target|element|node|root|option)\.getRootNode\s*\(/,
  /\b(?:candidate|target|element|node|root|option)\.parentElement\b/,
  /\b(?:candidate|target|element|node|root|option)\.selectedOptions\b/,
  /\b(?:candidate|target|element|node|root|option)\.options\b/,
  /\bgetComputedStyle\s*\(/,
  /\[[^\]]*handlerName[^\]]*\]/,
];

const dynamicCallbackConstruction: readonly RegExp[] = [
  /\bnew\s+Function\b/,
  /\beval\s*\(/,
];

describe("page callback authority inventory", () => {
  const sources = new Map(productionFiles.map((path) => [path.split("/").at(-1)!, readFileSync(path, "utf8").replace(/\r\n/g, "\n")]));
  const combinedSource = [...sources.values()].join("\n");

  it("enumerates every Node-to-page callback in the allowed production files", () => {
    const actualCount = countOccurrences(combinedSource, ".evaluate(") +
      countOccurrences(combinedSource, ".addInitScript(") +
      countOccurrences(combinedSource, ".exposeFunction(") +
      countOccurrences(combinedSource, "functionDeclaration:");
    expect(callbackInventory).toHaveLength(actualCount);
    for (const item of callbackInventory) {
      const source = sources.get(item.file);
      expect(source, `missing inventory file ${item.file}`).toBeDefined();
      expect(countOccurrences(source!, item.marker), `${item.id} callback`).toBeGreaterThanOrEqual(item.occurrence ?? 1);
      for (const authority of item.authority) {
        expect(source, `${item.id} authority ${authority}`).toContain(authority);
      }
    }
  });

  it("rejects sensitive callbacks that read security-relevant DOM state through ambient APIs", () => {
    const sensitiveCallbackSources = callbackInventory
      .filter((entry) => entry.sensitiveDomAuthority)
      .map(extractInventorySource);
    for (const source of sensitiveCallbackSources) {
      expect(unauthorizedSensitiveReads(source)).toEqual([]);
    }

    const previouslyCitedAmbientReads = `
      const tag = candidate.tagName.toLowerCase();
      const hasRole = candidate.hasAttribute('role');
      const text = candidate.textContent;
      const value = target.value;
      const selected = candidate.selectedOptions.item(0).text;
      const attribute = candidate.getAttribute('aria-label');
      const direct = Array.from(candidate.childNodes).map((node) => node.data).join('');
      const root = candidate.shadowRoot || node.getRootNode();
      const parent = node.parentElement;
      if (target[handlerName]) console.log('dynamic');
    `;
    expect(unauthorizedSensitiveReads(previouslyCitedAmbientReads)).toEqual([
      "candidate.tagName",
      "target.value",
      "candidate.textContent",
      "candidate.getAttribute(",
      "candidate.hasAttribute(",
      "candidate.childNodes",
      "node.data",
      "candidate.shadowRoot",
      "node.getRootNode(",
      "node.parentElement",
      "candidate.selectedOptions",
      "[handlerName]",
    ]);
  });

  it("keeps production screenshot masking on CDP/backend-node authority", () => {
    const observerSource = sources.get("playwright-observer.ts")!;
    expect(observerSource).toContain("DOM.getBoxModel");
    expect(observerSource).toContain("Page.getLayoutMetrics");
    expect(observerSource).toContain("DOM.getDocument");
    expect(observerSource).toContain("DOM.performSearch");
    expect(observerSource).toContain("DOM.resolveNode");
    expect(observerSource).toContain("Runtime.callFunctionOn");
    expect(observerSource).toContain("cdpMaskNodeHasValidatedSensitiveAssociation");
    expect(observerSource).toContain("decodePngRgba");
    expect(observerSource).toContain("encodePngRgba");
    for (const pattern of dynamicCallbackConstruction) {
      expect(combinedSource).not.toMatch(pattern);
    }
  });
});

function countOccurrences(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

function extractInventorySource(entry: CallbackInventoryEntry): string {
  const source = readFileSync(`packages/target-adapters/web-playwright/src/${entry.file}`, "utf8").replace(/\r\n/g, "\n");
  const start = nthIndexOf(source, entry.marker, entry.occurrence ?? 1);
  expect(start, `${entry.id} source anchor`).toBeGreaterThanOrEqual(0);
  const next = source.indexOf("\nasync function ", start + entry.marker.length);
  const nextPlain = source.indexOf("\nfunction ", start + entry.marker.length);
  const candidates = [next, nextPlain].filter((value) => value > start);
  const end = candidates.length === 0 ? source.length : Math.min(...candidates);
  return source.slice(start, end);
}

function nthIndexOf(source: string, needle: string, occurrence: number): number {
  let from = 0;
  for (let index = 0; index < occurrence; index += 1) {
    const found = source.indexOf(needle, from);
    if (found < 0) return -1;
    from = found + needle.length;
    if (index === occurrence - 1) return found;
  }
  return -1;
}

function unauthorizedSensitiveReads(source: string): string[] {
  const findings: string[] = [];
  for (const pattern of forbiddenSensitiveDomReads) {
    for (const match of source.matchAll(new RegExp(pattern.source, "g"))) {
      findings.push(match[0]);
    }
  }
  return findings;
}

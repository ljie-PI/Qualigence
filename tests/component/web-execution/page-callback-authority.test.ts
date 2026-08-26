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
  readonly delegates?: readonly string[];
}

interface CallbackSite {
  readonly file: string;
  readonly kind: ".evaluate" | ".addInitScript" | ".exposeFunction" | "functionDeclaration";
  readonly index: number;
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
    delegates: ["validateSensitivePromiseOwnerRegistryInPage"],
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
    authority: ["scrollIntoView"],
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
    authority: ["NativeDomAuthority", "dom.reflectApply", "dom.elementSetAttribute", "dom.elementGetClientRects", "DOM.getBoxModel"],
    delegates: ["collectPageObservation"],
  },
  {
    id: "retirePageSensitiveEvidence",
    file: "playwright-observer.ts",
    marker: "page.evaluate(\n      retirePageSensitiveEvidence",
    sensitiveDomAuthority: false,
    authority: ["retirePageSensitiveEvidence"],
    delegates: ["retirePageSensitiveEvidence"],
  },
];

const forbiddenSensitiveReadPatterns: readonly { readonly pattern: RegExp; readonly label: string }[] = [
  { pattern: /\.call\s*\(/g, label: ".call(" },
  { pattern: /\bArray\.from\s*\(/g, label: "Array.from(" },
  { pattern: /\bnew\s+Set\b/g, label: "new Set" },
  { pattern: /(^|[^.\w$])Set\s*\(/g, label: "Set(" },
  { pattern: /\bnew\s+WeakMap\b/g, label: "new WeakMap" },
  { pattern: /(^|[^.\w$])WeakMap\s*\(/g, label: "WeakMap(" },
  { pattern: /\bWeakMap\.prototype\b/g, label: "WeakMap.prototype" },
  { pattern: /\b(?:candidate|target|element|node|root|option)\.tagName\b/g, label: ".tagName" },
  { pattern: /\b(?:candidate|target|element|node|root|option)\.value\b/g, label: ".value" },
  { pattern: /\b(?:candidate|target|element|node|root|option)\.textContent\b/g, label: ".textContent" },
  { pattern: /\b(?:candidate|target|element|node|root|option)\.getAttribute\s*\(/g, label: ".getAttribute(" },
  { pattern: /\b(?:candidate|target|element|node|root|option)\.hasAttribute\s*\(/g, label: ".hasAttribute(" },
  { pattern: /\b(?:candidate|target|element|node|root|option)\.querySelector(?:All)?\s*\(/g, label: ".querySelector(" },
  { pattern: /\b(?:candidate|target|element|node|root|option)\.childNodes\b/g, label: ".childNodes" },
  { pattern: /\b(?:candidate|target|element|node|root|option)\.data\b/g, label: ".data" },
  { pattern: /\b(?:candidate|target|element|node|root|option)\.shadowRoot\b/g, label: ".shadowRoot" },
  { pattern: /\b(?:candidate|target|element|node|root|option)\.getRootNode\s*\(/g, label: ".getRootNode(" },
  { pattern: /\b(?:candidate|target|element|node|root|option)\.parentElement\b/g, label: ".parentElement" },
  { pattern: /\b(?:candidate|target|element|node|root|option)\.selectedOptions\b/g, label: ".selectedOptions" },
  { pattern: /\b(?:candidate|target|element|node|root|option)\.options\b/g, label: ".options" },
  { pattern: /(^|[^.\w$])getComputedStyle\s*\(/g, label: "getComputedStyle(" },
  { pattern: /\bstyle\.(?:display|visibility)\b/g, label: "style.display/visibility" },
  { pattern: /\.(?:at|charAt|charCodeAt|codePointAt|concat|endsWith|includes|indexOf|lastIndexOf|localeCompare|match|matchAll|normalize|padEnd|padStart|repeat|replace|replaceAll|search|slice|split|startsWith|substring|substr|toLocaleLowerCase|toLocaleUpperCase|toLowerCase|toString|toUpperCase|trim|trimEnd|trimStart|valueOf)\s*\(/g, label: "mutable String.prototype method" },
  { pattern: /\.(?:at|concat|copyWithin|entries|every|fill|filter|find|findIndex|findLast|findLastIndex|flat|flatMap|forEach|includes|indexOf|join|keys|lastIndexOf|map|pop|push|reduce|reduceRight|reverse|shift|slice|some|sort|splice|toLocaleString|toReversed|toSorted|toSpliced|toString|unshift|values|with)\s*\(/g, label: "mutable Array.prototype method" },
];

const dynamicCallbackConstruction: readonly RegExp[] = [
  /\bnew\s+Function\b/,
  /\beval\s*\(/,
];

const forbiddenMutableIterationPatterns: readonly { readonly pattern: RegExp; readonly label: string }[] = [
  { pattern: /\bfor\s*\([^)]*\bof\b[^)]*\)/g, label: "for...of" },
  { pattern: /\bSymbol\.iterator\b/g, label: "Symbol.iterator" },
  { pattern: /\[\s*Symbol\.iterator\s*\]/g, label: "[Symbol.iterator]" },
];

const approvedComputedReadPatterns: readonly RegExp[] = [
  /^\[input\.[A-Za-z0-9_]+\]$/,
  /^\[[0-9]+\]$/,
  /^\[index\]$/,
  /^\[_forOfIndex\d+\]$/,
  /^\[elementIndex\]$/,
  /^\[recordIndex\]$/,
  /^\[rootIndex\]$/,
  /^\[valueIndex\]$/,
  /^\[ordinal\]$/,
  /^\[items\]$/,
  /^\[selector\]$/,
  /^\[name(?:, value)?\]$/,
  /^\[child\]$/,
  /^\[element\]$/,
  /^\[id\]$/,
  /^\[markerId\]$/,
  /^\[form\]$/,
  /^\[source\+\+\]$/,
  /^\[output(?: \+ [123])?\]$/,
  /^\[offset(?: \+ [123])?\]$/,
  /^\[y \* stride\]$/,
];

describe("page callback authority inventory", () => {
  const sources = new Map(productionFiles.map((path) => [path.split("/").at(-1)!, readFileSync(path, "utf8").replace(/\r\n/g, "\n")]));
  const combinedSource = [...sources.values()].join("\n");

  it("enumerates every Node-to-page callback in the allowed production files and extracts balanced callback bodies", () => {
    const actualSites = [...sources].flatMap(([file, source]) => callbackSites(source, file));
    expect(callbackInventory.map((entry) => entry.id)).toHaveLength(actualSites.length);
    for (const item of callbackInventory) {
      const source = sources.get(item.file);
      expect(source, `missing inventory file ${item.file}`).toBeDefined();
      expect(countOccurrences(source!, item.marker), `${item.id} callback`).toBeGreaterThanOrEqual(item.occurrence ?? 1);
      expect(extractInventorySource(item).length, `${item.id} balanced body`).toBeGreaterThan(0);
      for (const authority of item.authority) {
        expect(source, `${item.id} authority ${authority}`).toContain(authority);
      }
    }
  });

  it("rejects sensitive callbacks that read security-relevant DOM state through mutable ambient APIs", () => {
    for (const entry of callbackInventory.filter((item) => item.sensitiveDomAuthority)) {
      const source = extractInventorySource(entry);
      expect(unauthorizedSensitiveReads(source), entry.id).toEqual([]);
      expect(unapprovedComputedReads(source), entry.id).toEqual([]);
      expect(unauthorizedMutableIteration(source), entry.id).toEqual([]);
    }
    const pageStateValidationSource = extractInventorySource(callbackInventory.find((entry) => entry.id === "retirePageSensitiveEvidence")!);
    expect(unauthorizedMutableIteration(pageStateValidationSource), "retirePageSensitiveEvidence").toEqual([]);

    const previouslyCitedAmbientReads = `
      const tag = candidate.tagName.toLowerCase();
      const hasRole = candidate.hasAttribute('role');
      const text = candidate.textContent;
      const value = target.value;
      const selected = candidate.selectedOptions.item(0).text;
      const attribute = candidate.getAttribute('aria-label');
      const direct = Array.from(candidate.childNodes).map((node) => node.data).join('');
      const missing = new Set(Array.from(root.children));
      const erased = Set(values);
      const rootNode = candidate.shadowRoot || node.getRootNode();
      const parent = node.parentElement;
      const hidden = getComputedStyle(target).display;
      const called = Element.prototype.getAttribute.call(target, 'title');
      const weak = new WeakMap();
      const weakCall = WeakMap.prototype.get.call(weak, target);
      const display = style.display;
      const visibility = style.visibility;
      const lower = value.toLowerCase();
      const trimmed = value.trim();
      const normalized = value.normalize('NFC');
      const replaced = value.replace(/secret/g, 'x');
      const matched = value.includes(secret);
      const code = value.charCodeAt(0);
      values.push(secret);
      values.splice(0, 1);
      values.sort();
      if (target[handlerName]) console.log('dynamic');
      if (target[handlerName, otherName]) console.log('comma dynamic');
      if (target[...handlerNames]) console.log('spread dynamic');
      for (const record of state.records) console.log(record.markerId);
      Array.prototype[Symbol.iterator] = function hiddenIterator() { return [][Symbol.iterator](); };
      const hidden = records[Symbol.iterator]();
    `;
    expect(unauthorizedSensitiveReads(previouslyCitedAmbientReads)).toEqual(expect.arrayContaining([
      ".call(",
      "Array.from(",
      "new Set",
      "Set(",
      ".tagName",
      ".value",
      ".textContent",
      ".getAttribute(",
      ".hasAttribute(",
      ".childNodes",
      ".data",
      ".shadowRoot",
      ".getRootNode(",
      ".parentElement",
      ".selectedOptions",
      "getComputedStyle(",
      "new WeakMap",
      "WeakMap.prototype",
      "style.display/visibility",
      "style.display/visibility",
      "mutable String.prototype method",
      "mutable String.prototype method",
      "mutable String.prototype method",
      "mutable String.prototype method",
      "mutable String.prototype method",
      "mutable String.prototype method",
      "mutable Array.prototype method",
    ]));
    expect(unapprovedComputedReads(previouslyCitedAmbientReads)).toEqual(expect.arrayContaining([
      "[handlerName]",
      "[handlerName, otherName]",
      "[...handlerNames]",
    ]));
    expect(unauthorizedMutableIteration(previouslyCitedAmbientReads)).toEqual(expect.arrayContaining([
      "for...of",
      "Symbol.iterator",
      "[Symbol.iterator]",
    ]));
    expect(unauthorizedRetiredBaselineAuthority(`
      const record = state.retiredRecords[0];
      if (record.baseline.get(element).includes(secret)) return false;
      if (record.shadowBaseline.get(root).includes(secret)) return false;
    `)).toEqual(expect.arrayContaining([
      "retiredRecords",
      "retired baseline",
      "retired shadowBaseline",
    ]));
  });

  it("does not use page-owned retired baselines as sensitive reflection authority", () => {
    const collectSource = extractInventorySource(callbackInventory.find((entry) => entry.id === "collectPageObservation")!);
    expect(unauthorizedRetiredBaselineAuthority(collectSource)).toEqual([]);
  });

  it("keeps production screenshot masking on CDP/backend-node authority and rejects dynamic callbacks", () => {
    const observerSource = sources.get("playwright-observer.ts")!;
    expect(observerSource).toContain("DOM.getBoxModel");
    expect(observerSource).toContain("Page.getLayoutMetrics");
    expect(observerSource).toContain("DOM.getDocument");
    expect(observerSource).toContain("DOM.performSearch");
    expect(observerSource).toContain("DOM.describeNode");
    expect(observerSource).not.toContain("Runtime.callFunctionOn");
    expect(observerSource).not.toContain("cdpMaskNodeHasValidatedSensitiveAssociation");
    expect(observerSource).toContain("decodePngRgba");
    expect(observerSource).toContain("encodePngRgba");
    for (const pattern of dynamicCallbackConstruction) {
      expect(combinedSource).not.toMatch(pattern);
      expect(unauthorizedSensitiveReads(`const f = ${pattern.source.includes("Function") ? "new Function('return 1')" : "eval('1')"};`)).not.toEqual([]);
    }
  });
});

function countOccurrences(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

function callbackSites(source: string, file: string): CallbackSite[] {
  const sites: CallbackSite[] = [];
  for (const kind of [".evaluate", ".addInitScript", ".exposeFunction"] as const) {
    for (const index of allIndexes(source, `${kind}(`)) {
      sites.push({ file, kind, index });
    }
  }
  for (const index of allIndexes(source, "functionDeclaration:")) {
    sites.push({ file, kind: "functionDeclaration", index });
  }
  return sites.sort((a, b) => a.file.localeCompare(b.file) || a.index - b.index);
}

function allIndexes(source: string, needle: string): number[] {
  const indexes: number[] = [];
  let from = 0;
  while (from < source.length) {
    const index = source.indexOf(needle, from);
    if (index < 0) break;
    indexes.push(index);
    from = index + needle.length;
  }
  return indexes;
}

function extractInventorySource(entry: CallbackInventoryEntry): string {
  const source = readFileSync(`packages/target-adapters/web-playwright/src/${entry.file}`, "utf8").replace(/\r\n/g, "\n");
  const start = nthIndexOf(source, entry.marker, entry.occurrence ?? 1);
  expect(start, `${entry.id} source anchor`).toBeGreaterThanOrEqual(0);
  const bodies: string[] = [];
  if (entry.marker.includes("functionDeclaration:")) {
    bodies.push(extractTemplateFunctionBody(source, start));
  } else {
    bodies.push(extractBalancedCallbackBody(source, start));
  }
  for (const delegate of entry.delegates ?? []) {
    bodies.push(extractFunctionDeclaration(source, delegate));
  }
  return bodies.join("\n");
}

function extractBalancedCallbackBody(source: string, start: number): string {
  const statementEnd = source.indexOf(";", start);
  const searchEnd = statementEnd < 0 ? source.length : statementEnd;
  const brace = source.indexOf("{", start);
  if (brace < 0 || brace > searchEnd) return source.slice(start, searchEnd);
  return source.slice(brace, findMatchingBrace(source, brace) + 1);
}

function extractFunctionDeclaration(source: string, name: string): string {
  const patterns = [`function ${name}(`, `async function ${name}(`];
  const starts = patterns.map((pattern) => source.indexOf(pattern)).filter((index) => index >= 0);
  expect(starts.length, `${name} declaration`).toBeGreaterThan(0);
  const start = Math.min(...starts);
  const brace = source.indexOf("{", start);
  expect(brace, `${name} body`).toBeGreaterThan(start);
  return source.slice(brace, findMatchingBrace(source, brace) + 1);
}

function extractTemplateFunctionBody(source: string, start: number): string {
  const templateStart = source.indexOf("`", start);
  expect(templateStart, "functionDeclaration template start").toBeGreaterThan(start);
  const templateEnd = source.indexOf("`", templateStart + 1);
  expect(templateEnd, "functionDeclaration template end").toBeGreaterThan(templateStart);
  return source.slice(templateStart + 1, templateEnd);
}

function findMatchingBrace(source: string, openBrace: number): number {
  let depth = 0;
  let quote: "'" | '"' | "`" | undefined;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = openBrace; index < source.length; index += 1) {
    const char = source[index]!;
    const next = source[index + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote !== undefined) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error(`Unbalanced callback body at ${openBrace}.`);
}

function unauthorizedSensitiveReads(source: string): string[] {
  const body = stripCommentsAndStrings(source);
  const findings: string[] = [];
  for (const pattern of forbiddenSensitiveReadPatterns) {
    for (const match of body.matchAll(new RegExp(pattern.pattern.source, "g"))) {
      if (pattern.label === "Set(" && match[0].includes("NativeSet(")) continue;
      if (pattern.label === "WeakMap.prototype" && /^\s*readonly\s+\w+:\s+typeof\s+WeakMap\.prototype/m.test(body.slice(Math.max(0, match.index - 40), match.index + match[0].length + 20))) continue;
      findings.push(pattern.label);
    }
  }
  for (const pattern of dynamicCallbackConstruction) {
    if (pattern.test(body)) findings.push(pattern.source.includes("Function") ? "new Function" : "eval(");
  }
  return findings;
}

function unauthorizedMutableIteration(source: string): string[] {
  const body = stripCommentsAndStrings(source);
  const findings: string[] = [];
  for (const pattern of forbiddenMutableIterationPatterns) {
    if (new RegExp(pattern.pattern.source, "g").test(body)) findings.push(pattern.label);
  }
  return findings;
}

function unauthorizedRetiredBaselineAuthority(source: string): string[] {
  const body = stripCommentsAndStrings(source);
  const findings: string[] = [];
  if (/\.retiredRecords\b/.test(body)) findings.push("retiredRecords");
  if (/\.retiredRecords\b[\s\S]*\.baseline\b/.test(body)) findings.push("retired baseline");
  if (/\.retiredRecords\b[\s\S]*\.shadowBaseline\b/.test(body)) findings.push("retired shadowBaseline");
  return findings;
}

function unapprovedComputedReads(source: string): string[] {
  const body = stripCommentsAndStrings(source);
  const reads = [...body.matchAll(/(?:[A-Za-z0-9_$)\]])\s*(\[[^\]\n]+\])/g)].map((match) => match[1]!);
  return reads.filter((read) => !isApprovedComputedRead(read));
}

function isApprovedComputedRead(read: string): boolean {
  const content = read.slice(1, -1).trim();
  if (content === "" || /^[,\s]+$/.test(content)) return true;
  if (content.includes(",") || content.includes("...")) return false;
  if (content.includes("A-Za-z")) return true;
  if (/^[A-Za-z0-9_.]+\.length$/.test(content)) return true;
  return approvedComputedReadPatterns.some((pattern) => pattern.test(read));
}

function stripCommentsAndStrings(source: string): string {
  let output = "";
  let quote: "'" | '"' | "`" | undefined;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    const next = source[index + 1];
    if (lineComment) {
      output += char === "\n" ? "\n" : " ";
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        output += "  ";
        blockComment = false;
        index += 1;
      } else {
        output += char === "\n" ? "\n" : " ";
      }
      continue;
    }
    if (quote !== undefined) {
      output += char === "\n" ? "\n" : " ";
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "/" && next === "/") {
      output += "  ";
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      output += "  ";
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      output += " ";
      quote = char;
      continue;
    }
    output += char;
  }
  return output;
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

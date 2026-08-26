import { deflateSync, inflateSync } from "node:zlib";
import type {
  AcceptedExecutionJob,
  ObservationGraphV1,
  WebViewportV1,
} from "@qualigence/runner-protocol";
import type { Observer } from "@qualigence/runner-kernel";
import { WebTargetError, type PlaywrightBrowserSession } from "./browser-session.js";
import {
  buildObservationGraph,
  type ObservationCandidate,
} from "./observation-builder.js";
import type { CDPSession, Page } from "playwright";
import type { CapturedArtifact } from "./types.js";
import {
  MAX_REFLECTED_REGIONS,
  MAX_SENSITIVE_SHADOW_ROOTS,
  SENSITIVE_EVIDENCE_STATE_PROPERTY,
  SENSITIVE_MASK_ID_ATTRIBUTE,
  SENSITIVE_SHADOW_ROOTS_PROPERTY,
  SENSITIVE_TARGET_IDS_PROPERTY,
} from "./sensitive-evidence-authority.js";

export interface PlaywrightObserverHooks {
  readonly afterDomCollection?: (page: Page) => void | Promise<void>;
  readonly afterGraphAssembly?: (page: Page) => void | Promise<void>;
  readonly afterScreenshotCapture?: (page: Page) => void | Promise<void>;
}

type ScreenshotCaptureAttempt =
  | { readonly status: "ok"; readonly bytes: Uint8Array; readonly viewport?: WebViewportV1 }
  | { readonly status: "race" }
  | { readonly status: "failed" };

interface CssRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface CssViewport {
  readonly pageX: number;
  readonly pageY: number;
  readonly width: number;
  readonly height: number;
}

interface CdpMaskGeometrySnapshot {
  readonly fingerprint: string;
  readonly rects: readonly CssRect[];
  readonly viewport: CssViewport;
}

interface DecodedPngRgba {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

const PNG_SIGNATURE_HEX = "89504e470d0a1a0a";
const MAX_SCREENSHOT_PIXELS = 50_000_000;

function sensitiveEvidenceUnavailable(): WebTargetError {
  return new WebTargetError(
    "SensitiveEvidenceUnavailable",
    "Sensitive target evidence could not be proven.",
  );
}

async function captureScreenshotAttempt(
  page: Page,
  assertCaptureAuthority: () => void,
  maskIds: readonly string[],
  afterScreenshotCapture?: (page: Page) => void | Promise<void>,
): Promise<ScreenshotCaptureAttempt> {
  assertCaptureAuthority();
  if (maskIds.length === 0) {
    try {
      const bytes = new Uint8Array(await page.screenshot({ timeout: 5000 }));
      await afterScreenshotCapture?.(page);
      assertCaptureAuthority();
      return { status: "ok", bytes };
    } catch (error) {
      assertCaptureAuthority();
      throw error;
    }
  }
  if (maskIds.length > MAX_REFLECTED_REGIONS || maskIds.some((maskId) => !/^[A-Za-z0-9_-]+$/.test(maskId))) {
    return { status: "failed" };
  }
  if (typeof (page as { context?: unknown }).context !== "function") {
    return { status: "failed" };
  }

  let cdp: CDPSession | undefined;
  try {
    cdp = await page.context().newCDPSession(page);
    await cdp.send("DOM.enable");
    await cdp.send("Runtime.enable").catch(() => undefined);
    await cdp.send("Page.enable").catch(() => undefined);
    const before = await collectCdpMaskGeometry(cdp, maskIds);
    assertCaptureAuthority();
    const screenshot = new Uint8Array(await page.screenshot({ timeout: 5000 }));
    await afterScreenshotCapture?.(page);
    assertCaptureAuthority();
    const after = await collectCdpMaskGeometry(cdp, maskIds);
    if (before.fingerprint !== after.fingerprint) {
      return { status: "race" };
    }
    const decoded = decodePngRgba(screenshot);
    const bytes = encodePngRgba(maskPngRegions(decoded, before));
    return {
      status: "ok",
      bytes,
      viewport: {
        width: Math.max(1, Math.trunc(before.viewport.width)),
        height: Math.max(1, Math.trunc(before.viewport.height)),
        devicePixelRatio: safeRatio(decoded.width, before.viewport.width),
      },
    };
  } catch {
    assertCaptureAuthority();
    return { status: "failed" };
  } finally {
    await cdp?.detach().catch(() => undefined);
  }
}

async function collectCdpMaskGeometry(
  cdp: CDPSession,
  maskIds: readonly string[],
): Promise<CdpMaskGeometrySnapshot> {
  const viewport = cdpCssViewport(await cdp.send("Page.getLayoutMetrics"));
  await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
  const rects: CssRect[] = [];
  const sortedMaskIds = [...maskIds].sort();
  for (const maskId of sortedMaskIds) {
    const nodeIds = await cdpNodeIdsForMask(cdp, maskId);
    if (nodeIds.length !== 1) throw sensitiveEvidenceUnavailable();
    const nodeId = nodeIds[0];
    if (nodeId === undefined) throw sensitiveEvidenceUnavailable();
    if (!await cdpMaskNodeHasValidatedSensitiveAssociation(cdp, nodeId, maskId)) {
      throw sensitiveEvidenceUnavailable();
    }
    const rect = cdpBorderRect(await cdp.send("DOM.getBoxModel", { nodeId }));
    if (rect.width <= 0 || rect.height <= 0) continue;
    rects.push(rect);
    if (rects.length > MAX_REFLECTED_REGIONS) throw sensitiveEvidenceUnavailable();
  }
  return {
    fingerprint: JSON.stringify({ viewport: roundViewport(viewport), rects: rects.map(roundRect) }),
    rects,
    viewport,
  };
}

async function cdpMaskNodeHasValidatedSensitiveAssociation(
  cdp: CDPSession,
  nodeId: number,
  maskId: string,
): Promise<boolean> {
  const resolved = await cdp.send("DOM.resolveNode", { nodeId }) as { readonly object?: { readonly objectId?: string } };
  const objectId = resolved.object?.objectId;
  if (typeof objectId !== "string") return false;
  try {
    const validation = await cdp.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function(input) {
        const element = this;
        const state = window[input.stateProperty];
        const registry = window[input.runtimeRegistryProperty];
        const dom = registry && registry.nativeDom;
        if (!state || !dom || typeof dom.arrayIsArray !== "function" ||
          typeof dom.reflectApply !== "function" || typeof dom.elementGetAttribute !== "function") {
          return false;
        }
        const records = state.records;
        if (!dom.arrayIsArray(records)) return false;
        for (const record of records) {
          if (record === null || typeof record !== "object" || typeof record.markerId !== "string") continue;
          const elements = record.classifiedElements;
          if (!dom.arrayIsArray(elements)) continue;
          let ordinal = 0;
          for (let index = 0; index < elements.length; index += 1) {
            const classifiedElement = elements[index];
            const classifiedMaskId = dom.reflectApply(dom.elementGetAttribute, classifiedElement, [input.maskAttribute]);
            if (classifiedMaskId === null || classifiedMaskId === "") continue;
            ordinal += 1;
            if (classifiedElement !== element) continue;
            const expectedMaskId = "qm-" + record.markerId.replace(/[^A-Za-z0-9_-]/g, "_") + "-" + String(ordinal);
            return expectedMaskId === input.maskId && classifiedMaskId === input.maskId;
          }
        }
        return false;
      }`,
      arguments: [{ value: {
        maskAttribute: SENSITIVE_MASK_ID_ATTRIBUTE,
        maskId,
        runtimeRegistryProperty: SENSITIVE_SHADOW_ROOTS_PROPERTY,
        stateProperty: SENSITIVE_EVIDENCE_STATE_PROPERTY,
      } }],
      returnByValue: true,
      silent: true,
    }) as { readonly exceptionDetails?: unknown; readonly result?: { readonly value?: unknown } };
    return validation.exceptionDetails === undefined && validation.result?.value === true;
  } finally {
    await cdp.send("Runtime.releaseObject", { objectId }).catch(() => undefined);
  }
}

async function cdpNodeIdsForMask(cdp: CDPSession, maskId: string): Promise<readonly number[]> {
  const search = await cdp.send("DOM.performSearch", {
    query: `[${SENSITIVE_MASK_ID_ATTRIBUTE}="${maskId}"]`,
    includeUserAgentShadowDOM: true,
  }) as { readonly searchId?: string; readonly resultCount?: number };
  const searchId = search.searchId;
  const resultCount = search.resultCount;
  if (typeof searchId !== "string" || typeof resultCount !== "number" || !Number.isSafeInteger(resultCount) || resultCount < 0 || resultCount > MAX_REFLECTED_REGIONS) {
    throw sensitiveEvidenceUnavailable();
  }
  const boundedResultCount: number = resultCount;
  try {
    const results = await cdp.send("DOM.getSearchResults", {
      searchId,
      fromIndex: 0,
      toIndex: boundedResultCount,
    }) as { readonly nodeIds?: readonly number[] };
    const nodeIds = results.nodeIds;
    if (!Array.isArray(nodeIds)) return [];
    return nodeIds.every((nodeId): nodeId is number => Number.isSafeInteger(nodeId))
      ? nodeIds
      : [];
  } finally {
    await cdp.send("DOM.discardSearchResults", { searchId }).catch(() => undefined);
  }
}

function cdpCssViewport(metrics: unknown): CssViewport {
  const value = metrics as {
    readonly cssVisualViewport?: {
      readonly pageX?: number;
      readonly pageY?: number;
      readonly clientWidth?: number;
      readonly clientHeight?: number;
    };
    readonly visualViewport?: {
      readonly pageX?: number;
      readonly pageY?: number;
      readonly clientWidth?: number;
      readonly clientHeight?: number;
    };
  };
  const viewport = value.cssVisualViewport ?? value.visualViewport;
  const pageX = viewport?.pageX;
  const pageY = viewport?.pageY;
  const width = viewport?.clientWidth;
  const height = viewport?.clientHeight;
  if (!isFiniteSafeNumber(pageX) || !isFiniteSafeNumber(pageY) || !isFiniteSafeNumber(width) || !isFiniteSafeNumber(height)) {
    throw sensitiveEvidenceUnavailable();
  }
  if (width <= 0 || height <= 0) throw sensitiveEvidenceUnavailable();
  return { pageX, pageY, width, height };
}

function cdpBorderRect(boxModel: unknown): CssRect {
  const model = (boxModel as { readonly model?: { readonly border?: readonly number[]; readonly content?: readonly number[] } }).model;
  const quad = model?.border ?? model?.content;
  if (!Array.isArray(quad) || quad.length !== 8 || !quad.every(isFiniteSafeNumber)) {
    throw sensitiveEvidenceUnavailable();
  }
  const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!];
  const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!];
  const left = Math.min(...xs);
  const right = Math.max(...xs);
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);
  if (!isFiniteSafeNumber(left) || !isFiniteSafeNumber(right) || !isFiniteSafeNumber(top) || !isFiniteSafeNumber(bottom)) {
    throw sensitiveEvidenceUnavailable();
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function maskPngRegions(image: DecodedPngRgba, geometry: CdpMaskGeometrySnapshot): DecodedPngRgba {
  if (image.width <= 0 || image.height <= 0 || image.width * image.height > MAX_SCREENSHOT_PIXELS) {
    throw sensitiveEvidenceUnavailable();
  }
  const scaleX = safeRatio(image.width, geometry.viewport.width);
  const scaleY = safeRatio(image.height, geometry.viewport.height);
  const rgba = new Uint8Array(image.rgba);
  for (const rect of geometry.rects) {
    const left = Math.max(0, Math.floor((rect.x - geometry.viewport.pageX) * scaleX));
    const top = Math.max(0, Math.floor((rect.y - geometry.viewport.pageY) * scaleY));
    const right = Math.min(image.width, Math.ceil((rect.x + rect.width - geometry.viewport.pageX) * scaleX));
    const bottom = Math.min(image.height, Math.ceil((rect.y + rect.height - geometry.viewport.pageY) * scaleY));
    if (![left, top, right, bottom].every(Number.isSafeInteger)) throw sensitiveEvidenceUnavailable();
    if (right <= left || bottom <= top) continue;
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        const offset = ((y * image.width) + x) * 4;
        rgba[offset] = 0;
        rgba[offset + 1] = 0;
        rgba[offset + 2] = 0;
        rgba[offset + 3] = 255;
      }
    }
  }
  return { width: image.width, height: image.height, rgba };
}

function decodePngRgba(bytes: Uint8Array): DecodedPngRgba {
  const buffer = Buffer.from(bytes);
  if (buffer.length < 33 || buffer.subarray(0, 8).toString("hex") !== PNG_SIGNATURE_HEX) {
    throw sensitiveEvidenceUnavailable();
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  const idat: Buffer[] = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    offset += 4;
    const type = buffer.subarray(offset, offset + 4).toString("ascii");
    offset += 4;
    if (offset + length + 4 > buffer.length) throw sensitiveEvidenceUnavailable();
    const data = buffer.subarray(offset, offset + length);
    offset += length + 4;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      colorType = data[9] ?? -1;
      const compression = data[10];
      const filter = data[11];
      const interlace = data[12];
      if (bitDepth !== 8 || compression !== 0 || filter !== 0 || interlace !== 0) throw sensitiveEvidenceUnavailable();
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;
  if (width <= 0 || height <= 0 || channels === 0 || width * height > MAX_SCREENSHOT_PIXELS) {
    throw sensitiveEvidenceUnavailable();
  }
  const stride = width * channels;
  const inflated = inflateSync(Buffer.concat(idat));
  if (inflated.length !== (stride + 1) * height) throw sensitiveEvidenceUnavailable();
  const scanlines = new Uint8Array(stride * height);
  let source = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[source++] ?? -1;
    for (let x = 0; x < stride; x += 1) {
      const raw = inflated[source++] ?? 0;
      const left = x >= channels ? scanlines[(y * stride) + x - channels]! : 0;
      const up = y > 0 ? scanlines[((y - 1) * stride) + x]! : 0;
      const upperLeft = y > 0 && x >= channels ? scanlines[((y - 1) * stride) + x - channels]! : 0;
      scanlines[(y * stride) + x] = (raw + pngFilterDelta(filter, left, up, upperLeft)) & 0xff;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const input = index * channels;
    const output = index * 4;
    if (channels === 4) {
      rgba[output] = scanlines[input]!;
      rgba[output + 1] = scanlines[input + 1]!;
      rgba[output + 2] = scanlines[input + 2]!;
      rgba[output + 3] = scanlines[input + 3]!;
    } else if (channels === 3) {
      rgba[output] = scanlines[input]!;
      rgba[output + 1] = scanlines[input + 1]!;
      rgba[output + 2] = scanlines[input + 2]!;
      rgba[output + 3] = 255;
    } else {
      const value = scanlines[input]!;
      rgba[output] = value;
      rgba[output + 1] = value;
      rgba[output + 2] = value;
      rgba[output + 3] = 255;
    }
  }
  return { width, height, rgba };
}

function encodePngRgba(image: DecodedPngRgba): Uint8Array {
  if (image.rgba.length !== image.width * image.height * 4 || image.width * image.height > MAX_SCREENSHOT_PIXELS) {
    throw sensitiveEvidenceUnavailable();
  }
  const stride = image.width * 4;
  const raw = Buffer.alloc((stride + 1) * image.height);
  for (let y = 0; y < image.height; y += 1) {
    const output = y * (stride + 1);
    raw[output] = 0;
    Buffer.from(image.rgba.buffer, image.rgba.byteOffset + (y * stride), stride).copy(raw, output + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(image.width, 0);
  ihdr.writeUInt32BE(image.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return new Uint8Array(Buffer.concat([
    Buffer.from(PNG_SIGNATURE_HEX, "hex"),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]));
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return chunk;
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngFilterDelta(filter: number, left: number, up: number, upperLeft: number): number {
  if (filter === 0) return 0;
  if (filter === 1) return left;
  if (filter === 2) return up;
  if (filter === 3) return Math.floor((left + up) / 2);
  if (filter === 4) {
    const p = left + up - upperLeft;
    const pa = Math.abs(p - left);
    const pb = Math.abs(p - up);
    const pc = Math.abs(p - upperLeft);
    if (pa <= pb && pa <= pc) return left;
    if (pb <= pc) return up;
    return upperLeft;
  }
  throw sensitiveEvidenceUnavailable();
}

function safeRatio(numerator: number, denominator: number): number {
  if (!isFiniteSafeNumber(numerator) || !isFiniteSafeNumber(denominator) || denominator <= 0) {
    throw sensitiveEvidenceUnavailable();
  }
  const value = numerator / denominator;
  if (!Number.isFinite(value) || value <= 0) throw sensitiveEvidenceUnavailable();
  return value;
}

function isFiniteSafeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
}

function roundViewport(value: CssViewport): CssViewport {
  return {
    pageX: roundNumber(value.pageX),
    pageY: roundNumber(value.pageY),
    width: roundNumber(value.width),
    height: roundNumber(value.height),
  };
}

function roundRect(value: CssRect): CssRect {
  return {
    x: roundNumber(value.x),
    y: roundNumber(value.y),
    width: roundNumber(value.width),
    height: roundNumber(value.height),
  };
}

function roundNumber(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

async function readPageValue<T>(
  assertCaptureAuthority: () => void,
  read: () => Promise<T>,
): Promise<T> {
  assertCaptureAuthority();
  try {
    const value = await read();
    assertCaptureAuthority();
    return value;
  } catch (error) {
    assertCaptureAuthority();
    throw error;
  }
}

/**
 * Executed inside the page. Collects semantic candidates in DOM order without
 * exposing any selector to the caller. Password field values are never read.
 */
interface BrowserObservationCandidate extends ObservationCandidate {
  readonly sensitiveTargetIds?: readonly string[];
  readonly sensitiveMaskId?: string;
}

interface BrowserObservationCapture {
  readonly candidates: readonly BrowserObservationCandidate[];
  readonly sensitiveMaskIds: readonly string[];
  readonly viewport: WebViewportV1;
  readonly title?: string;
  readonly titleSensitiveTargetIds?: readonly string[];
  readonly sensitiveEvidenceUnavailable: boolean;
}

interface BrowserObservationCaptureInput {
  readonly sensitiveTargetIdsProperty: string;
  readonly sensitiveMaskIdAttribute: string;
  readonly sensitiveEvidenceStateProperty: string;
  readonly sensitiveShadowRootsProperty: string;
  readonly maxMaskRegions: number;
  readonly maxShadowRoots: number;
}

function browserObservationCaptureInput(): BrowserObservationCaptureInput {
  return {
    sensitiveTargetIdsProperty: SENSITIVE_TARGET_IDS_PROPERTY,
    sensitiveMaskIdAttribute: SENSITIVE_MASK_ID_ATTRIBUTE,
    sensitiveEvidenceStateProperty: SENSITIVE_EVIDENCE_STATE_PROPERTY,
    sensitiveShadowRootsProperty: SENSITIVE_SHADOW_ROOTS_PROPERTY,
    maxMaskRegions: MAX_REFLECTED_REGIONS,
    maxShadowRoots: MAX_SENSITIVE_SHADOW_ROOTS,
  };
}

async function collectAuthorizedPageObservation(
  page: Page,
  assertCaptureAuthority: () => void,
): Promise<BrowserObservationCapture> {
  return readPageValue(
    assertCaptureAuthority,
    async () => (await page.evaluate(
      collectPageObservation,
      browserObservationCaptureInput(),
    )) as BrowserObservationCapture,
  );
}

type SensitiveEvidenceRetirement = "retired" | "pending" | "unavailable";

async function retireCapturedSensitiveEvidence(
  page: Page,
  assertCaptureAuthority: () => void,
): Promise<SensitiveEvidenceRetirement> {
  return readPageValue(
    assertCaptureAuthority,
    async () => (await page.evaluate(
      retirePageSensitiveEvidence,
      SENSITIVE_EVIDENCE_STATE_PROPERTY,
    )) as SensitiveEvidenceRetirement,
  );
}

function retirePageSensitiveEvidence(stateProperty: string): SensitiveEvidenceRetirement {
  const state = (window as unknown as Record<string, unknown>)[stateProperty] as {
    active?: unknown;
    poisoned?: boolean;
    records?: { readonly observer?: { disconnect(): void } }[];
    retainedSchedulerEpochs?: { pendingSchedulerCallbacks?: number; processSchedulerCallback?: () => void }[];
  } | undefined;
  if (state === undefined) return "retired";
  if (state.active !== undefined && state.active !== null) return "unavailable";
  if (state.poisoned === true) return "unavailable";
  if ((state.retainedSchedulerEpochs ?? []).some((epoch) => (epoch.pendingSchedulerCallbacks ?? 0) > 0)) {
    return "pending";
  }
  for (const record of state.records ?? []) {
    record.observer?.disconnect();
  }
  for (const epoch of state.retainedSchedulerEpochs ?? []) {
    delete epoch.processSchedulerCallback;
  }
  state.records = [];
  state.retainedSchedulerEpochs = [];
  return "retired";
}

function collectPageObservation(
  input: BrowserObservationCaptureInput,
): BrowserObservationCapture {
  type NativeDomAuthority = {
    readonly arrayFrom: typeof Array.from;
    readonly arrayIsArray: typeof Array.isArray;
    readonly documentGetElementById: typeof Document.prototype.getElementById;
    readonly documentQuerySelector: typeof Document.prototype.querySelector;
    readonly documentTitleGet: (() => string) | undefined;
    readonly documentQuerySelectorAll: typeof Document.prototype.querySelectorAll;
    readonly documentFragmentQuerySelectorAll: typeof DocumentFragment.prototype.querySelectorAll;
    readonly elementClosest: typeof Element.prototype.closest;
    readonly elementGetAttribute: typeof Element.prototype.getAttribute;
    readonly elementGetClientRects: typeof Element.prototype.getClientRects;
    readonly elementHasAttribute: typeof Element.prototype.hasAttribute;
    readonly elementRemoveAttribute: typeof Element.prototype.removeAttribute;
    readonly elementSetAttribute: typeof Element.prototype.setAttribute;
    readonly elementShadowRootGet: (() => ShadowRoot | null) | undefined;
    readonly elementTagNameGet: (() => string) | undefined;
    readonly htmlElementHiddenGet: (() => boolean) | undefined;
    readonly htmlInputElementPlaceholderGet: (() => string) | undefined;
    readonly htmlInputElementValueGet: (() => string) | undefined;
    readonly htmlOptionElementTextGet: (() => string) | undefined;
    readonly htmlOptionElementValueGet: (() => string) | undefined;
    readonly htmlSelectElementSelectedOptionsGet: (() => HTMLCollectionOf<HTMLOptionElement>) | undefined;
    readonly htmlSelectElementValueGet: (() => string) | undefined;
    readonly htmlTextAreaElementPlaceholderGet: (() => string) | undefined;
    readonly htmlTextAreaElementValueGet: (() => string) | undefined;
    readonly nodeChildNodesGet: (() => NodeListOf<ChildNode>) | undefined;
    readonly nodeGetRootNode: typeof Node.prototype.getRootNode;
    readonly nodeTextContentGet: (() => string | null) | undefined;
    readonly characterDataDataGet: (() => string) | undefined;
    readonly shadowRootHostGet: (() => Element) | undefined;
    readonly shadowRootModeGet: (() => ShadowRootMode) | undefined;
    readonly windowGetComputedStyle: typeof window.getComputedStyle;
  };
  const nativeDom = ((window as unknown as Record<string, { readonly nativeDom?: NativeDomAuthority } | undefined>)[input.sensitiveShadowRootsProperty])?.nativeDom;
  if (nativeDom === undefined) {
    return {
      candidates: [],
      sensitiveMaskIds: [],
      viewport: { width: 1, height: 1, devicePixelRatio: 1 },
      sensitiveEvidenceUnavailable: true,
    };
  }
  const dom: NativeDomAuthority = nativeDom;

  const arrayFrom = <T>(items: ArrayLike<T> | Iterable<T>): T[] => dom.arrayFrom(items as ArrayLike<T>) as T[];
  const getAttribute = (element: Element, name: string): string | null => dom.elementGetAttribute.call(element, name);
  const hasAttribute = (element: Element, name: string): boolean => dom.elementHasAttribute.call(element, name);
  const removeAttribute = (element: Element, name: string): void => { dom.elementRemoveAttribute.call(element, name); };
  const setAttribute = (element: Element, name: string, value: string): void => { dom.elementSetAttribute.call(element, name, value); };
  const queryDocument = (selector: string): Element[] => arrayFrom(dom.documentQuerySelectorAll.call(document, selector));
  const queryDocumentOne = (selector: string): Element | null => dom.documentQuerySelector.call(document, selector);
  const queryRoot = (root: ShadowRoot, selector: string): Element[] => arrayFrom(dom.documentFragmentQuerySelectorAll.call(root, selector));
  const closest = (element: Element, selector: string): Element | null => dom.elementClosest.call(element, selector);
  const tagName = (element: Element): string => dom.elementTagNameGet!.call(element).toLowerCase();
  const textContent = (node: Node): string => dom.nodeTextContentGet!.call(node) ?? "";
  const childNodes = (node: Node): ChildNode[] => arrayFrom(dom.nodeChildNodesGet!.call(node));
  const getRootNode = (node: Node): Node => dom.nodeGetRootNode.call(node);
  const textData = (node: Text): string => dom.characterDataDataGet!.call(node);
  const shadowRoot = (element: Element): ShadowRoot | null => dom.elementShadowRootGet!.call(element);
  const shadowRootMode = (root: ShadowRoot): ShadowRootMode => dom.shadowRootModeGet!.call(root);
  const shadowRootHost = (root: ShadowRoot): Element => dom.shadowRootHostGet!.call(root);
  const inputValue = (element: Element): string => dom.htmlInputElementValueGet!.call(element);
  const inputPlaceholder = (element: Element): string => dom.htmlInputElementPlaceholderGet!.call(element);
  const textareaValue = (element: Element): string => dom.htmlTextAreaElementValueGet!.call(element);
  const textareaPlaceholder = (element: Element): string => dom.htmlTextAreaElementPlaceholderGet!.call(element);
  const selectValue = (element: Element): string => dom.htmlSelectElementValueGet!.call(element);
  const selectedOptions = (element: Element): HTMLOptionElement[] => arrayFrom(dom.htmlSelectElementSelectedOptionsGet!.call(element));
  const optionText = (option: HTMLOptionElement): string => dom.htmlOptionElementTextGet!.call(option);
  const optionValue = (option: HTMLOptionElement): string => dom.htmlOptionElementValueGet!.call(option);
  const isTag = (element: Element, name: string): boolean => tagName(element) === name;

  function isVisible(element: Element): boolean {
    const style = dom.windowGetComputedStyle.call(window, element);
    if (dom.htmlElementHiddenGet !== undefined && dom.htmlElementHiddenGet.call(element) === true) {
      return false;
    }
    if (style.display === "none" || style.visibility === "hidden") {
      return false;
    }
    return dom.elementGetClientRects.call(element).length > 0;
  }

  function roleOf(element: Element): string {
    const explicit = getAttribute(element, "role");
    if (explicit) {
      return explicit;
    }
    const tag = tagName(element);
    if (tag === "button") {
      return "button";
    }
    if (tag === "a" && hasAttribute(element, "href")) {
      return "link";
    }
    if (tag === "select") {
      return "combobox";
    }
    if (tag === "textarea") {
      return "textbox";
    }
    if (tag === "input") {
      const type = (getAttribute(element, "type") ?? "text").toLowerCase();
      if (type === "button" || type === "submit" || type === "reset") {
        return "button";
      }
      if (type === "checkbox") {
        return "checkbox";
      }
      if (type === "radio") {
        return "radio";
      }
      return "textbox";
    }
    return "text";
  }

  function accessibleName(element: Element): string {
    const ariaLabel = getAttribute(element, "aria-label");
    if (ariaLabel && ariaLabel.trim() !== "") {
      return ariaLabel;
    }
    const labelledBy = getAttribute(element, "aria-labelledby");
    if (labelledBy) {
      const joined = labelledBy
        .split(/\s+/)
        .map((id) => dom.documentGetElementById.call(document, id))
        .filter((node): node is HTMLElement => node !== null)
        .map((node) => textContent(node))
        .join(" ")
        .trim();
      if (joined !== "") {
        return joined;
      }
    }
    const elementId = getAttribute(element, "id") ?? "";
    if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(elementId)) {
      const label = queryDocumentOne(`label[for="${elementId}"]`);
      const labelText = label === null ? "" : textContent(label);
      if (labelText.trim() !== "") {
        return labelText;
      }
    }
    const wrapping = closest(element, "label");
    const wrappingText = wrapping === null ? "" : textContent(wrapping);
    if (wrappingText.trim() !== "") {
      return wrappingText;
    }
    const tag = tagName(element);
    if (tag === "button" || tag === "a" || getAttribute(element, "role") === "button") {
      const content = textContent(element);
      if (content.trim() !== "") {
        return content;
      }
    }
    if (isTag(element, "input")) {
      const type = (getAttribute(element, "type") ?? "text").toLowerCase();
      const value = inputValue(element);
      if (
        (type === "submit" || type === "button" || type === "reset") &&
        value !== ""
      ) {
        return value;
      }
      const placeholder = inputPlaceholder(element);
      if (placeholder !== "") {
        return placeholder;
      }
    }
    return "";
  }

  function readSensitiveTargetIds(element: Element): readonly string[] {
    const ids = new Set<string>();
    const value = (element as unknown as Element & Record<string, unknown>)[input.sensitiveTargetIdsProperty];
    if (dom.arrayIsArray(value) && value.every((entry) => typeof entry === "string")) {
      for (const markerId of value) ids.add(markerId);
    }
    const state = (window as unknown as Record<string, unknown>)[input.sensitiveEvidenceStateProperty] as {
      readonly records?: readonly { readonly markerId: string; readonly classifiedElements?: readonly Element[] }[];
    } | undefined;
    const records = state?.records ?? [];
    if (dom.arrayIsArray(records)) {
      for (const record of records) {
        if (typeof record.markerId !== "string" || !dom.arrayIsArray(record.classifiedElements)) continue;
        if (record.classifiedElements.includes(element)) ids.add(record.markerId);
      }
    }
    return [...ids];
  }

  function sensitiveValues(element: Element): readonly string[] {
    const values: string[] = [];
    const text = directText(element);
    if (text !== "") values.push(text);
    if (isTag(element, "input")) {
      const value = inputValue(element);
      const placeholder = inputPlaceholder(element);
      if (value !== "") values.push(value);
      if (placeholder !== "") values.push(placeholder);
    }
    if (isTag(element, "textarea")) {
      const value = textareaValue(element);
      const placeholder = textareaPlaceholder(element);
      if (value !== "") values.push(value);
      if (placeholder !== "") values.push(placeholder);
    }
    if (isTag(element, "select")) {
      const value = selectValue(element);
      if (value !== "") values.push(value);
      const selected = selectedOptions(element)[0];
      const selectedText = selected === undefined ? "" : optionText(selected);
      if (selectedText !== "") values.push(selectedText);
    }
    for (const attribute of ["aria-label", "title", "value"] as const) {
      const attributeValue = getAttribute(element, attribute);
      if (attributeValue !== null && attributeValue !== "") values.push(attributeValue);
    }
    return values;
  }

  function directText(element: Element): string {
    return childNodes(element)
      .filter((node): node is Text => node.nodeType === 3)
      .map((node) => textData(node))
      .join("");
  }

  function carriesForm(value: string, forms: readonly string[]): boolean {
    for (const form of forms) {
      if (value === form || (form !== "" && value.includes(form))) return true;
    }
    return false;
  }

  function hasSensitiveTargetId(ids: readonly string[], markerId: string): boolean {
    return ids.includes(markerId);
  }

  function baselineAllows(element: Element, markerId: string, value: string): boolean {
    const state = (window as unknown as Record<string, unknown>)[input.sensitiveEvidenceStateProperty] as {
      readonly records?: readonly {
        readonly markerId: string;
        readonly baseline?: WeakMap<Element, ReadonlySet<string>>;
      }[];
    } | undefined;
    const record = state?.records?.find((candidate) => candidate.markerId === markerId);
    return record?.baseline?.get(element)?.has(value) === true;
  }

  function shadowBaselineAllows(node: Node, markerId: string, value: string): boolean {
    const state = (window as unknown as Record<string, unknown>)[input.sensitiveEvidenceStateProperty] as {
      readonly records?: readonly {
        readonly markerId: string;
        readonly shadowBaseline?: WeakMap<Node, ReadonlySet<string>>;
      }[];
    } | undefined;
    const record = state?.records?.find((candidate) => candidate.markerId === markerId);
    return record?.shadowBaseline?.get(node)?.has(value) === true;
  }

  function sensitiveEvidenceUnavailable(): boolean {
    const state = (window as unknown as Record<string, unknown>)[input.sensitiveEvidenceStateProperty] as {
      active?: unknown;
      poisoned?: boolean;
      readonly records?: readonly {
        readonly markerId: string;
        readonly forms: readonly string[];
        readonly shadowBaseline?: WeakMap<Node, ReadonlySet<string>>;
      }[];
    } | undefined;
    if (state === undefined) return false;
    if (state.active !== undefined && state.active !== null) return true;
    if (state.poisoned === true) return true;
    const records = state.records ?? [];
    if (records.length > 0 && shadowRootOverflow()) return true;
    for (const element of queryDocument("*")) {
      const ids = readSensitiveTargetIds(element);
      for (const record of records) {
        for (const value of sensitiveValues(element)) {
          if (!carriesForm(value, record.forms)) continue;
          if (hasSensitiveTargetId(ids, record.markerId)) continue;
          if (baselineAllows(element, record.markerId, value)) continue;
          return true;
        }
      }
    }
    for (const root of shadowRoots()) {
      for (const record of records) {
        for (const value of shadowRootValues(root)) {
          if (!carriesForm(value, record.forms) || shadowBaselineAllows(root, record.markerId, value)) {
            continue;
          }
          if (shadowRootMode(root) === "open" && openRootValueCoveredBySensitiveMarker(root, record.markerId, value)) {
            continue;
          }
          return true;
        }
        for (const element of queryRoot(root, "*")) {
          const ids = readSensitiveTargetIds(element);
          for (const value of sensitiveValues(element)) {
            if (!carriesForm(value, record.forms)) continue;
            if (shadowRootMode(root) === "open" && hasSensitiveTargetId(ids, record.markerId)) continue;
            if (shadowBaselineAllows(element, record.markerId, value)) continue;
            return true;
          }
        }
      }
    }
    return false;
  }

  function shadowRootValues(root: ShadowRoot): readonly string[] {
    const values: string[] = [];
    const direct = childNodes(root)
      .filter((node): node is Text => node.nodeType === 3)
      .map((node) => textData(node))
      .join("");
    if (direct !== "") values.push(direct);
    const fullText = textContent(root);
    if (fullText !== "" && fullText !== direct) values.push(fullText);
    return values;
  }

  function observableElements(selector: string): Element[] {
    const elements = queryDocument(selector);
    for (const root of shadowRoots().filter((candidate) => shadowRootMode(candidate) === "open")) {
      elements.push(...queryRoot(root, selector));
    }
    return elements;
  }

  function openRootValueCoveredBySensitiveMarker(root: ShadowRoot, markerId: string, value: string): boolean {
    if (hasSensitiveTargetId(readSensitiveTargetIds(shadowRootHost(root)), markerId)) return true;
    for (const element of queryRoot(root, "*")) {
      if (!hasSensitiveTargetId(readSensitiveTargetIds(element), markerId)) continue;
      if (sensitiveValues(element).some((candidate) => value === candidate || (candidate !== "" && value.includes(candidate)))) {
        return true;
      }
    }
    return false;
  }

  function shadowRootOverflow(): boolean {
    const registry = (window as unknown as Record<string, unknown>)[input.sensitiveShadowRootsProperty] as {
      readonly shadowRootOverflow?: unknown;
    } | undefined;
    if (registry?.shadowRootOverflow === true) return true;
    shadowRoots();
    return registry?.shadowRootOverflow === true;
  }

  function authoritativeSensitiveMaskIds(): { readonly status: "ok"; readonly ids: readonly string[] } | { readonly status: "failed" } {
    const state = (window as unknown as Record<string, unknown>)[input.sensitiveEvidenceStateProperty] as {
      readonly records?: readonly {
        readonly markerId: string;
        readonly forms?: readonly string[];
        readonly classifiedElements?: readonly Element[];
        readonly classifiedRegions?: ReadonlySet<string>;
        readonly poisoned?: boolean;
      }[];
      readonly poisoned?: boolean;
    } | undefined;
    if (state === undefined) return { status: "ok", ids: [] };
    if (state.poisoned === true) return { status: "failed" };
    const maskIds = new Set<string>();
    const records = state.records ?? [];
    if (!dom.arrayIsArray(records)) return { status: "failed" };
    for (const record of records) {
      if (record.poisoned === true) return { status: "failed" };
      const elements = record.classifiedElements ?? [];
      if (!dom.arrayIsArray(elements)) return { status: "failed" };
      if ((record.classifiedRegions?.size ?? elements.length) > input.maxMaskRegions) return { status: "failed" };
      let ordinal = 0;
      for (const element of elements) {
        if (element.nodeType !== 1) return { status: "failed" };
        if (!isVisible(element)) {
          removeAttribute(element, input.sensitiveMaskIdAttribute);
          continue;
        }
        const root = getRootNode(element);
        if (root !== element.ownerDocument && (!isShadowRootNode(root) || shadowRootMode(root) !== "open")) {
          return { status: "failed" };
        }
        ordinal += 1;
        const id = `qm-${record.markerId.replace(/[^A-Za-z0-9_-]/g, "_")}-${ordinal}`;
        setAttribute(element, input.sensitiveMaskIdAttribute, id);
        if (getAttribute(element, input.sensitiveMaskIdAttribute) !== id) return { status: "failed" };
        maskIds.add(id);
        if (maskIds.size > input.maxMaskRegions) return { status: "failed" };
      }
    }
    return { status: "ok", ids: [...maskIds] };
  }

  function isShadowRootNode(node: Node): node is ShadowRoot {
    return node.nodeType === 11 && "host" in node;
  }

  function shadowRoots(): ShadowRoot[] {
    const roots = new Set<ShadowRoot>();
    const pending: ShadowRoot[] = [];
    const registry = (window as unknown as Record<string, unknown>)[input.sensitiveShadowRootsProperty] as {
      readonly roots?: readonly unknown[];
      shadowRootOverflow?: boolean;
    } | undefined;
    const noteOverflow = (): void => {
      if (registry !== undefined) registry.shadowRootOverflow = true;
    };
    const addRoot = (root: ShadowRoot): boolean => {
      if (roots.has(root)) return true;
      if (pending.length >= input.maxShadowRoots) {
        noteOverflow();
        return false;
      }
      roots.add(root);
      pending.push(root);
      return true;
    };
    for (const root of registry?.roots ?? []) {
      if (typeof (root as { readonly nodeType?: unknown }).nodeType === "number" && isShadowRootNode(root as Node) && !addRoot(root as ShadowRoot)) return pending;
    }
    for (const element of queryDocument("*")) {
      const root = shadowRoot(element);
      if (root !== null && !addRoot(root)) return pending;
    }
    for (let index = 0; index < pending.length; index += 1) {
      const root = pending[index]!;
      for (const element of queryRoot(root, "*")) {
        const nestedShadowRoot = shadowRoot(element);
        if (nestedShadowRoot !== null && !addRoot(nestedShadowRoot)) return pending;
      }
    }
    return pending;
  }

  const maskAuthority = authoritativeSensitiveMaskIds();
  const selector =
    `button, a[href], input, textarea, select, [role], [data-qualigence-observe], [${input.sensitiveMaskIdAttribute}]`;
  const elements = observableElements(selector);
  const candidates: BrowserObservationCandidate[] = [];
  const sensitiveMaskIds = new Set<string>(maskAuthority.status === "ok" ? maskAuthority.ids : []);
  const titleElement = queryDocumentOne("title");

  for (const element of elements) {
    const sensitiveTargetIds = readSensitiveTargetIds(element);
    const isSensitiveTarget = sensitiveTargetIds.length > 0;
    const sensitiveMaskId = getAttribute(element, input.sensitiveMaskIdAttribute) ?? undefined;
    if (!isVisible(element)) {
      continue;
    }
    const role = roleOf(element);
    const name = accessibleName(element).trim();
    const isFormField = isTag(element, "input") || isTag(element, "textarea");
    let value: string | undefined;
    if (isTag(element, "input")) {
      const type = (getAttribute(element, "type") ?? "text").toLowerCase();
      const observedValue = inputValue(element);
      if (type !== "password" && observedValue !== "") {
        value = observedValue;
      }
    } else if (isTag(element, "textarea")) {
      const observedValue = textareaValue(element);
      if (observedValue !== "") {
        value = observedValue;
      }
    } else if (isSensitiveTarget && isTag(element, "select") && selectValue(element) !== "") {
      value = selectValue(element);
    }

    const interactive =
      role === "button" ||
      role === "link" ||
      role === "textbox" ||
      role === "checkbox" ||
      role === "radio" ||
      role === "combobox";
    let text: string | undefined;
    if (!interactive || hasAttribute(element, "data-qualigence-observe")) {
      const content = textContent(element);
      if (content.trim() !== "") {
        text = content;
      }
    } else if (isSensitiveTarget && isTag(element, "select")) {
      const selected = selectedOptions(element)[0];
      const selectedText = selected === undefined ? "" : optionText(selected);
      if (selectedText.trim() !== "") {
        text = selectedText;
      }
    }

    const disabled =
      (element as HTMLButtonElement).disabled === true ||
      getAttribute(element, "aria-disabled") === "true";

    const candidate: BrowserObservationCandidate = {
      role,
      ...(name !== "" ? { name } : {}),
      ...(text !== undefined ? { text } : {}),
      ...(value !== undefined ? { value } : {}),
      ...(disabled ? { disabled: true } : {}),
      ...(sensitiveTargetIds.length > 0 ? { sensitiveTargetIds } : {}),
      ...(sensitiveMaskId !== undefined ? { sensitiveMaskId } : {}),
    };
    candidates.push(candidate);
  }

  return {
    candidates,
    sensitiveMaskIds: [...sensitiveMaskIds],
    viewport: {
      width: Math.max(1, Math.trunc(window.innerWidth)),
      height: Math.max(1, Math.trunc(window.innerHeight)),
      devicePixelRatio: window.devicePixelRatio,
    },
    title: dom.documentTitleGet!.call(document),
    ...(titleElement === null ? {} : { titleSensitiveTargetIds: readSensitiveTargetIds(titleElement) }),
    sensitiveEvidenceUnavailable: maskAuthority.status === "failed" || sensitiveEvidenceUnavailable(),
  };
}

function buildArtifacts(
  ordinal: number,
  graph: ObservationGraphV1,
  screenshot: Uint8Array,
): CapturedArtifact[] {
  const json = new TextEncoder().encode(JSON.stringify(graph));
  return [
    {
      name: `${ordinal}-observation.json`,
      mediaType: "application/json",
      bytes: json,
    },
    {
      name: `${ordinal}.png`,
      mediaType: "image/png",
      bytes: screenshot,
    },
  ];
}

export class PlaywrightObserver implements Observer {
  constructor(
    private readonly session: PlaywrightBrowserSession,
    private readonly hooks: PlaywrightObserverHooks = {},
  ) {}

  async capture(job: AcceptedExecutionJob): Promise<ObservationGraphV1> {
    return this.session.withPage(async (page) => {
      const ordinal = this.session.nextObservationOrdinal();
      const navigationGeneration = this.session.currentNavigationGeneration;
      const assertCaptureAuthority = (): void => {
        this.session.assertPageTargetOrigin(page, navigationGeneration);
      };

      for (let attempt = 0; attempt < 2; attempt += 1) {
        this.session.assertSensitiveEvidenceAvailable();
        const captured = await collectAuthorizedPageObservation(page, assertCaptureAuthority);
        if (captured.sensitiveEvidenceUnavailable) {
          this.session.markSensitiveEvidenceUnavailable();
        }
        this.session.assertSensitiveEvidenceAvailable();
        await this.hooks.afterDomCollection?.(page);
        const preScreenshotCheck = await collectAuthorizedPageObservation(page, assertCaptureAuthority);
        if (preScreenshotCheck.sensitiveEvidenceUnavailable) {
          this.session.markSensitiveEvidenceUnavailable();
        }
        assertCaptureAuthority();
        this.session.assertSensitiveEvidenceAvailable();
        const raw = captured.candidates.map((candidate) => ({
          role: candidate.role,
          ...(candidate.name === undefined ? {} : {
            name: this.session.redactSensitiveTargetField(
              candidate.sensitiveTargetIds,
              candidate.name,
            ),
          }),
          ...(candidate.text === undefined ? {} : {
            text: this.session.redactSensitiveTargetField(
              candidate.sensitiveTargetIds,
              candidate.text,
            ),
          }),
          ...(candidate.value === undefined ? {} : {
            value: this.session.redactSensitiveTargetField(
              candidate.sensitiveTargetIds,
              candidate.value,
            ),
          }),
          ...(candidate.disabled === undefined ? {} : { disabled: candidate.disabled }),
          ...(candidate.sensitiveTargetIds !== undefined && candidate.sensitiveTargetIds.length > 0
            ? { sensitive: true }
            : {}),
        }));
        const url = this.session.assertPageTargetOrigin(page, navigationGeneration);
        const title = captured.title === undefined
          ? await readPageValue(
              assertCaptureAuthority,
              () => page.title(),
            )
          : this.session.redactSensitiveTitleField(
              captured.titleSensitiveTargetIds,
              captured.title,
            );

        assertCaptureAuthority();
        await this.hooks.afterGraphAssembly?.(page);
        await this.session.revalidateSensitivePromiseOwners(page, navigationGeneration);

        const maskIds = [...new Set([
          ...(captured.sensitiveMaskIds ?? []),
          ...(preScreenshotCheck.sensitiveMaskIds ?? []),
        ].filter((maskId) => /^[A-Za-z0-9_-]+$/.test(maskId)))];
        if (this.session.hasPendingSensitiveEvidenceCapture() && maskIds.length === 0) {
          this.session.markSensitiveEvidenceUnavailable();
          throw sensitiveEvidenceUnavailable();
        }
        const screenshotAttempt = await captureScreenshotAttempt(
          page,
          assertCaptureAuthority,
          maskIds,
          this.hooks.afterScreenshotCapture,
        );
        if (screenshotAttempt.status === "race") {
          if (attempt === 0) continue;
          this.session.markSensitiveEvidenceUnavailable();
          throw sensitiveEvidenceUnavailable();
        }
        if (screenshotAttempt.status === "failed") {
          this.session.markSensitiveEvidenceUnavailable();
          throw sensitiveEvidenceUnavailable();
        }
        const postScreenshotCheck = await collectAuthorizedPageObservation(page, assertCaptureAuthority);
        if (postScreenshotCheck.sensitiveEvidenceUnavailable) {
          this.session.markSensitiveEvidenceUnavailable();
        }
        assertCaptureAuthority();
        this.session.assertSensitiveEvidenceAvailable();
        let retirement: SensitiveEvidenceRetirement = "retired";
        if (this.session.hasPendingSensitiveEvidenceCapture()) {
          retirement = await retireCapturedSensitiveEvidence(page, assertCaptureAuthority);
          if (retirement === "unavailable") {
            this.session.markSensitiveEvidenceUnavailable();
          }
        }
        this.session.assertSensitiveEvidenceAvailable();
        const artifactNames = [`${ordinal}-observation.json`, `${ordinal}.png`];
        const { graph, descriptors } = buildObservationGraph(
          job.runId,
          ordinal,
          raw,
          {
            url,
            targetId: new URL(this.session.targetUrl).origin,
            title,
            capturedAt: new Date().toISOString(),
            viewport: screenshotAttempt.viewport ?? captured.viewport,
            allowedQueryKeys: this.session.allowedWebQueryKeys,
            evidenceRefs: artifactNames,
          },
        );
        assertCaptureAuthority();
        const artifacts = buildArtifacts(ordinal, graph, screenshotAttempt.bytes);
        await this.session.revalidateSensitivePromiseOwners(page, navigationGeneration);
        this.session.registerCapturedObservation(page, graph.graphId, {
          descriptors,
          artifacts,
        }, navigationGeneration);
        if (retirement === "retired") {
          this.session.completeSensitiveEvidenceCapture();
        }
        return graph;
      }

      this.session.markSensitiveEvidenceUnavailable();
      throw sensitiveEvidenceUnavailable();
    });
  }
}

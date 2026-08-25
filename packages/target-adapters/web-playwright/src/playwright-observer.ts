import type {
  AcceptedExecutionJob,
  ObservationGraphV1,
  WebViewportV1,
} from "@qualigence/runner-protocol";
import type { Observer } from "@qualigence/runner-kernel";
import type { PlaywrightBrowserSession } from "./browser-session.js";
import {
  buildObservationGraph,
  type ObservationCandidate,
} from "./observation-builder.js";
import type { Page } from "playwright";
import type { CapturedArtifact } from "./types.js";
import {
  SENSITIVE_EVIDENCE_STATE_PROPERTY,
  SENSITIVE_MASK_ID_ATTRIBUTE,
  SENSITIVE_SHADOW_ROOTS_PROPERTY,
  SENSITIVE_TARGET_IDS_PROPERTY,
} from "./sensitive-evidence-authority.js";

export interface PlaywrightObserverHooks {
  readonly afterDomCollection?: (page: Page) => void | Promise<void>;
}

async function captureScreenshot(
  page: Page,
  assertCaptureAuthority: () => void,
  maskIds: readonly string[],
): Promise<Uint8Array> {
  let lastError: unknown;
  const mask = maskIds.map((maskId) => page.locator(
    `[${SENSITIVE_MASK_ID_ATTRIBUTE}="${maskId}"]`,
  ));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assertCaptureAuthority();
    let screenshot: Uint8Array;
    try {
      screenshot = new Uint8Array(await page.screenshot({
        timeout: 5000,
        ...(mask.length === 0 ? {} : { mask, maskColor: "#000000" }),
      }));
    } catch (error) {
      assertCaptureAuthority();
      lastError = error;
      await page.waitForTimeout(50);
      continue;
    }
    assertCaptureAuthority();
    return screenshot;
  }
  throw lastError;
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
}

function browserObservationCaptureInput(): BrowserObservationCaptureInput {
  return {
    sensitiveTargetIdsProperty: SENSITIVE_TARGET_IDS_PROPERTY,
    sensitiveMaskIdAttribute: SENSITIVE_MASK_ID_ATTRIBUTE,
    sensitiveEvidenceStateProperty: SENSITIVE_EVIDENCE_STATE_PROPERTY,
    sensitiveShadowRootsProperty: SENSITIVE_SHADOW_ROOTS_PROPERTY,
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

async function retireCapturedSensitiveEvidence(
  page: Page,
  assertCaptureAuthority: () => void,
): Promise<boolean> {
  return readPageValue(
    assertCaptureAuthority,
    async () => {
      const result = await page.evaluate(
        retirePageSensitiveEvidence,
        SENSITIVE_EVIDENCE_STATE_PROPERTY,
      );
      return result === true;
    },
  );
}

function retirePageSensitiveEvidence(stateProperty: string): boolean {
  const state = (window as unknown as Record<string, unknown>)[stateProperty] as {
    active?: unknown;
    poisoned?: boolean;
    records?: unknown[];
  } | undefined;
  if (state === undefined) return false;
  if (state.active !== undefined && state.active !== null) return true;
  if (state.poisoned === true) return true;
  state.records = [];
  return false;
}

function collectPageObservation(
  input: BrowserObservationCaptureInput,
): BrowserObservationCapture {
  function isVisible(element: Element): boolean {
    if (!(element instanceof HTMLElement)) {
      return true;
    }
    if (element.hidden) {
      return false;
    }
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") {
      return false;
    }
    return element.getClientRects().length > 0;
  }

  function roleOf(element: Element): string {
    const explicit = element.getAttribute("role");
    if (explicit) {
      return explicit;
    }
    const tag = element.tagName.toLowerCase();
    if (tag === "button") {
      return "button";
    }
    if (tag === "a" && element.hasAttribute("href")) {
      return "link";
    }
    if (tag === "select") {
      return "combobox";
    }
    if (tag === "textarea") {
      return "textbox";
    }
    if (tag === "input") {
      const type = (element.getAttribute("type") ?? "text").toLowerCase();
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
    const ariaLabel = element.getAttribute("aria-label");
    if (ariaLabel && ariaLabel.trim() !== "") {
      return ariaLabel;
    }
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const joined = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter((node): node is HTMLElement => node !== null)
        .map((node) => node.textContent ?? "")
        .join(" ")
        .trim();
      if (joined !== "") {
        return joined;
      }
    }
    if (element.id !== "") {
      const escaped =
        typeof CSS !== "undefined" && CSS.escape
          ? CSS.escape(element.id)
          : element.id;
      const label = document.querySelector(`label[for="${escaped}"]`);
      if (label && label.textContent && label.textContent.trim() !== "") {
        return label.textContent;
      }
    }
    const wrapping = element.closest("label");
    if (wrapping && wrapping.textContent && wrapping.textContent.trim() !== "") {
      return wrapping.textContent;
    }
    const tag = element.tagName.toLowerCase();
    if (tag === "button" || tag === "a" || element.getAttribute("role") === "button") {
      if (element.textContent && element.textContent.trim() !== "") {
        return element.textContent;
      }
    }
    if (element instanceof HTMLInputElement) {
      const type = (element.getAttribute("type") ?? "text").toLowerCase();
      if (
        (type === "submit" || type === "button" || type === "reset") &&
        element.value !== ""
      ) {
        return element.value;
      }
      if (element.placeholder !== "") {
        return element.placeholder;
      }
    }
    return "";
  }

  function readSensitiveTargetIds(element: Element): readonly string[] {
    const value = (element as unknown as Element & Record<string, unknown>)[input.sensitiveTargetIdsProperty];
    if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
      return [];
    }
    return value;
  }

  function sensitiveValues(element: Element): readonly string[] {
    const values: string[] = [];
    const text = directText(element);
    if (text !== "") values.push(text);
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      if (element.value !== "") values.push(element.value);
      if (element.placeholder !== "") values.push(element.placeholder);
    }
    if (element instanceof HTMLSelectElement) {
      if (element.value !== "") values.push(element.value);
      const selectedText = element.selectedOptions.item(0)?.text ?? "";
      if (selectedText !== "") values.push(selectedText);
    }
    for (const attribute of ["aria-label", "title", "value"] as const) {
      const attributeValue = element.getAttribute(attribute);
      if (attributeValue !== null && attributeValue !== "") values.push(attributeValue);
    }
    return values;
  }

  function directText(element: Element): string {
    return Array.from(element.childNodes)
      .filter((node): node is Text => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.data)
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

  function sensitiveEvidenceUnavailable(): boolean {
    const state = (window as unknown as Record<string, unknown>)[input.sensitiveEvidenceStateProperty] as {
      active?: unknown;
      poisoned?: boolean;
      readonly records?: readonly {
        readonly markerId: string;
        readonly forms: readonly string[];
      }[];
    } | undefined;
    if (state === undefined) return false;
    if (state.active !== undefined && state.active !== null) return true;
    if (state.poisoned === true) return true;
    const records = state.records ?? [];
    for (const element of Array.from(document.querySelectorAll("*"))) {
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
          if (carriesForm(value, record.forms)) return true;
        }
        for (const element of Array.from(root.querySelectorAll("*"))) {
          for (const value of sensitiveValues(element)) {
            if (carriesForm(value, record.forms)) return true;
          }
        }
      }
    }
    return false;
  }

  function shadowRootValues(root: ShadowRoot): readonly string[] {
    const values: string[] = [];
    const direct = Array.from(root.childNodes)
      .filter((node): node is Text => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.data)
      .join("");
    if (direct !== "") values.push(direct);
    const fullText = root.textContent ?? "";
    if (fullText !== "" && fullText !== direct) values.push(fullText);
    return values;
  }

  function shadowRoots(): ShadowRoot[] {
    const roots = new Set<ShadowRoot>();
    const pending: ShadowRoot[] = [];
    const addRoot = (root: ShadowRoot): void => {
      if (roots.has(root)) return;
      roots.add(root);
      pending.push(root);
    };
    const registry = (window as unknown as Record<string, unknown>)[input.sensitiveShadowRootsProperty] as {
      readonly roots?: readonly unknown[];
    } | undefined;
    for (const root of registry?.roots ?? []) {
      if (root instanceof ShadowRoot) addRoot(root);
    }
    for (const element of Array.from(document.querySelectorAll("*"))) {
      const shadowRoot = element.shadowRoot;
      if (shadowRoot !== null) addRoot(shadowRoot);
    }
    for (let index = 0; index < pending.length; index += 1) {
      const root = pending[index]!;
      for (const element of Array.from(root.querySelectorAll("*"))) {
        const nestedShadowRoot = element.shadowRoot;
        if (nestedShadowRoot !== null) addRoot(nestedShadowRoot);
      }
    }
    return pending;
  }

  const selector =
    `button, a[href], input, textarea, select, [role], [data-qualigence-observe], [${input.sensitiveMaskIdAttribute}]`;
  const elements = Array.from(document.querySelectorAll(selector));
  const candidates: BrowserObservationCandidate[] = [];
  const sensitiveMaskIds = new Set<string>();
  const titleElement = document.querySelector("title");

  for (const element of elements) {
    const sensitiveTargetIds = readSensitiveTargetIds(element);
    const isSensitiveTarget = sensitiveTargetIds.length > 0;
    const sensitiveMaskId = element.getAttribute(input.sensitiveMaskIdAttribute) ?? undefined;
    if (isSensitiveTarget && sensitiveMaskId !== undefined) {
      sensitiveMaskIds.add(sensitiveMaskId);
    }
    if (!isVisible(element)) {
      continue;
    }
    const role = roleOf(element);
    const name = accessibleName(element).trim();
    const isFormField =
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement;
    let value: string | undefined;
    if (isFormField) {
      const type = (element.getAttribute("type") ?? "text").toLowerCase();
      if (type !== "password" && element.value !== "") {
        value = element.value;
      }
    } else if (isSensitiveTarget && element instanceof HTMLSelectElement && element.value !== "") {
      value = element.value;
    }

    const interactive =
      role === "button" ||
      role === "link" ||
      role === "textbox" ||
      role === "checkbox" ||
      role === "radio" ||
      role === "combobox";
    let text: string | undefined;
    if (!interactive || element.hasAttribute("data-qualigence-observe")) {
      const content = element.textContent ?? "";
      if (content.trim() !== "") {
        text = content;
      }
    } else if (isSensitiveTarget && element instanceof HTMLSelectElement) {
      const selectedText = element.selectedOptions.item(0)?.text ?? "";
      if (selectedText.trim() !== "") {
        text = selectedText;
      }
    }

    const disabled =
      (element as HTMLButtonElement).disabled === true ||
      element.getAttribute("aria-disabled") === "true";

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
    title: document.title,
    ...(titleElement === null ? {} : { titleSensitiveTargetIds: readSensitiveTargetIds(titleElement) }),
    sensitiveEvidenceUnavailable: sensitiveEvidenceUnavailable(),
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

      const artifactNames = [`${ordinal}-observation.json`, `${ordinal}.png`];
      assertCaptureAuthority();
      const { graph, descriptors } = buildObservationGraph(
        job.runId,
        ordinal,
        raw,
        {
          url,
          targetId: new URL(this.session.targetUrl).origin,
          title,
          capturedAt: new Date().toISOString(),
          viewport: captured.viewport,
          allowedQueryKeys: this.session.allowedWebQueryKeys,
          evidenceRefs: artifactNames,
        },
      );
      assertCaptureAuthority();

      const maskIds = [...new Set([
        ...(captured.sensitiveMaskIds ?? []),
        ...(preScreenshotCheck.sensitiveMaskIds ?? []),
      ].filter((maskId) => /^[A-Za-z0-9_-]+$/.test(maskId)))];
      const screenshot = await captureScreenshot(page, assertCaptureAuthority, maskIds);
      const postScreenshotCheck = await collectAuthorizedPageObservation(page, assertCaptureAuthority);
      if (postScreenshotCheck.sensitiveEvidenceUnavailable) {
        this.session.markSensitiveEvidenceUnavailable();
      }
      assertCaptureAuthority();
      this.session.assertSensitiveEvidenceAvailable();
      if (
        this.session.hasPendingSensitiveEvidenceCapture() &&
        await retireCapturedSensitiveEvidence(page, assertCaptureAuthority)
      ) {
        this.session.markSensitiveEvidenceUnavailable();
      }
      this.session.assertSensitiveEvidenceAvailable();
      const artifacts = buildArtifacts(ordinal, graph, screenshot);
      this.session.registerCapturedObservation(page, graph.graphId, {
        descriptors,
        artifacts,
      }, navigationGeneration);
      this.session.completeSensitiveEvidenceCapture();
      return graph;
    });
  }
}

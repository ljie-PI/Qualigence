import type {
  AcceptedExecutionJob,
  ObservationGraph,
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
import { SENSITIVE_TARGET_IDS_PROPERTY } from "./sensitive-evidence-authority.js";

export interface PlaywrightObserverHooks {
  readonly afterDomCollection?: () => void | Promise<void>;
}

async function captureScreenshot(
  page: Page,
  assertCaptureAuthority: () => void,
): Promise<Uint8Array> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assertCaptureAuthority();
    let screenshot: Uint8Array;
    try {
      screenshot = new Uint8Array(await page.screenshot({ timeout: 5000 }));
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
}

interface BrowserObservationCapture {
  readonly candidates: readonly BrowserObservationCandidate[];
  readonly viewport: WebViewportV1;
}

function collectPageObservation(
  sensitiveTargetIdsProperty: string,
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
    const value = (element as unknown as Element & Record<string, unknown>)[sensitiveTargetIdsProperty];
    if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
      return [];
    }
    return value;
  }

  const selector =
    "button, a[href], input, textarea, select, [role], [data-qualigence-observe]";
  const elements = Array.from(document.querySelectorAll(selector));
  const candidates: BrowserObservationCandidate[] = [];

  for (const element of elements) {
    if (!isVisible(element)) {
      continue;
    }
    const role = roleOf(element);
    const name = accessibleName(element).trim();

    const sensitiveTargetIds = readSensitiveTargetIds(element);
    const isSensitiveTarget = sensitiveTargetIds.length > 0;
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
    };
    candidates.push(candidate);
  }

  return {
    candidates,
    viewport: {
      width: Math.max(1, Math.trunc(window.innerWidth)),
      height: Math.max(1, Math.trunc(window.innerHeight)),
      devicePixelRatio: window.devicePixelRatio,
    },
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

  async capture(job: AcceptedExecutionJob): Promise<ObservationGraph> {
    return this.session.withPage(async (page) => {
      const ordinal = this.session.nextObservationOrdinal();
      const navigationGeneration = this.session.currentNavigationGeneration;
      const assertCaptureAuthority = (): void => {
        this.session.assertPageTargetOrigin(page, navigationGeneration);
      };
      this.session.assertSensitiveEvidenceAvailable();
      const captured = await readPageValue(
        assertCaptureAuthority,
        async () => (await page.evaluate(
          collectPageObservation,
          SENSITIVE_TARGET_IDS_PROPERTY,
        )) as BrowserObservationCapture,
      );
      await this.hooks.afterDomCollection?.();
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
      const title = await readPageValue(
        assertCaptureAuthority,
        () => page.title(),
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

      const screenshot = await captureScreenshot(page, assertCaptureAuthority);
      assertCaptureAuthority();
      const artifacts = buildArtifacts(ordinal, graph, screenshot);
      this.session.registerCapturedObservation(page, graph.graphId, {
        descriptors,
        artifacts,
      }, navigationGeneration);
      return graph;
    });
  }
}

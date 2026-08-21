import type {
  AcceptedExecutionJob,
  ObservationGraph,
} from "@qualigence/runner-protocol";
import type { Observer } from "@qualigence/runner-kernel";
import {
  PRIVATE_TARGET_ATTRIBUTE,
  WebTargetError,
  type PlaywrightBrowserSession,
  type SensitiveActionTarget,
} from "./browser-session.js";
import {
  buildObservationGraph,
  type ObservationCandidate,
} from "./observation-builder.js";
import type { Page } from "playwright";
import type { CapturedArtifact } from "./types.js";

const REDACTED = "[REDACTED]";

async function captureScreenshot(
  page: Page,
  sensitiveTargets: readonly SensitiveActionTarget[],
): Promise<Uint8Array> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      if (sensitiveTargets.length === 0) {
        return new Uint8Array(await page.screenshot({ timeout: 5000 }));
      }
      const locators = [];
      for (const sensitiveTarget of sensitiveTargets) {
        const locator = page.locator(
          `[${PRIVATE_TARGET_ATTRIBUTE}="${sensitiveTarget.token}"]`,
        );
        const count = await locator.count();
        const locatedHandle = count === 1 ? await locator.elementHandle() : null;
        const exactTarget = locatedHandle !== null && await page.evaluate(
          ([located, retained]) => located === retained,
          [locatedHandle, sensitiveTarget.handle],
        );
        const box = count === 1 ? await locator.boundingBox() : null;
        if (
          !exactTarget ||
          box === null ||
          ![box.x, box.y, box.width, box.height].every(Number.isFinite) ||
          box.width <= 0 ||
          box.height <= 0
        ) {
          throw new WebTargetError(
            "SensitiveTargetUnproven",
            "A sensitive target has no unique bounded screenshot region.",
          );
        }
        locators.push(locator);
      }
      const screenshot = new Uint8Array(await page.screenshot({
        timeout: 5000,
        mask: locators,
        maskColor: "#000000",
      }));
      for (const [index, sensitiveTarget] of sensitiveTargets.entries()) {
        const locator = locators[index]!;
        const postHandle = await locator.elementHandle();
        const remainsExact = postHandle !== null && await page.evaluate(
          ([located, retained]) => located === retained,
          [postHandle, sensitiveTarget.handle],
        );
        if (await locator.count() !== 1 || !remainsExact) {
          throw new WebTargetError(
            "SensitiveTargetUnproven",
            "A sensitive target identity changed during screenshot capture.",
          );
        }
      }
      return screenshot;
    } catch (error) {
      if (error instanceof WebTargetError) throw error;
      lastError = error;
      await page.waitForTimeout(50);
    }
  }
  throw lastError;
}

/**
 * Executed inside the page. Collects semantic candidates in DOM order without
 * exposing any selector to the caller. Password field values are never read.
 */
function collectCandidates(identity: {
  readonly sensitiveElements: readonly Element[];
}): {
  readonly candidates: ObservationCandidate[];
  readonly sensitiveIndexes: readonly number[];
  readonly sensitiveConnected: readonly boolean[];
} {
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

  const selector =
    "button, a[href], input, textarea, select, [role], [data-qualigence-observe]";
  const elements = Array.from(document.querySelectorAll(selector));
  const candidates: ObservationCandidate[] = [];
  const sensitiveIndexes = identity.sensitiveElements.map(() => -1);

  for (const element of elements) {
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
    }

    const disabled =
      (element as HTMLButtonElement).disabled === true ||
      element.getAttribute("aria-disabled") === "true";

    const candidate: ObservationCandidate = {
      role,
      ...(name !== "" ? { name } : {}),
      ...(text !== undefined ? { text } : {}),
      ...(value !== undefined ? { value } : {}),
      ...(disabled ? { disabled: true } : {}),
    };
    const sensitiveIndex = identity.sensitiveElements.indexOf(element);
    if (sensitiveIndex >= 0) {
      sensitiveIndexes[sensitiveIndex] = candidates.length;
    }
    candidates.push(candidate);
  }

  return {
    candidates,
    sensitiveIndexes,
    sensitiveConnected: identity.sensitiveElements.map((element) => element.isConnected),
  };
}

function buildArtifacts(
  ordinal: number,
  graph: ObservationGraph,
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
  constructor(private readonly session: PlaywrightBrowserSession) {}

  async capture(job: AcceptedExecutionJob): Promise<ObservationGraph> {
    return this.session.withPage(async (page) => {
      const ordinal = this.session.nextObservationOrdinal();
      const sensitiveTargets = this.session.sensitiveTargets();
      const captured = await page.evaluate(collectCandidates, {
        sensitiveElements: sensitiveTargets.map((target) => target.handle),
      });
      if (captured.sensitiveConnected.some((connected) => !connected) ||
          captured.sensitiveIndexes.some((index) => index < 0)) {
        throw new WebTargetError(
          "SensitiveTargetUnproven",
          "A sensitive action target cannot be proven in the current observation.",
        );
      }
      const sensitiveIndexes = new Set(captured.sensitiveIndexes);
      const raw = captured.candidates.map((candidate, index) => ({
        role: candidate.role,
        ...(sensitiveIndexes.has(index)
          ? { name: REDACTED, text: REDACTED, value: REDACTED }
          : {
              ...(candidate.name === undefined ? {} : { name: this.session.redactSensitiveText(candidate.name) }),
              ...(candidate.text === undefined ? {} : { text: this.session.redactSensitiveText(candidate.text) }),
              ...(candidate.value === undefined ? {} : { value: this.session.redactSensitiveText(candidate.value) }),
            }),
        ...(candidate.disabled === undefined ? {} : { disabled: candidate.disabled }),
      }));
      const url = this.session.redactSensitiveText(page.url());
      const title = this.session.redactSensitiveText(await page.title());

      const artifactNames = [`${ordinal}-observation.json`, `${ordinal}.png`];
      const { graph, descriptors } = buildObservationGraph(
        job.runId,
        ordinal,
        raw,
        { url, ...(title !== "" ? { title } : {}) },
      );
      const sensitiveNodeIds = captured.sensitiveIndexes.map((index) => {
        const serializedNode = graph.nodes[index];
        if (serializedNode === undefined) {
          throw new WebTargetError(
            "UnknownObservationNode",
            "A sensitive action target is absent from the serialized observation.",
          );
        }
        return serializedNode.id;
      });
      const graphWithRefs: ObservationGraph = {
        ...graph,
        artifactRefs: artifactNames,
      };

      const screenshot = await captureScreenshot(page, sensitiveTargets);
      const artifacts = buildArtifacts(ordinal, graphWithRefs, screenshot);
      this.session.advanceSensitiveTargets(graph.graphId, sensitiveNodeIds);
      this.session.registerObservation(graphWithRefs.graphId, {
        descriptors,
        artifacts,
      });
      return graphWithRefs;
    });
  }
}

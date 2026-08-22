import type {
  AcceptedExecutionJob,
  ObservationGraph,
} from "@qualigence/runner-protocol";
import type { Observer } from "@qualigence/runner-kernel";
import {
  MAXIMUM_OBSERVATION_CANDIDATES,
  MAXIMUM_OBSERVATION_NODE_BYTES,
  MAXIMUM_OBSERVATION_SNAPSHOT_BYTES,
  MAXIMUM_OBSERVATION_SHADOW_ROOTS,
  MAXIMUM_OBSERVATION_DOM_ELEMENTS,
  PRIVATE_TARGET_ATTRIBUTE,
  WebTargetError,
  type PlaywrightBrowserSession,
  type PrivateShadowRegistry,
  type SensitiveActionTarget,
} from "./browser-session.js";
import {
  buildObservationGraph,
  type ObservationCandidate,
} from "./observation-builder.js";
import type { Page } from "playwright";
import type { CapturedArtifact } from "./types.js";
import { redactPngRectangles, type ScreenshotRectangle } from "./png-redactor.js";

const REDACTED = "[REDACTED]";

async function captureScreenshot(
  page: Page,
  sensitiveTargets: readonly SensitiveActionTarget[],
  validateEvidence: () => Promise<void>,
): Promise<Uint8Array> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      if (sensitiveTargets.length === 0) {
        await validateEvidence();
        return new Uint8Array(await page.screenshot({ timeout: 5000 }));
      }
      const regions: ScreenshotRectangle[] = [];
      for (const sensitiveTarget of sensitiveTargets) {
        const region = await sensitiveTarget.handle.evaluate((element, identity) => {
          const rect = element.getBoundingClientRect();
          return element.isConnected && element.getAttribute(identity.attribute) === identity.token &&
            [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) &&
            rect.width > 0 && rect.height > 0
            ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
            : undefined;
        }, { attribute: PRIVATE_TARGET_ATTRIBUTE, token: sensitiveTarget.token });
        if (region === undefined) {
          throw new WebTargetError(
            "SensitiveTargetUnproven",
            "A sensitive target has no unique bounded screenshot region.",
          );
        }
        regions.push(region);
      }
      await validateEvidence();
      const screenshot = new Uint8Array(await page.screenshot({ timeout: 5000 }));
      for (const [index, sensitiveTarget] of sensitiveTargets.entries()) {
        const remainsExact = await sensitiveTarget.handle.evaluate((element, expected) => {
          const rect = element.getBoundingClientRect();
          return element.isConnected && element.getAttribute(expected.attribute) === expected.token &&
            rect.x === expected.region.x && rect.y === expected.region.y &&
            rect.width === expected.region.width && rect.height === expected.region.height;
        }, {
          attribute: PRIVATE_TARGET_ATTRIBUTE,
          token: sensitiveTarget.token,
          region: regions[index]!,
        });
        if (!remainsExact) {
          throw new WebTargetError(
            "SensitiveTargetUnproven",
            "A sensitive target identity changed during screenshot capture.",
          );
        }
      }
      const viewport = page.viewportSize();
      if (viewport === null) throw new Error("screenshot-viewport-unproven");
      return redactPngRectangles(screenshot, regions, viewport);
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
  readonly shadowRegistry: PrivateShadowRegistry | undefined;
  readonly maximumCandidates: number;
  readonly maximumNodeBytes: number;
  readonly maximumSnapshotBytes: number;
  readonly maximumShadowRoots: number;
  readonly maximumDomElements: number;
}): {
  readonly candidates: ObservationCandidate[];
  readonly sensitiveIndexes: readonly number[];
  readonly sensitiveConnected: readonly boolean[];
  readonly failure: string | undefined;
} {
  const utf8Bytes = (text: string): number => {
    let bytes = 0;
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (code <= 0x7f) bytes += 1;
      else if (code <= 0x7ff) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length &&
          text.charCodeAt(index + 1) >= 0xdc00 &&
          text.charCodeAt(index + 1) <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
      if (bytes > identity.maximumNodeBytes) return bytes;
    }
    return bytes;
  };
  const boundedText = (element: Element): string => {
    const chunks: string[] = [];
    let bytes = 0;
    const roots: Node[] = [element];
    if (element.shadowRoot !== null) roots.push(element.shadowRoot);
    let elements = 0;
    for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
      const root = roots[rootIndex];
      if (root === undefined) throw new Error("text-root-unprovable");
      const walker = element.ownerDocument.createTreeWalker(
        root,
        NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      );
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        if (node instanceof CharacterData) {
          bytes += utf8Bytes(node.data);
          if (bytes > identity.maximumNodeBytes) throw new Error("node-byte-overflow");
          chunks.push(node.data);
        } else if (node instanceof Element) {
          elements += 1;
          if (elements > identity.maximumDomElements) throw new Error("dom-element-overflow");
          if (node.shadowRoot !== null) {
            roots.push(node.shadowRoot);
            if (roots.length > identity.maximumShadowRoots + 1) {
              throw new Error("shadow-root-overflow");
            }
          }
        }
      }
    }
    return chunks.join("");
  };
  const addBytes = (current: number, value: string | undefined): number => {
    if (value === undefined) return current;
    const bytes = utf8Bytes(value);
    if (bytes > identity.maximumNodeBytes) throw new Error("node-byte-overflow");
    const total = current + bytes;
    if (total > identity.maximumNodeBytes) throw new Error("node-byte-overflow");
    return total;
  };
  const boundedProperty = (value: string | null): string | null => {
    if (value !== null && utf8Bytes(value) > identity.maximumNodeBytes) {
      throw new Error("node-byte-overflow");
    }
    return value;
  };

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
    const explicit = boundedProperty(element.getAttribute("role"));
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
    const ariaLabel = boundedProperty(element.getAttribute("aria-label"));
    if (ariaLabel && ariaLabel.trim() !== "") {
      return ariaLabel;
    }
    const labelledBy = boundedProperty(element.getAttribute("aria-labelledby"));
    if (labelledBy) {
      const joined = labelledBy
        .split(/\s+/)
        .map((id) => {
          const root = element.getRootNode();
          return root instanceof Document || root instanceof ShadowRoot
            ? root.getElementById(id)
            : null;
        })
        .filter((node): node is HTMLElement => node !== null)
        .map((node) => boundedText(node))
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
      const root = element.getRootNode();
      const label = root instanceof Document || root instanceof ShadowRoot
        ? root.querySelector(`label[for="${escaped}"]`)
        : null;
      if (label) {
        const text = boundedText(label);
        if (text.trim() !== "") return text;
      }
    }
    const wrapping = element.closest("label");
    if (wrapping) {
      const text = boundedText(wrapping);
      if (text.trim() !== "") return text;
    }
    const tag = element.tagName.toLowerCase();
    if (tag === "button" || tag === "a" || element.getAttribute("role") === "button") {
      const text = boundedText(element);
      if (text.trim() !== "") {
        return text;
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
      const placeholder = boundedProperty(element.placeholder);
      if (placeholder !== null && placeholder !== "") {
        return placeholder;
      }
    }
    return "";
  }

  const selector =
    "button, a[href], input, textarea, select, [role], [data-qualigence-observe]";
  const elements: Element[] = [];
  const shadow = identity.shadowRegistry?.snapshot(identity.maximumShadowRoots);
  if (shadow !== undefined &&
      (!shadow.intact || shadow.overflow || shadow.count !== shadow.roots.length)) {
    return {
      candidates: [],
      sensitiveIndexes: [],
      sensitiveConnected: identity.sensitiveElements.map((element) => element.isConnected),
      failure: "shadow-root-identity-unprovable",
    };
  }
  const roots: (Document | ShadowRoot)[] = [document];
  if (shadow !== undefined) for (const entry of shadow.roots) roots.push(entry.root);
  let domElements = 0;
  for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
    const root = roots[rootIndex];
    if (root === undefined || new Set(roots).size !== roots.length ||
        rootIndex > identity.maximumShadowRoots) {
      return {
        candidates: [],
        sensitiveIndexes: [],
        sensitiveConnected: identity.sensitiveElements.map((element) => element.isConnected),
        failure: "shadow-root-identity-unprovable",
      };
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (!(node instanceof Element)) {
        return {
          candidates: [],
          sensitiveIndexes: [],
          sensitiveConnected: identity.sensitiveElements.map((element) => element.isConnected),
          failure: "candidate-unprovable",
        };
      }
      domElements += 1;
      if (domElements > identity.maximumDomElements) {
        return {
          candidates: [],
          sensitiveIndexes: [],
          sensitiveConnected: identity.sensitiveElements.map((element) => element.isConnected),
          failure: "dom-element-overflow",
        };
      }
      if (node.matches(selector)) elements.push(node);
      if (shadow === undefined && node.shadowRoot !== null) roots.push(node.shadowRoot);
      if (elements.length > identity.maximumCandidates) {
        return {
          candidates: [],
          sensitiveIndexes: [],
          sensitiveConnected: identity.sensitiveElements.map((element) => element.isConnected),
          failure: "candidate-overflow",
        };
      }
    }
  }
  const candidates: ObservationCandidate[] = [];
  const sensitiveIndexes = identity.sensitiveElements.map(() => -1);
  let snapshotBytes = 0;

  try {
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
        value = boundedProperty(element.value) ?? undefined;
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
      const content = boundedText(element);
      if (content.trim() !== "") {
        text = content;
      }
    }

    const disabled =
      (element as HTMLButtonElement).disabled === true ||
      element.getAttribute("aria-disabled") === "true";

    let candidateBytes = 0;
    candidateBytes = addBytes(candidateBytes, role);
    candidateBytes = addBytes(candidateBytes, name === "" ? undefined : name);
    candidateBytes = addBytes(candidateBytes, text);
    candidateBytes = addBytes(candidateBytes, value);
    snapshotBytes += candidateBytes;
    if (snapshotBytes > identity.maximumSnapshotBytes) {
      throw new Error("snapshot-byte-overflow");
    }
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
  } catch (error) {
    return {
      candidates: [],
      sensitiveIndexes: [],
      sensitiveConnected: identity.sensitiveElements.map((element) => element.isConnected),
      failure: error instanceof Error ? error.message : "snapshot-unprovable",
    };
  }

  return {
    candidates,
    sensitiveIndexes,
    sensitiveConnected: identity.sensitiveElements.map((element) => element.isConnected),
    failure: undefined,
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
    try {
      return await this.session.withPage(async (page) => {
      const ordinal = this.session.nextObservationOrdinal();
      for (let attempt = 0; attempt < 2; attempt += 1) {
      await this.session.prepareSensitiveEvidenceCapture();
      const sensitiveTargets = this.session.sensitiveTargets();
      const bounded = this.session.hasSensitiveActionTracker();
      const captured = await page.evaluate(collectCandidates, {
        sensitiveElements: sensitiveTargets.map((target) => target.handle),
        shadowRegistry: bounded ? this.session.shadowRegistryForEvidence() : undefined,
        maximumCandidates: bounded
          ? this.session.observationCandidateLimit()
          : Number.MAX_SAFE_INTEGER,
        maximumNodeBytes: bounded
          ? MAXIMUM_OBSERVATION_NODE_BYTES
          : Number.MAX_SAFE_INTEGER,
        maximumSnapshotBytes: bounded
          ? MAXIMUM_OBSERVATION_SNAPSHOT_BYTES
          : Number.MAX_SAFE_INTEGER,
        maximumShadowRoots: bounded
          ? MAXIMUM_OBSERVATION_SHADOW_ROOTS
          : Number.MAX_SAFE_INTEGER,
        maximumDomElements: bounded
          ? MAXIMUM_OBSERVATION_DOM_ELEMENTS
          : Number.MAX_SAFE_INTEGER,
      });
      if (captured.failure !== undefined) {
        throw this.session.sensitiveEvidenceFailure(
          "The bounded observation snapshot could not be proven.",
        );
      }
      if (captured.sensitiveConnected.some((connected) => !connected) ||
          captured.sensitiveIndexes.some((index) => index < 0)) {
        throw new WebTargetError(
          "SensitiveTargetUnproven",
          "A sensitive action target cannot be proven in the current observation.",
        );
      }
      this.session.recordPreSensitiveObservationCandidateCount(captured.candidates.length);
      const sensitiveIndexes = new Set(captured.sensitiveIndexes);
      const raw = captured.candidates.map((candidate, index) => ({
        role: candidate.role,
        ...(sensitiveIndexes.has(index)
          ? { name: REDACTED, text: REDACTED, value: REDACTED }
          : {
              ...(candidate.name === undefined ? {} : { name: candidate.name }),
              ...(candidate.text === undefined ? {} : { text: candidate.text }),
              ...(candidate.value === undefined ? {} : { value: candidate.value }),
            }),
        ...(candidate.disabled === undefined ? {} : { disabled: candidate.disabled }),
      }));
      const pageMetadata = await this.session.redactSensitivePageMetadata(
        page.url(),
        await page.title(),
      );

      const artifactNames = [`${ordinal}-observation.json`, `${ordinal}.png`];
      await this.session.failIfSensitiveTrackingOverflowed();
      const { graph, descriptors } = buildObservationGraph(
        job.runId,
        ordinal,
        raw,
        {
          url: pageMetadata.url,
          ...(pageMetadata.title !== "" ? { title: pageMetadata.title } : {}),
        },
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

      await this.session.verifySensitiveShadowRoots();
      const screenshot = await captureScreenshot(
        page,
        sensitiveTargets,
        () => this.session.failIfSensitiveTrackingOverflowed(),
      );
      const stable = await this.session.completeSensitiveEvidenceCapture();
      if (!stable) {
        if (attempt === 0) continue;
        throw this.session.sensitiveEvidenceChangedDuringCapture();
      }
      await this.session.failIfSensitiveTrackingOverflowed();
      const artifacts = buildArtifacts(ordinal, graphWithRefs, screenshot);
      const artifactCache = await this.session.cacheArtifactBatch(artifacts);
      this.session.advanceSensitiveTargets(graph.graphId, sensitiveNodeIds);
      this.session.registerObservation(graphWithRefs.graphId, {
        descriptors,
        artifacts,
        ...(artifactCache === undefined ? {} : { artifactCache }),
      });
        return graphWithRefs;
      }
      throw this.session.sensitiveEvidenceChangedDuringCapture();
      });
    } catch (error) {
      if (error instanceof WebTargetError && error.code === "SensitiveEvidenceUnproven") {
        throw error;
      }
      if (this.session.hasSensitiveAction()) {
        throw this.session.sensitiveEvidenceFailure(
          "Sensitive observation evidence could not be proven.",
        );
      }
      throw error;
    }
  }
}

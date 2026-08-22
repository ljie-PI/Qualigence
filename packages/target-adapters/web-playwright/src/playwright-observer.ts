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
  type PrivatePromiseIntrinsics,
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
  session: PlaywrightBrowserSession,
  validateEvidence: () => Promise<void>,
): Promise<Uint8Array> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      if (sensitiveTargets.length === 0) {
        await validateEvidence();
        return new Uint8Array(await page.screenshot({ timeout: 5000 }));
      }
      const regions: ScreenshotRectangle[] = [];
      const before = await session.proveSensitiveTargetGeometry();
      if (before.length !== sensitiveTargets.length) throw new WebTargetError("SensitiveTargetUnproven");
      for (let targetIndex = 0; targetIndex < before.length; targetIndex += 1) {
        const geometry = before[targetIndex];
        if (geometry === undefined) throw new WebTargetError("SensitiveTargetUnproven");
        regions[targetIndex] = geometry.rectangle;
      }
      await validateEvidence();
      const screenshot = new Uint8Array(await page.screenshot({ timeout: 5000 }));
      const after = await session.proveSensitiveTargetGeometry();
      if (after.length !== before.length) throw new WebTargetError("SensitiveTargetUnproven");
      for (let index = 0; index < before.length; index += 1) {
        const expected = before[index];
        const current = after[index];
        if (expected === undefined || current === undefined ||
            expected.backendNodeId !== current.backendNodeId ||
            expected.rectangle.x !== current.rectangle.x || expected.rectangle.y !== current.rectangle.y ||
            expected.rectangle.width !== current.rectangle.width ||
            expected.rectangle.height !== current.rectangle.height) {
          throw new Error("sensitive-target-geometry-changed");
        }
      }
      const viewport = page.viewportSize();
      if (viewport === null) throw new Error("screenshot-viewport-unproven");
      return redactPngRectangles(screenshot, regions, viewport);
    } catch (error) {
      if (error instanceof WebTargetError) throw error;
      if (error instanceof Error && error.message !== "sensitive-target-geometry-changed") {
        throw new WebTargetError("SensitiveTargetUnproven");
      }
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
  readonly authority: PrivatePromiseIntrinsics;
  readonly bounded: boolean;
}): {
  readonly candidates: ObservationCandidate[];
  readonly sensitiveIndexes: readonly number[];
  readonly sensitiveConnected: readonly boolean[];
  readonly failure: string | undefined;
} {
  const authoritySnapshot = identity.authority.snapshot();
  if (identity.bounded && (!authoritySnapshot.intact ||
      !authoritySnapshot.descriptorShapeIntact || !identity.authority.revalidateOwners())) {
    return { candidates: [], sensitiveIndexes: [], sensitiveConnected: [], failure: "intrinsic-unproven" };
  }
  const operations = authoritySnapshot.operations;
  const connected = (elements: readonly Element[]): readonly boolean[] => {
    const result: boolean[] = [];
    for (let index = 0; index < elements.length; index += 1) {
      const element = elements[index];
      result[index] = element !== undefined && operations.nodeIsConnected(element);
    }
    return result;
  };
  const utf8Bytes = (text: string): number => {
    let bytes = 0;
    for (let index = 0; index < text.length; index += 1) {
      const code = operations.stringCharCodeAt(text, index);
      if (code <= 0x7f) bytes += 1;
      else if (code <= 0x7ff) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length &&
          operations.stringCharCodeAt(text, index + 1) >= 0xdc00 &&
          operations.stringCharCodeAt(text, index + 1) <= 0xdfff) {
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
    const ownShadowRoot = operations.elementShadowRoot(element);
    if (ownShadowRoot !== null) roots[roots.length] = ownShadowRoot;
    let elements = 0;
    for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
      const root = roots[rootIndex];
      if (root === undefined) throw new Error("text-root-unprovable");
      const ownerDocument = operations.nodeOwnerDocument(element);
      if (ownerDocument === null) throw new Error("text-root-unprovable");
      const walker = operations.documentCreateTreeWalker(
        ownerDocument,
        root,
        NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      );
      for (let node = operations.treeWalkerNextNode(walker); node !== null;
        node = operations.treeWalkerNextNode(walker)) {
        if (operations.isCharacterData(node)) {
          bytes += utf8Bytes(node.data);
          if (bytes > identity.maximumNodeBytes) throw new Error("node-byte-overflow");
          chunks[chunks.length] = node.data;
        } else if (operations.isElement(node)) {
          elements += 1;
          if (elements > identity.maximumDomElements) throw new Error("dom-element-overflow");
          const shadowRoot = operations.elementShadowRoot(node);
          if (shadowRoot !== null) {
            roots[roots.length] = shadowRoot;
            if (roots.length > identity.maximumShadowRoots + 1) {
              throw new Error("shadow-root-overflow");
            }
          }
        }
      }
    }
    let text = "";
    for (let index = 0; index < chunks.length; index += 1) text += chunks[index] ?? "";
    return text;
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
    const htmlElement = operations.isHtmlElement(element) ? element as HTMLElement : undefined;
    if (htmlElement === undefined) {
      return true;
    }
    if (htmlElement.hidden) {
      return false;
    }
    const style = operations.computedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") {
      return false;
    }
    return operations.elementClientRectCount(element) > 0;
  }

  function roleOf(element: Element): string {
    const explicit = boundedProperty(operations.elementGetAttribute(element, "role"));
    if (explicit) {
      return explicit;
    }
    const tag = operations.stringToLowerCase(operations.elementTagName(element));
    if (tag === "button") {
      return "button";
    }
    if (tag === "a" && operations.elementHasAttribute(element, "href")) {
      return "link";
    }
    if (tag === "select") {
      return "combobox";
    }
    if (tag === "textarea") {
      return "textbox";
    }
    if (tag === "input") {
      const type = operations.stringToLowerCase(operations.elementGetAttribute(element, "type") ?? "text");
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
    const ariaLabel = boundedProperty(operations.elementGetAttribute(element, "aria-label"));
    if (ariaLabel && operations.stringTrim(ariaLabel) !== "") {
      return ariaLabel;
    }
    const labelledBy = boundedProperty(operations.elementGetAttribute(element, "aria-labelledby"));
    if (labelledBy) {
      const ids = operations.stringSplitWhitespace(labelledBy);
      let joined = "";
      for (let index = 0; index < ids.length; index += 1) {
        const id = ids[index];
        if (id === undefined) continue;
        const root = operations.nodeGetRootNode(element);
        const node = operations.isDocument(root)
          ? operations.documentGetElementById(root, id)
          : operations.isShadowRoot(root)
            ? operations.rootQuerySelector(root, `[id="${id}"]`)
            : null;
        if (node !== null) joined += `${joined === "" ? "" : " "}${boundedText(node)}`;
      }
      joined = operations.stringTrim(joined);
      if (joined !== "") {
        return joined;
      }
    }
    const elementId = operations.elementId(element);
    if (elementId !== "") {
      const root = operations.nodeGetRootNode(element);
      const label = operations.isDocument(root) || operations.isShadowRoot(root)
        ? operations.rootQuerySelector(root, `label[for="${elementId}"]`)
        : null;
      if (label) {
        const text = boundedText(label);
        if (operations.stringTrim(text) !== "") return text;
      }
    }
    const wrapping = operations.elementClosest(element, "label");
    if (wrapping) {
      const text = boundedText(wrapping);
      if (operations.stringTrim(text) !== "") return text;
    }
    const tag = operations.stringToLowerCase(operations.elementTagName(element));
    if (tag === "button" || tag === "a" || operations.elementGetAttribute(element, "role") === "button") {
      const text = boundedText(element);
      if (operations.stringTrim(text) !== "") {
        return text;
      }
    }
    if (operations.isInput(element)) {
      const inputElement = element as HTMLInputElement;
      const type = operations.stringToLowerCase(operations.elementGetAttribute(element, "type") ?? "text");
      if (
        (type === "submit" || type === "button" || type === "reset") &&
        inputElement.value !== ""
      ) {
        return inputElement.value;
      }
      const placeholder = boundedProperty(inputElement.placeholder);
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
      sensitiveConnected: connected(identity.sensitiveElements),
      failure: "shadow-root-identity-unprovable",
    };
  }
  const roots: (Document | ShadowRoot)[] = [document];
  if (shadow !== undefined) {
    for (let index = 0; index < shadow.roots.length; index += 1) {
      const entry = shadow.roots[index];
      if (entry !== undefined) roots[roots.length] = entry.root;
    }
  }
  let domElements = 0;
  for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
    const root = roots[rootIndex];
    let duplicateRoot = false;
    for (let index = 0; index < roots.length; index += 1) {
      for (let prior = 0; prior < index; prior += 1) {
        if (roots[index] === roots[prior]) duplicateRoot = true;
      }
    }
    if (root === undefined || duplicateRoot ||
        rootIndex > identity.maximumShadowRoots) {
      return {
        candidates: [],
        sensitiveIndexes: [],
        sensitiveConnected: connected(identity.sensitiveElements),
        failure: "shadow-root-identity-unprovable",
      };
    }
    const walker = operations.documentCreateTreeWalker(document, root, NodeFilter.SHOW_ELEMENT);
    for (let node = operations.treeWalkerNextNode(walker); node !== null;
      node = operations.treeWalkerNextNode(walker)) {
      if (!operations.isElement(node)) {
        return {
          candidates: [],
          sensitiveIndexes: [],
          sensitiveConnected: connected(identity.sensitiveElements),
          failure: "candidate-unprovable",
        };
      }
      domElements += 1;
      if (domElements > identity.maximumDomElements) {
        return {
          candidates: [],
          sensitiveIndexes: [],
          sensitiveConnected: connected(identity.sensitiveElements),
          failure: "dom-element-overflow",
        };
      }
      if (operations.elementMatches(node, selector)) elements[elements.length] = node;
      const shadowRoot = operations.elementShadowRoot(node);
      if (shadow === undefined && shadowRoot !== null) roots[roots.length] = shadowRoot;
      if (elements.length > identity.maximumCandidates) {
        return {
          candidates: [],
          sensitiveIndexes: [],
          sensitiveConnected: connected(identity.sensitiveElements),
          failure: "candidate-overflow",
        };
      }
    }
  }
  const candidates: ObservationCandidate[] = [];
  const sensitiveIndexes: number[] = [];
  for (let index = 0; index < identity.sensitiveElements.length; index += 1) sensitiveIndexes[index] = -1;
  let snapshotBytes = 0;

  try {
    for (let elementIndex = 0; elementIndex < elements.length; elementIndex += 1) {
      const element = elements[elementIndex];
      if (element === undefined) throw new Error("candidate-unprovable");
      if (!isVisible(element)) {
        continue;
      }
      const role = roleOf(element);
      const name = operations.stringTrim(accessibleName(element));

    const isFormField = operations.isInput(element) || operations.isTextArea(element);
    let value: string | undefined;
    if (isFormField) {
      const type = operations.stringToLowerCase(operations.elementGetAttribute(element, "type") ?? "text");
      const field = element as HTMLInputElement | HTMLTextAreaElement;
      if (type !== "password" && field.value !== "") {
        value = boundedProperty(field.value) ?? undefined;
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
    if (!interactive || operations.elementHasAttribute(element, "data-qualigence-observe")) {
      const content = boundedText(element);
      if (operations.stringTrim(content) !== "") {
        text = content;
      }
    }

    const disabled =
      (element as HTMLButtonElement).disabled === true ||
      operations.elementGetAttribute(element, "aria-disabled") === "true";

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
    let sensitiveIndex = -1;
    for (let index = 0; index < identity.sensitiveElements.length; index += 1) {
      if (identity.sensitiveElements[index] === element) sensitiveIndex = index;
    }
    if (sensitiveIndex >= 0) {
      sensitiveIndexes[sensitiveIndex] = candidates.length;
    }
      candidates[candidates.length] = candidate;
    }
  } catch {
    return {
      candidates: [],
      sensitiveIndexes: [],
      sensitiveConnected: connected(identity.sensitiveElements),
      failure: "snapshot-unprovable",
    };
  }

  return {
    candidates,
    sensitiveIndexes,
    sensitiveConnected: connected(identity.sensitiveElements),
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
      const bounded = this.session.hasSensitiveActionTracker();
      await this.session.prepareSensitiveEvidenceCapture();
      const sensitiveTargets = this.session.sensitiveTargets();
      const captured = await page.evaluate(collectCandidates, {
        sensitiveElements: sensitiveTargets.map((target) => target.handle),
        shadowRegistry: bounded ? this.session.shadowRegistryForEvidence() : undefined,
        authority: this.session.promiseIntrinsicsForEvidence(),
        bounded,
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
      let missingSensitiveTarget = false;
      for (let index = 0; index < captured.sensitiveConnected.length; index += 1) {
        if (captured.sensitiveConnected[index] !== true) missingSensitiveTarget = true;
      }
      for (let index = 0; index < captured.sensitiveIndexes.length; index += 1) {
        if ((captured.sensitiveIndexes[index] ?? -1) < 0) missingSensitiveTarget = true;
      }
      if (missingSensitiveTarget) {
        throw new WebTargetError(
          "SensitiveTargetUnproven",
          "A sensitive action target cannot be proven in the current observation.",
        );
      }
      this.session.recordPreSensitiveObservationCandidateCount(captured.candidates.length);
      const raw: ObservationCandidate[] = [];
      for (let candidateIndex = 0; candidateIndex < captured.candidates.length; candidateIndex += 1) {
        const candidate = captured.candidates[candidateIndex];
        if (candidate === undefined) throw new WebTargetError("SensitiveTargetUnproven");
        let sensitive = false;
        for (let index = 0; index < captured.sensitiveIndexes.length; index += 1) {
          if (captured.sensitiveIndexes[index] === candidateIndex) sensitive = true;
        }
        raw[candidateIndex] = {
          role: candidate.role,
          ...(sensitive
            ? { name: REDACTED, text: REDACTED, value: REDACTED }
            : {
                ...(candidate.name === undefined ? {} : { name: candidate.name }),
                ...(candidate.text === undefined ? {} : { text: candidate.text }),
                ...(candidate.value === undefined ? {} : { value: candidate.value }),
              }),
          ...(candidate.disabled === undefined ? {} : { disabled: candidate.disabled }),
        };
      }
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

      if (bounded) await this.session.verifySensitiveShadowRoots();
      const screenshot = await captureScreenshot(
        page,
        sensitiveTargets,
        this.session,
        () => this.session.failIfSensitiveTrackingOverflowed(),
      );
      const artifacts = buildArtifacts(ordinal, graphWithRefs, screenshot);
      const afterCandidateCreated = this.session.afterSensitiveEvidenceCandidateCreated;
      if (bounded && afterCandidateCreated !== undefined) {
        await afterCandidateCreated(attempt + 1);
      }
      const stable = await this.session.completeSensitiveEvidenceCapture();
      if (!stable) {
        this.session.reportSensitiveEvidenceChangedDuringCapture();
        if (attempt === 0) continue;
        throw this.session.sensitiveEvidenceChangedDuringCapture();
      }
      await this.session.failIfSensitiveTrackingOverflowed();
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

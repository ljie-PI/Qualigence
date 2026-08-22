import {
  chromium,
  type Browser,
  type BrowserContext,
  type ElementHandle,
  type JSHandle,
  type Locator,
  type Page,
} from "playwright";
import type { CapturedArtifact, LocatorDescriptor } from "./types.js";

export type WebTargetErrorCode =
  | "BrowserLaunchFailed"
  | "NavigationFailed"
  | "NavigationTimedOut"
  | "StaleObservation"
  | "UnknownObservationNode"
  | "TargetNotFound"
  | "AmbiguousTarget"
  | "OriginViolation"
  | "ActionTimedOut"
  | "ActionInfrastructureFailure"
  | "SensitiveTargetUnproven"
  | "SensitiveEvidenceUnproven"
  | "UnsupportedAction"
  | "ConcurrentSessionOperation"
  | "SessionClosed";

const WEB_TARGET_ERROR_MESSAGES: Readonly<Record<WebTargetErrorCode, string>> = {
  BrowserLaunchFailed: "The browser could not be started.",
  NavigationFailed: "The browser could not navigate to the target.",
  NavigationTimedOut: "Navigation timed out.",
  StaleObservation: "The observation is no longer current.",
  UnknownObservationNode: "The observation node is unknown.",
  TargetNotFound: "The target could not be found.",
  AmbiguousTarget: "The target is ambiguous.",
  OriginViolation: "The target origin is not allowed.",
  ActionTimedOut: "The browser action timed out.",
  ActionInfrastructureFailure: "The browser action infrastructure failed.",
  SensitiveTargetUnproven: "The sensitive target could not be proven.",
  SensitiveEvidenceUnproven: "Sensitive evidence could not be proven.",
  UnsupportedAction: "The browser action is unsupported.",
  ConcurrentSessionOperation: "A browser session operation is already active.",
  SessionClosed: "The browser session is closed.",
};

export class WebTargetError extends Error {
  constructor(
    readonly code: WebTargetErrorCode,
    _message?: string,
  ) {
    super(WEB_TARGET_ERROR_MESSAGES[code]);
    this.name = "WebTargetError";
  }
}

export interface WebSessionOptions {
  readonly url: string;
  readonly headed: boolean;
  readonly navigationTimeoutMs: number;
  readonly actionTimeoutMs: number;
  readonly allowedOrigins: readonly string[];
}

/**
 * Test seam for injecting a fake browser in unit tests. Product code always
 * uses {@link chromiumLauncher}. This interface intentionally references the
 * Playwright `Browser` type; it is only reachable through the package's
 * internal (test-only) entry point, never through the public product surface.
 */
export interface BrowserLauncher {
  launch(options: { readonly headless: boolean }): Promise<Browser>;
}

/** Internal hooks used only to exercise sensitive evidence boundaries. */
export interface BrowserSessionTestHooks {
  readonly afterArtifactIntegrityChecks?: () => Promise<void>;
  readonly afterSensitiveEvidenceCandidateCreated?: (attempt: number) => Promise<void>;
  readonly onSensitiveEvidenceDiagnostic?: (
    reason: SensitiveEvidenceDiagnosticReason,
  ) => void;
}

/** Safe, test-only classification of the integrity check that failed closed. */
export type SensitiveEvidenceDiagnosticReason =
  | "ArtifactCacheUnavailable"
  | "ArtifactCopyUnproven"
  | "EvidenceChangedDuringCapture"
  | "PromiseAuthorityUnavailable"
  | "PromiseDelegationUnsettled"
  | "PromiseIntegrityUnproven"
  | "PromiseOwnerIntegrityUnproven"
  | "ReflectionCurrentStateUnproven"
  | "ReflectionCausalityUnproven"
  | "ReflectionCharacterMutationUnproven"
  | "ReflectionChildMutationUnproven"
  | "SchedulerProvenanceUnproven"
  | "ScheduledCallbackBoundsExceeded"
  | "SensitiveEventAmbiguous"
  | "SensitiveTargetIdentityUnproven"
  | "ShadowIntegrityUnproven"
  | "TrackerObserverUnproven"
  | "TrackerOverflow"
  | "TrackerReconciliationUnproven";

export const chromiumLauncher: BrowserLauncher = {
  launch: (options) => chromium.launch({ headless: options.headless }),
};

function cloneArtifactBatch(
  artifacts: readonly (Omit<CapturedArtifact, "bytes"> & {
    readonly bytes: ArrayLike<number>;
  })[],
): readonly CapturedArtifact[] {
  return Object.freeze(artifacts.map((artifact) => Object.freeze({
    name: artifact.name,
    mediaType: artifact.mediaType,
    bytes: Uint8Array.from(artifact.bytes),
  })));
}

export function normalizeOrigin(url: string): string {
  return new URL(url).origin;
}

export function isOriginAllowed(
  url: string,
  allowedOrigins: readonly string[],
): boolean {
  let origin: string;
  try {
    origin = normalizeOrigin(url);
  } catch {
    return false;
  }
  return allowedOrigins.includes(origin);
}

type SessionState = "new" | "starting" | "started" | "closing" | "closed";

export interface StoredObservation {
  readonly descriptors: ReadonlyMap<string, LocatorDescriptor>;
  readonly artifacts: readonly CapturedArtifact[];
  readonly artifactCache?: JSHandle<PrivateArtifactCache>;
}

export interface PrivateActionTarget {
  readonly token: string;
  readonly locator: Locator;
  readonly handle: ElementHandle<Element>;
  markerInstalled: boolean;
}

export interface SensitiveActionTarget extends PrivateActionTarget {
  readonly nodeId: string | undefined;
  readonly closedShadowRoot: boolean;
}

export const PRIVATE_TARGET_ATTRIBUTE = "data-qualigence-private-target";
export const MAXIMUM_SENSITIVE_ACTION_TARGETS = 32;
const MAXIMUM_SENSITIVE_ACTION_MUTATIONS = 128;
const MAXIMUM_OBSERVED_PROMISE_OWNERS = 128;
const MAXIMUM_SENSITIVE_ACTION_CANDIDATES = 512;
const MAXIMUM_SENSITIVE_SCHEDULED_CALLBACKS = 64;
const MAXIMUM_SENSITIVE_SHADOW_ROOTS = 64;
const MAXIMUM_SENSITIVE_DOM_ELEMENTS = 4_096;
export const MAXIMUM_OBSERVATION_CANDIDATES = 512;
export const MAXIMUM_OBSERVATION_NODE_BYTES = 64 * 1024;
export const MAXIMUM_OBSERVATION_SNAPSHOT_BYTES = 2 * 1024 * 1024;
export const MAXIMUM_OBSERVATION_SHADOW_ROOTS = MAXIMUM_SENSITIVE_SHADOW_ROOTS;
export const MAXIMUM_OBSERVATION_DOM_ELEMENTS = MAXIMUM_SENSITIVE_DOM_ELEMENTS;
const SENSITIVE_ACTION_CANDIDATE_SELECTOR =
  "button, a[href], input, textarea, select, [role], [data-qualigence-observe]";
const SENSITIVE_ACTION_ATTRIBUTES = [
  "aria-label",
  "aria-labelledby",
  "placeholder",
  "title",
  "alt",
  "value",
] as const;
const PRIVATE_SHADOW_REGISTRY_DESCRIPTION = "qualigence.private.shadow-registry";

export interface BoundedCdpSession {
  getDocument(): Promise<CdpDomNode>;
  describeNode(reference: { readonly nodeId: number } | { readonly backendNodeId: number }): Promise<CdpDomNode>;
  resolveNode(backendNodeId: number): Promise<string>;
  callFunctionOnBoolean(
    objectId: string,
    functionDeclaration: string,
    args: readonly unknown[],
  ): Promise<boolean>;
  releaseObjectGroup(): Promise<void>;
}

export interface RawCdpSession {
  getDocument(): Promise<unknown>;
  describeNode(reference: { readonly nodeId: number } | { readonly backendNodeId: number }): Promise<unknown>;
  resolveNode(backendNodeId: number): Promise<unknown>;
  callFunctionOn(
    objectId: string,
    functionDeclaration: string,
    args: readonly unknown[],
  ): Promise<unknown>;
  releaseObjectGroup(): Promise<unknown>;
}

interface CdpDomNode {
  readonly nodeId: number;
  readonly backendNodeId: number;
  readonly nodeType: number;
  readonly childNodeCount: number;
  readonly shadowRootType: string | undefined;
  readonly children: readonly CdpDomNode[];
  readonly shadowRoots: readonly CdpDomNode[];
  readonly contentDocument: CdpDomNode | undefined;
  readonly templateContent: CdpDomNode | undefined;
}

interface CdpResponseBudget {
  nodes: number;
  bytes: number;
}

const MAXIMUM_CDP_RESPONSE_BYTES = MAXIMUM_OBSERVATION_SNAPSHOT_BYTES;
const CDP_NODE_ARRAY_FIELDS = ["children", "shadowRoots"] as const;
const CDP_NODE_FIELDS = ["contentDocument", "templateContent", "assignedSlot"] as const;

function asCdpObject(value: unknown): object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("cdp-response-unproven");
  }
  return value;
}

function cdpOwnValue(source: object, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(source, name);
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor)) throw new Error("cdp-response-unproven");
  return descriptor.value;
}

function addCdpBytes(budget: CdpResponseBudget, amount: number): void {
  if (!Number.isSafeInteger(amount) || amount < 0 ||
      budget.bytes > MAXIMUM_CDP_RESPONSE_BYTES - amount) {
    throw new Error("cdp-response-unproven");
  }
  budget.bytes += amount;
}

function validateCdpPrimitiveFields(source: object, budget: CdpResponseBudget): void {
  for (const key of Reflect.ownKeys(source)) {
    if (typeof key !== "string") throw new Error("cdp-response-unproven");
    addCdpBytes(budget, key.length * 2 + 8);
    const value = cdpOwnValue(source, key);
    if (value === undefined || value === null) continue;
    if (typeof value === "string") addCdpBytes(budget, value.length * 2);
    else if (typeof value === "number" || typeof value === "boolean") addCdpBytes(budget, 8);
    else if (!CDP_NODE_ARRAY_FIELDS.includes(key as typeof CDP_NODE_ARRAY_FIELDS[number]) &&
        !CDP_NODE_FIELDS.includes(key as typeof CDP_NODE_FIELDS[number])) {
      if (key === "attributes" && Array.isArray(value)) {
        if (value.length > MAXIMUM_CDP_RESPONSE_BYTES / 2) throw new Error("cdp-response-unproven");
        for (let index = 0; index < value.length; index += 1) {
          const item = cdpOwnValue(value, String(index));
          if (typeof item !== "string") throw new Error("cdp-response-unproven");
          addCdpBytes(budget, item.length * 2 + 8);
        }
      } else {
        throw new Error("cdp-response-unproven");
      }
    }
  }
}

function cdpNodeArray(
  source: object,
  name: typeof CDP_NODE_ARRAY_FIELDS[number],
  maximumNodes: number,
  budget: CdpResponseBudget,
): readonly unknown[] {
  const value = cdpOwnValue(source, name);
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximumNodes ||
      budget.nodes > maximumNodes - value.length) {
    throw new Error("cdp-response-unproven");
  }
  return value;
}

interface ValidatedCdpNode {
  readonly source: object;
  readonly children: readonly unknown[];
  readonly shadowRoots: readonly unknown[];
  readonly contentDocument: unknown;
  readonly templateContent: unknown;
}

function validateCdpNode(
  value: unknown,
  maximumNodes: number,
  budget: CdpResponseBudget,
): ValidatedCdpNode {
  const source = asCdpObject(value);
  budget.nodes += 1;
  if (budget.nodes > maximumNodes) throw new Error("cdp-response-unproven");
  validateCdpPrimitiveFields(source, budget);
  for (const name of ["nodeId", "backendNodeId", "nodeType"] as const) {
    const candidate = cdpOwnValue(source, name);
    if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 0) {
      throw new Error("cdp-response-unproven");
    }
  }
  const childNodeCount = cdpOwnValue(source, "childNodeCount");
  if (childNodeCount !== undefined &&
      (typeof childNodeCount !== "number" || !Number.isSafeInteger(childNodeCount) ||
        childNodeCount < 0)) {
    throw new Error("cdp-response-unproven");
  }
  const children = cdpNodeArray(source, "children", maximumNodes, budget);
  const shadowRoots = cdpNodeArray(source, "shadowRoots", maximumNodes, budget);
  const contentDocument = cdpOwnValue(source, "contentDocument");
  const templateContent = cdpOwnValue(source, "templateContent");
  const assignedSlot = cdpOwnValue(source, "assignedSlot");
  if (assignedSlot !== undefined) {
    const slot = asCdpObject(assignedSlot);
    validateCdpPrimitiveFields(slot, budget);
    for (const name of ["nodeType", "backendNodeId"] as const) {
      const candidate = cdpOwnValue(slot, name);
      if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 0) {
        throw new Error("cdp-response-unproven");
      }
    }
    if (typeof cdpOwnValue(slot, "nodeName") !== "string") {
      throw new Error("cdp-response-unproven");
    }
  }
  const singularCount = Number(contentDocument !== undefined) + Number(templateContent !== undefined);
  const rawNodeCount = children.length + shadowRoots.length + singularCount;
  if (budget.nodes > maximumNodes - rawNodeCount) throw new Error("cdp-response-unproven");
  const shadowRootType = cdpOwnValue(source, "shadowRootType");
  if (shadowRootType !== undefined && typeof shadowRootType !== "string") {
    throw new Error("cdp-response-unproven");
  }
  return { source, children, shadowRoots, contentDocument, templateContent };
}

function normalizedCdpLeaf(validated: ValidatedCdpNode): CdpDomNode {
  const number = (name: string, fallback?: number): number => {
    const value = cdpOwnValue(validated.source, name) ?? fallback;
    if (typeof value !== "number") throw new Error("cdp-response-unproven");
    return value;
  };
  const shadowRootType = cdpOwnValue(validated.source, "shadowRootType");
  return {
    nodeId: number("nodeId"),
    backendNodeId: number("backendNodeId"),
    nodeType: number("nodeType"),
    childNodeCount: number("childNodeCount", 0),
    shadowRootType: typeof shadowRootType === "string" ? shadowRootType : undefined,
    children: [],
    shadowRoots: [],
    contentDocument: undefined,
    templateContent: undefined,
  };
}

function normalizedCdpDirect(validated: ValidatedCdpNode): CdpDomNode {
  return {
    ...normalizedCdpLeaf(validated),
    shadowRoots: Array.from(
      { length: validated.shadowRoots.length },
      (_, index) => normalizedCdpLeaf({
        source: asCdpObject(cdpOwnValue(validated.shadowRoots, String(index))),
        children: [],
        shadowRoots: [],
        contentDocument: undefined,
        templateContent: undefined,
      }),
    ),
  };
}

function cdpResponseNode(
  response: unknown,
  name: "root" | "node",
  maximumDepth: 0 | 1,
  maximumNodes: number,
): CdpDomNode {
  const source = asCdpObject(response);
  const budget: CdpResponseBudget = { nodes: 0, bytes: 0 };
  const keys = Reflect.ownKeys(source);
  if (keys.length !== 1 || keys[0] !== name) throw new Error("cdp-response-unproven");
  const root = validateCdpNode(cdpOwnValue(source, name), maximumNodes, budget);
  const directCount = root.children.length + root.shadowRoots.length +
    Number(root.contentDocument !== undefined) + Number(root.templateContent !== undefined);
  if (maximumDepth === 0 && directCount !== 0) throw new Error("cdp-response-unproven");

  const children: ValidatedCdpNode[] = [];
  const shadowRoots: ValidatedCdpNode[] = [];
  let contentDocument: ValidatedCdpNode | undefined;
  let templateContent: ValidatedCdpNode | undefined;
  const validateDirect = (value: unknown): ValidatedCdpNode => {
    const direct = validateCdpNode(value, maximumNodes, budget);
    if (direct.children.length !== 0 || direct.contentDocument !== undefined ||
        direct.templateContent !== undefined) {
      throw new Error("cdp-response-unproven");
    }
    for (let index = 0; index < direct.shadowRoots.length; index += 1) {
      const metadata = validateCdpNode(
        cdpOwnValue(direct.shadowRoots, String(index)), maximumNodes, budget,
      );
      if (metadata.children.length !== 0 || metadata.shadowRoots.length !== 0 ||
          metadata.contentDocument !== undefined || metadata.templateContent !== undefined) {
        throw new Error("cdp-response-unproven");
      }
    }
    return direct;
  };
  for (let index = 0; index < root.children.length; index += 1) {
    children.push(validateDirect(cdpOwnValue(root.children, String(index))));
  }
  for (let index = 0; index < root.shadowRoots.length; index += 1) {
    shadowRoots.push(validateDirect(cdpOwnValue(root.shadowRoots, String(index))));
  }
  if (root.contentDocument !== undefined) contentDocument = validateDirect(root.contentDocument);
  if (root.templateContent !== undefined) templateContent = validateDirect(root.templateContent);

  const normalizedRoot = normalizedCdpLeaf(root);
  return {
    ...normalizedRoot,
    children: children.map(normalizedCdpDirect),
    shadowRoots: shadowRoots.map(normalizedCdpDirect),
    contentDocument: contentDocument === undefined ? undefined : normalizedCdpDirect(contentDocument),
    templateContent: templateContent === undefined ? undefined : normalizedCdpDirect(templateContent),
  };
}

function cdpPrimitiveRecord(value: unknown, budget: CdpResponseBudget): object {
  const source = asCdpObject(value);
  for (const key of Reflect.ownKeys(source)) {
    if (typeof key !== "string") throw new Error("cdp-response-unproven");
    addCdpBytes(budget, key.length * 2 + 8);
    const candidate = cdpOwnValue(source, key);
    if (candidate === undefined || candidate === null) continue;
    if (typeof candidate === "string") addCdpBytes(budget, candidate.length * 2);
    else if (typeof candidate !== "number" && typeof candidate !== "boolean") {
      throw new Error("cdp-response-unproven");
    }
  }
  return source;
}

function stableCdpResponse<T>(validate: () => T): T {
  try {
    return validate();
  } catch {
    throw new Error("cdp-response-unproven");
  }
}

export function createBoundedCdpSession(
  raw: RawCdpSession,
  maximumNodes: number,
): BoundedCdpSession {
  return {
    getDocument: async () => {
      const response = await raw.getDocument()
        .catch(() => { throw new Error("cdp-response-unproven"); });
      return stableCdpResponse(() => cdpResponseNode(response, "root", 0, maximumNodes));
    },
    describeNode: async (reference) => {
      const response = await raw.describeNode(reference)
        .catch(() => { throw new Error("cdp-response-unproven"); });
      return stableCdpResponse(() => cdpResponseNode(response, "node", 1, maximumNodes));
    },
    resolveNode: async (backendNodeId) => {
      const response = await raw.resolveNode(backendNodeId)
        .catch(() => { throw new Error("cdp-response-unproven"); });
      return stableCdpResponse(() => {
        const source = asCdpObject(response);
        const keys = Reflect.ownKeys(source);
        if (keys.length !== 1 || keys[0] !== "object") throw new Error("cdp-response-unproven");
        const object = cdpPrimitiveRecord(cdpOwnValue(source, "object"), { nodes: 0, bytes: 0 });
        const objectId = cdpOwnValue(object, "objectId");
        if (typeof objectId !== "string" || objectId.length === 0 ||
            objectId.length * 2 > MAXIMUM_CDP_RESPONSE_BYTES) {
          throw new Error("cdp-response-unproven");
        }
        return objectId;
      });
    },
    callFunctionOnBoolean: async (objectId, functionDeclaration, args) => {
      const response = await raw.callFunctionOn(objectId, functionDeclaration, args)
        .catch(() => { throw new Error("cdp-response-unproven"); });
      return stableCdpResponse(() => {
        const source = asCdpObject(response);
        if (cdpOwnValue(source, "exceptionDetails") !== undefined) {
          throw new Error("cdp-response-unproven");
        }
        const keys = Reflect.ownKeys(source);
        if (keys.length !== 1 || keys[0] !== "result") throw new Error("cdp-response-unproven");
        const result = cdpPrimitiveRecord(cdpOwnValue(source, "result"), { nodes: 0, bytes: 0 });
        const value = cdpOwnValue(result, "value");
        if (typeof value !== "boolean") throw new Error("cdp-response-unproven");
        return value;
      });
    },
    releaseObjectGroup: async () => {
      const response = await raw.releaseObjectGroup()
        .catch(() => { throw new Error("cdp-response-unproven"); });
      stableCdpResponse(() => {
        const source = asCdpObject(response);
        if (Reflect.ownKeys(source).length !== 0) throw new Error("cdp-response-unproven");
      });
    },
  };
}

export async function inventoryPiercedDom(
  session: BoundedCdpSession,
  limits: {
    readonly maximumNodes: number;
    readonly maximumShadowRoots: number;
    readonly maximumFrames: number;
  },
): Promise<{
  readonly shadowHosts: readonly { readonly backendNodeId: number; readonly mode: string }[];
  readonly shadowRootCount: number;
  readonly frameCount: number;
  readonly nodeCount: number;
}> {
  if (limits.maximumNodes < 1 || limits.maximumShadowRoots < 0 || limits.maximumFrames < 0) {
    throw new Error("cdp-limits-unproven");
  }
  const root = await session.getDocument();
  const queue: CdpDomNode[] = [];
  const seen = new Set<number>();
  const shadowHosts: { readonly backendNodeId: number; readonly mode: string }[] = [];
  let requestCount = 1;
  let shadowRootCount = 0;
  let frameCount = 0;
  const append = (node: CdpDomNode, kind: "node" | "shadow" | "frame"): void => {
    if (seen.has(node.backendNodeId)) return;
    if (seen.size >= limits.maximumNodes || queue.length >= limits.maximumNodes) {
      throw new Error("dom-node-overflow");
    }
    if (kind === "shadow") {
      if (shadowRootCount >= limits.maximumShadowRoots) throw new Error("shadow-root-overflow");
      shadowRootCount += 1;
    } else if (kind === "frame") {
      if (frameCount >= limits.maximumFrames) throw new Error("frame-overflow");
      frameCount += 1;
    }
    seen.add(node.backendNodeId);
    queue.push(node);
  };
  append(root, "node");

  for (let index = 0; index < queue.length; index += 1) {
    const shallow = queue[index];
    if (shallow === undefined) throw new Error("shadow-node-unproven");
    if (shallow.childNodeCount > limits.maximumNodes - seen.size) {
      throw new Error("dom-node-overflow");
    }
    if (requestCount >= limits.maximumNodes) throw new Error("dom-request-overflow");
    requestCount += 1;
    const reference = shallow.nodeId > 0
      ? { nodeId: shallow.nodeId }
      : { backendNodeId: shallow.backendNodeId };
    const described = await session.describeNode(reference);
    if (described.backendNodeId !== shallow.backendNodeId ||
        described.children.length !== described.childNodeCount) {
      throw new Error("shadow-node-identity-unproven");
    }
    for (const child of described.children) append(child, "node");
    for (const shadowRoot of described.shadowRoots) {
      if (shadowRoot.shadowRootType === "user-agent") continue;
      shadowHosts.push({
        backendNodeId: described.backendNodeId,
        mode: shadowRoot.shadowRootType ?? "",
      });
      append(shadowRoot, "shadow");
    }
    if (described.contentDocument !== undefined) append(described.contentDocument, "frame");
    if (described.templateContent !== undefined) append(described.templateContent, "node");
  }
  return {
    shadowHosts,
    shadowRootCount,
    frameCount,
    nodeCount: seen.size,
  };
}

interface SensitiveActionPropertySnapshot {
  readonly inputValue: string | null;
  readonly selectValue: string | null;
  readonly selectedOptionText: string | null;
  readonly textContent: string | null;
  readonly attributes: readonly (string | null)[];
}

interface SensitiveActionCandidateSnapshot {
  readonly element: Element;
  readonly properties: SensitiveActionPropertySnapshot;
}

interface SensitiveActionMutationRecord {
  readonly record: MutationRecord;
  readonly causal: boolean;
}

interface PrivateShadowRootEntry {
  readonly host: Element;
  readonly root: ShadowRoot;
  readonly mode: ShadowRootMode;
}

interface PrivateShadowHostSummary {
  readonly host: Element;
  readonly mode: ShadowRootMode;
}

export interface PrivateShadowRegistry {
  readonly snapshot: (maximumRoots: number) => {
    readonly roots: readonly PrivateShadowRootEntry[];
    readonly hosts: readonly PrivateShadowHostSummary[];
    readonly closedMutationCount: number;
    readonly count: number;
    readonly overflow: boolean;
    readonly intact: boolean;
  };
  readonly subscribe: (
    listener: (host: Element, root: ShadowRoot, mode: ShadowRootMode) => void,
  ) => boolean;
  readonly unsubscribe: (
    listener: (host: Element, root: ShadowRoot, mode: ShadowRootMode) => void,
  ) => boolean;
}

interface PrivatePromiseIntrinsicsSnapshot {
  readonly then: Promise<unknown>["then"];
  readonly catch: Promise<unknown>["catch"];
  readonly finally: Promise<unknown>["finally"];
  readonly wrappedThen: Promise<unknown>["then"];
  readonly wrappedCatch: Promise<unknown>["catch"];
  readonly wrappedFinally: Promise<unknown>["finally"];
  readonly intact: boolean;
  readonly ownDescriptor: (target: object, key: PropertyKey) => PropertyDescriptor | undefined;
  readonly prototypeOf: (target: object) => object | null;
  readonly descriptorShapeIntact: boolean;
}

interface PrivatePromiseDelegationToken {
  delegated: boolean;
  settled: boolean;
}

interface PrivatePromiseBoundaryHook {
  readonly custom: (receiver: unknown) => PrivatePromiseDelegationToken[];
  readonly child: (
    parents: readonly PrivatePromiseDelegationToken[],
  ) => PrivatePromiseDelegationToken[];
  readonly wrap: (
    receiver: unknown,
    onfulfilled: unknown,
    onrejected: unknown,
    associated: readonly PrivatePromiseDelegationToken[],
  ) => readonly [unknown, unknown];
  readonly settle: (tokens: readonly PrivatePromiseDelegationToken[]) => void;
  readonly returned: (receiver: object) => void;
}

interface PrivatePromiseIntrinsics {
  readonly attest: (epoch: string) => boolean;
  readonly snapshot: () => PrivatePromiseIntrinsicsSnapshot;
  readonly observe: (receiver: unknown) => boolean;
  readonly subscribe: (hook: PrivatePromiseBoundaryHook) => boolean;
  readonly unsubscribe: (hook: PrivatePromiseBoundaryHook) => boolean;
  readonly isWrappedThen: (candidate: unknown) => boolean;
  readonly revalidateOwners: () => boolean;
  readonly close: () => boolean;
}

export interface SerializedArtifact {
  readonly name: string;
  readonly mediaType: CapturedArtifact["mediaType"];
  readonly bytes: ArrayLike<number>;
}

interface PrivateArtifactCache {
  consumed: boolean;
  artifacts: readonly SerializedArtifact[];
}

interface ArtifactIntegrityAuthority {
  readonly snapshot: () => {
    readonly intact: boolean;
    readonly descriptorShapeIntact: boolean;
  };
  readonly revalidateOwners: () => boolean;
}

type ArtifactIntegrityTracker = Pick<
  SensitiveActionMutationTracker,
  | "overflow"
  | "observerError"
  | "scheduledPoison"
  | "schedulerProvenanceUnproven"
  | "outstandingPromiseDelegations"
  | "promiseIntegrity"
  | "shadowPoison"
  | "ambiguousEvent"
>;

export function finalizeArtifactBatch(
  authority: ArtifactIntegrityAuthority,
  input: {
    readonly trackers: readonly ArtifactIntegrityTracker[];
    readonly cache: PrivateArtifactCache;
  },
): readonly SerializedArtifact[] {
  if (input.cache.consumed) throw new Error("artifact-cache-consumed");
  try {
    const snapshot = authority.snapshot();
    for (const [index, tracker] of input.trackers.entries()) {
      if (tracker.overflow) throw new Error("TrackerOverflow");
      if (tracker.observerError) throw new Error("TrackerObserverUnproven");
      if (tracker.scheduledPoison) throw new Error("ScheduledCallbackBoundsExceeded");
      if (tracker.schedulerProvenanceUnproven) throw new Error("SchedulerProvenanceUnproven");
      if (tracker.outstandingPromiseDelegations > 0) throw new Error("PromiseDelegationUnsettled");
      if (index === input.trackers.length - 1 && !tracker.promiseIntegrity()) {
        throw new Error("PromiseIntegrityUnproven");
      }
      if (tracker.shadowPoison) throw new Error("ShadowIntegrityUnproven");
      if (tracker.ambiguousEvent) throw new Error("SensitiveEventAmbiguous");
    }
    if (!authority.revalidateOwners()) {
      throw new Error("PromiseOwnerIntegrityUnproven");
    }
    if (!snapshot.intact || !snapshot.descriptorShapeIntact) {
      throw new Error("PromiseIntegrityUnproven");
    }
    const batch = Object.freeze(input.cache.artifacts.map((artifact) => Object.freeze({
      name: artifact.name,
      mediaType: artifact.mediaType,
      bytes: Object.freeze(Array.from(artifact.bytes)),
    })));
    input.cache.consumed = true;
    input.cache.artifacts = Object.freeze([]);
    return batch;
  } catch (error) {
    input.cache.consumed = true;
    input.cache.artifacts = Object.freeze([]);
    throw error;
  }
}

interface SensitiveActionMutationTracker {
  readonly target: Element;
  readonly forms: readonly string[];
  candidates: readonly SensitiveActionCandidateSnapshot[];
  readonly records: SensitiveActionMutationRecord[];
  readonly causalElements: Element[];
  readonly observers: MutationObserver[];
  readonly roots: (Document | ShadowRoot)[];
  readonly shadowRegistry: PrivateShadowRegistry;
  readonly restore: () => boolean;
  readonly promiseIntegrity: () => boolean;
  readonly beginCausalAction: (target: Element) => boolean;
  readonly endCausalAction: (target: Element) => boolean;
  readonly metadata: SensitivePageMetadataAuthority;
  ambiguousEvent: boolean;
  preparedElements: readonly Element[] | undefined;
  overflow: boolean;
  observerError: boolean;
  schedulerActivationUnproven: boolean;
  schedulerProvenanceUnproven: boolean;
  scheduledPoison: boolean;
  scheduledRegistrations: number;
  scheduledExecutions: number;
  outstandingPromiseDelegations: number;
  shadowPoison: boolean;
  closedMutationBaseline: number;
}

interface SensitivePageMetadataSnapshot {
  readonly href: string;
  readonly pathname: string;
  readonly decodedPathname: string;
  readonly query: readonly { readonly key: string; readonly value: string }[];
  readonly hash: string;
  readonly decodedHash: string;
  readonly title: string;
}

interface SensitivePageMetadataAuthority {
  baseline: SensitivePageMetadataSnapshot | undefined;
  readonly hrefs: string[];
  readonly pathnames: string[];
  readonly queryKeys: string[];
  readonly queryValues: string[];
  readonly hashes: string[];
  readonly titles: string[];
  unprovenUrl: boolean;
}

interface SensitivePageRedaction {
  pathname: boolean;
  readonly queryKeys: number[];
  readonly queryValues: number[];
  hash: boolean;
  title: boolean;
}

export class PlaywrightBrowserSession {
  readonly afterSensitiveEvidenceCandidateCreated?: (attempt: number) => Promise<void>;

  private state: SessionState = "new";
  private startPromise?: Promise<void>;
  private browser: Browser | undefined;
  private context: BrowserContext | undefined;
  private page: Page | undefined;
  private shadowRegistry: JSHandle<PrivateShadowRegistry> | undefined;
  private readonly shadowRegistryKey = `${PRIVATE_SHADOW_REGISTRY_DESCRIPTION}:${crypto.randomUUID()}`;
  private readonly shadowRegistryAccessToken = crypto.randomUUID();
  private promiseIntrinsics: JSHandle<PrivatePromiseIntrinsics> | undefined;
  private readonly promiseIntrinsicsKey = `qualigence.private-promise-intrinsics:${crypto.randomUUID()}`;
  private readonly promiseIntrinsicsAccessToken = crypto.randomUUID();
  private readonly promiseInitEpoch = crypto.randomUUID();
  private promiseInitAttested = false;
  private operation: Promise<unknown> = Promise.resolve();
  private observationOrdinal = 0;
  private latestGraph: string | undefined;
  private readonly observations = new Map<string, StoredObservation>();
  private readonly sensitiveActionTargets = new Map<string, SensitiveActionTarget>();
  private readonly privateActionTargets = new Map<string, PrivateActionTarget>();
  private privateTargetOrdinal = 0;
  private sensitiveEvidenceUnproven = false;
  private readonly sensitiveActionTrackers: JSHandle<SensitiveActionMutationTracker>[] = [];
  private preSensitiveObservationCandidateCount = 0;

  constructor(
    private readonly options: WebSessionOptions,
    private readonly launcher: BrowserLauncher = chromiumLauncher,
    private readonly testHooks: BrowserSessionTestHooks = {},
  ) {
    if (testHooks.afterSensitiveEvidenceCandidateCreated !== undefined) {
      this.afterSensitiveEvidenceCandidateCreated =
        testHooks.afterSensitiveEvidenceCandidateCreated;
    }
  }

  get allowedOrigins(): readonly string[] {
    return this.options.allowedOrigins;
  }

  get actionTimeoutMs(): number {
    return this.options.actionTimeoutMs;
  }

  get latestGraphId(): string | undefined {
    return this.latestGraph;
  }

  nextObservationOrdinal(): number {
    this.observationOrdinal += 1;
    return this.observationOrdinal;
  }

  registerObservation(graphId: string, observation: StoredObservation): void {
    this.observations.set(graphId, observation);
    this.latestGraph = graphId;
  }

  async cacheArtifactBatch(
    artifacts: readonly CapturedArtifact[],
  ): Promise<JSHandle<PrivateArtifactCache> | undefined> {
    if (!this.hasSensitiveActionTracker() && !this.hasSensitiveAction()) return undefined;
    if (this.promiseIntrinsics === undefined || !this.promiseInitAttested) {
      throw this.sensitiveEvidenceFailure();
    }
    return this.promiseIntrinsics.evaluateHandle((_authority, source) => ({
      consumed: false,
      artifacts: Object.freeze(source.map((artifact) => Object.freeze({
        name: artifact.name,
        mediaType: artifact.mediaType,
        bytes: Object.freeze(Array.from(artifact.bytes)),
      }))),
    }), artifacts);
  }

  hasGraph(graphId: string): boolean {
    return this.observations.has(graphId);
  }

  descriptorFor(graphId: string, nodeId: string): LocatorDescriptor | undefined {
    return this.observations.get(graphId)?.descriptors.get(nodeId);
  }

  artifactsFor(graphId: string): readonly CapturedArtifact[] {
    this.assertSensitiveEvidenceProven();
    const observation = this.observations.get(graphId);
    if (!observation) {
      throw new WebTargetError(
        "StaleObservation",
        `No observation registered for graph ${graphId}.`,
      );
    }
    return observation.artifacts;
  }

  async captureArtifactBatch(graphId: string): Promise<readonly CapturedArtifact[]> {
    this.assertSensitiveEvidenceProven();
    const observation = this.observations.get(graphId);
    if (!observation) {
      throw new WebTargetError(
        "StaleObservation",
        `No observation registered for graph ${graphId}.`,
      );
    }
    if (!this.hasSensitiveActionTracker() && !this.hasSensitiveAction()) {
      const batch = cloneArtifactBatch(observation.artifacts);
      this.observations.set(graphId, { descriptors: observation.descriptors, artifacts: [] });
      return batch;
    }

    let enteredAtomicTail = false;
    try {
      if (this.promiseIntrinsics === undefined || !this.promiseInitAttested) {
        this.reportSensitiveEvidenceDiagnostic("PromiseAuthorityUnavailable");
        throw new Error("promise-authority-unavailable");
      }
      if (observation.artifactCache === undefined) {
        this.reportSensitiveEvidenceDiagnostic("ArtifactCacheUnavailable");
        throw new Error("artifact-cache-unavailable");
      }
      await this.failIfSensitiveTrackingOverflowed();
      await this.verifySensitiveShadowRoots();
      for (const target of this.sensitiveActionTargets.values()) {
        const intact = await target.handle.evaluate((element, identity) =>
          element.isConnected && element.getAttribute(identity.attribute) === identity.token,
        { attribute: PRIVATE_TARGET_ATTRIBUTE, token: target.token });
        if (!intact) {
          this.reportSensitiveEvidenceDiagnostic("SensitiveTargetIdentityUnproven");
          throw new Error("sensitive-target-identity-unproven");
        }
      }
      await this.testHooks.afterArtifactIntegrityChecks?.();

      // This browser-realm callback is the event-loop-atomic tail: after its
      // final owner check it synchronously clones/freezes and consumes the
      // cache, with no await, yield, Promise, or page call in between.
      enteredAtomicTail = true;
      const serialized: readonly SerializedArtifact[] = await this.promiseIntrinsics.evaluate(
        finalizeArtifactBatch,
        {
          trackers: this.sensitiveActionTrackers,
          cache: observation.artifactCache,
        },
      );
      this.assertSensitiveEvidenceProven();
      const batch = cloneArtifactBatch(serialized);
      this.observations.set(graphId, { descriptors: observation.descriptors, artifacts: [] });
      return batch;
    } catch (error) {
      const classified = this.reportKnownSensitiveEvidenceDiagnostic(error);
      if (enteredAtomicTail && !classified) {
        this.reportSensitiveEvidenceDiagnostic("ArtifactCopyUnproven");
      }
      if (!enteredAtomicTail) await this.purgeArtifactCaches();
      for (const [graphId, observation] of this.observations) {
        this.observations.set(graphId, { descriptors: observation.descriptors, artifacts: [] });
      }
      throw this.sensitiveEvidenceFailure();
    }
  }

  private async purgeArtifactCaches(): Promise<void> {
    await Promise.all([...this.observations.values()].map(async (observation) => {
      await observation.artifactCache?.evaluate((cache) => {
        cache.consumed = true;
        cache.artifacts = Object.freeze([]);
      }).catch(() => undefined);
    }));
  }

  async establishPrivateActionTarget(
    graphId: string,
    nodeId: string,
    locator: Locator,
  ): Promise<void> {
    const handle = await locator.elementHandle();
    if (handle === null) {
      throw new WebTargetError("TargetNotFound", "The resolved target has no stable DOM identity.");
    }
    this.privateTargetOrdinal += 1;
    const token = `target-${this.privateTargetOrdinal}`;
    this.privateActionTargets.set(`${graphId}\0${nodeId}`, {
      token,
      locator,
      handle,
      markerInstalled: false,
    });
  }

  privateActionTargetFor(graphId: string, nodeId: string): PrivateActionTarget | undefined {
    return this.privateActionTargets.get(`${graphId}\0${nodeId}`);
  }

  async registerSensitiveActionTarget(graphId: string, nodeId: string): Promise<void> {
    const target = this.privateActionTargetFor(graphId, nodeId);
    if (target === undefined) {
      throw new WebTargetError(
        "SensitiveTargetUnproven",
        "The sensitive action target has no resolution-bound identity.",
      );
    }
    if (
      !this.sensitiveActionTargets.has(target.token) &&
      this.sensitiveActionTargets.size >= MAXIMUM_SENSITIVE_ACTION_TARGETS
    ) {
      throw new WebTargetError(
        "SensitiveTargetUnproven",
        "The sensitive action target limit was exceeded.",
      );
    }
    if (!target.markerInstalled) {
      const locatedHandle = await target.locator.elementHandle();
      const exactTarget = locatedHandle !== null && await target.handle.evaluate(
        (element, located) => element === located,
        locatedHandle,
      );
      if (locatedHandle !== null && locatedHandle !== target.handle) {
        await locatedHandle.dispose();
      }
      if (!exactTarget) {
        throw new WebTargetError(
          "SensitiveTargetUnproven",
          "The sensitive action target no longer has its resolution-bound identity.",
        );
      }
      const registered = { ...target, nodeId, closedShadowRoot: false };
      this.sensitiveActionTargets.set(target.token, registered);
      try {
        target.markerInstalled = true;
        registered.markerInstalled = true;
        const markerInstalled = await target.handle.evaluate((element, identity) => {
          element.setAttribute(identity.attribute, identity.token);
          return element.getAttribute(identity.attribute) === identity.token;
        }, { attribute: PRIVATE_TARGET_ATTRIBUTE, token: target.token });
        if (!markerInstalled) {
          throw new WebTargetError(
            "SensitiveTargetUnproven",
            "The sensitive action target could not install its private marker.",
          );
        }
      } catch (error) {
        this.sensitiveActionTargets.delete(target.token);
        await target.handle.evaluate((element, identity) => {
          if (element.getAttribute(identity.attribute) === identity.token) {
            element.removeAttribute(identity.attribute);
          }
        }, { attribute: PRIVATE_TARGET_ATTRIBUTE, token: target.token }).catch(() => undefined);
        target.markerInstalled = false;
        registered.markerInstalled = false;
        throw error;
      }
    } else if (!(await target.handle.evaluate((element, identity) =>
      element.getAttribute(identity.attribute) === identity.token,
    { attribute: PRIVATE_TARGET_ATTRIBUTE, token: target.token }))) {
      throw new WebTargetError(
        "SensitiveTargetUnproven",
        "The sensitive action target lost its private marker.",
      );
    }
    const registered = { ...target, nodeId, markerInstalled: true, closedShadowRoot: false };
    this.privateActionTargets.set(`${graphId}\0${nodeId}`, registered);
    this.sensitiveActionTargets.set(target.token, registered);
  }

  sensitiveTargets(): readonly SensitiveActionTarget[] {
    this.assertSensitiveEvidenceProven();
    return [...this.sensitiveActionTargets.values()];
  }

  shadowRegistryForEvidence(): JSHandle<PrivateShadowRegistry> {
    if (this.shadowRegistry === undefined) {
      throw this.sensitiveEvidenceFailure("The private shadow-root registry is unavailable.");
    }
    return this.shadowRegistry;
  }

  sensitiveEvidenceFailure(_message?: string): WebTargetError {
    this.sensitiveEvidenceUnproven = true;
    return new WebTargetError("SensitiveEvidenceUnproven");
  }

  private reportSensitiveEvidenceDiagnostic(reason: SensitiveEvidenceDiagnosticReason): void {
    try {
      this.testHooks.onSensitiveEvidenceDiagnostic?.(reason);
    } catch {
      // Diagnostics are observation-only and cannot affect fail-closed behavior.
    }
  }

  private reportKnownSensitiveEvidenceDiagnostic(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const reasons: readonly SensitiveEvidenceDiagnosticReason[] = [
      "ArtifactCopyUnproven",
      "EvidenceChangedDuringCapture",
      "PromiseDelegationUnsettled",
      "PromiseIntegrityUnproven",
      "PromiseOwnerIntegrityUnproven",
      "ReflectionCurrentStateUnproven",
      "ReflectionCausalityUnproven",
      "ReflectionCharacterMutationUnproven",
      "ReflectionChildMutationUnproven",
      "SchedulerProvenanceUnproven",
      "ScheduledCallbackBoundsExceeded",
      "SensitiveEventAmbiguous",
      "ShadowIntegrityUnproven",
      "TrackerObserverUnproven",
      "TrackerOverflow",
      "TrackerReconciliationUnproven",
    ];
    const reason = reasons.find((candidate) => candidate === error.message);
    if (reason !== undefined) this.reportSensitiveEvidenceDiagnostic(reason);
    return reason !== undefined;
  }

  hasSensitiveAction(): boolean {
    return this.sensitiveActionTargets.size > 0;
  }

  hasSensitiveActionTracker(): boolean {
    return this.sensitiveActionTrackers.length > 0;
  }

  observationCandidateLimit(): number {
    return Math.max(MAXIMUM_OBSERVATION_CANDIDATES, this.preSensitiveObservationCandidateCount);
  }

  recordPreSensitiveObservationCandidateCount(count: number): void {
    if (this.sensitiveActionTrackers.length === 0) {
      this.preSensitiveObservationCandidateCount = Math.max(
        this.preSensitiveObservationCandidateCount,
        count,
      );
    }
  }

  private assertSensitiveEvidenceProven(): void {
    if (this.sensitiveEvidenceUnproven) {
      throw new WebTargetError(
        "SensitiveEvidenceUnproven",
        "Sensitive evidence cannot be proven for this session.",
      );
    }
  }

  async beginSensitiveActionTracking(
    target: ElementHandle<Element>,
    kind: "input" | "select",
    value: string,
  ): Promise<void> {
    if (this.sensitiveActionTrackers.length >= MAXIMUM_SENSITIVE_ACTION_TARGETS) {
      throw this.sensitiveEvidenceFailure(
        "The sensitive action tracker limit was exceeded.",
      );
    }
    try {
      if (this.sensitiveActionTrackers.length > 0) {
        await this.failIfSensitiveTrackingOverflowed();
      }
      if (this.shadowRegistry === undefined) throw new Error("shadow-registry-unavailable");
      if (this.promiseIntrinsics === undefined || !this.promiseInitAttested) {
        throw new Error("promise-init-unattested");
      }
      await this.verifySensitiveShadowRoots();
      if (value.length > MAXIMUM_OBSERVATION_NODE_BYTES) {
        throw new Error("source-form-length-overflow");
      }
      if (new TextEncoder().encode(value).byteLength > MAXIMUM_OBSERVATION_NODE_BYTES) {
        throw new Error("source-form-byte-overflow");
      }
      const normalizedForms = await this.normalizeSensitiveValue(target, kind, value);
      const forms = [...new Set([value, ...normalizedForms].filter((form) => form !== ""))];
      const tracker = await target.evaluateHandle((element, input) => {
        const limits = input.limits;
        if (!element.isConnected) {
          throw new Error("target-disconnected");
        }
        const byteLength = (text: string): number => {
          if (text.length > limits.maximumNodeBytes) throw new Error("node-length-overflow");
          return new TextEncoder().encode(text).byteLength;
        };
        const boundedText = (candidate: Element): string => {
          const chunks: string[] = [];
          let bytes = 0;
          const roots: Node[] = [candidate];
          if (candidate.shadowRoot !== null) roots.push(candidate.shadowRoot);
          let elements = 0;
          for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
            const root = roots[rootIndex];
            if (root === undefined) throw new Error("text-root-unprovable");
            const walker = candidate.ownerDocument.createTreeWalker(
              root,
              NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
            );
            for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
              if (node instanceof CharacterData) {
                bytes += byteLength(node.data);
                if (bytes > limits.maximumNodeBytes) throw new Error("node-byte-overflow");
                chunks.push(node.data);
              } else if (node instanceof Element) {
                elements += 1;
                if (elements > limits.maximumDomElements) throw new Error("dom-element-overflow");
                if (node.shadowRoot !== null) {
                  roots.push(node.shadowRoot);
                  if (roots.length > limits.maximumShadowRoots + 1) {
                    throw new Error("shadow-root-overflow");
                  }
                }
              }
            }
          }
          return chunks.join("");
        };
        const snapshot = (candidate: Element): {
          readonly properties: SensitiveActionPropertySnapshot;
          readonly bytes: number;
        } => {
          const selectedOption = candidate instanceof HTMLSelectElement
            ? candidate.selectedOptions.item(0)
            : null;
          const properties: SensitiveActionPropertySnapshot = {
            inputValue: candidate instanceof HTMLInputElement ||
                candidate instanceof HTMLTextAreaElement
              ? candidate.value
              : null,
            selectValue: candidate instanceof HTMLSelectElement ? candidate.value : null,
            selectedOptionText: selectedOption?.text ?? null,
            textContent: boundedText(candidate),
            attributes: limits.attributes.map((name) => candidate.getAttribute(name)),
          };
          let bytes = 0;
          for (const property of [
            properties.inputValue,
            properties.selectValue,
            properties.selectedOptionText,
            properties.textContent,
            ...properties.attributes,
          ]) {
            if (property === null) continue;
            const propertyBytes = byteLength(property);
            if (propertyBytes > limits.maximumNodeBytes) throw new Error("node-byte-overflow");
            bytes += propertyBytes;
            if (bytes > limits.maximumNodeBytes) throw new Error("node-byte-overflow");
          }
          return { properties, bytes };
        };

        const forms = input.forms;

        const registry = input.shadowRegistry;
        const boundedCandidates = (): readonly Element[] => {
          const shadow = registry.snapshot(limits.maximumShadowRoots);
          if (!shadow.intact || shadow.overflow || shadow.count !== shadow.roots.length) {
            throw new Error("shadow-root-identity-unprovable");
          }
          const found: Element[] = [];
          let elements = 0;
          const roots: (Document | ShadowRoot)[] = [element.ownerDocument];
          for (const entry of shadow.roots) roots.push(entry.root);
          for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
            const root = roots[rootIndex];
            if (root === undefined) throw new Error("shadow-root-identity-unprovable");
            const walker = element.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
            for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
              if (!(node instanceof Element)) throw new Error("candidate-unprovable");
              elements += 1;
              if (elements > limits.maximumDomElements) throw new Error("dom-element-overflow");
              if (node.matches(limits.candidateSelector)) {
                found.push(node);
                if (found.length > limits.maximumCandidates) throw new Error("candidate-overflow");
              }
            }
          }
          if (new Set(roots).size !== roots.length || roots.length !== shadow.roots.length + 1 ||
              shadow.roots.some((entry) => !roots.includes(entry.root))) {
            throw new Error("shadow-root-identity-unprovable");
          }
          return found;
        };
        const candidateNodes = boundedCandidates();
        const candidates: SensitiveActionCandidateSnapshot[] = [];
        let snapshotBytes = 0;
        for (let index = 0; index < candidateNodes.length; index += 1) {
          const candidate = candidateNodes[index];
          if (candidate === undefined) throw new Error("candidate-unprovable");
          const captured = snapshot(candidate);
          snapshotBytes += captured.bytes;
          if (snapshotBytes > limits.maximumSnapshotBytes) throw new Error("snapshot-byte-overflow");
          candidates.push({ element: candidate, properties: captured.properties });
        }

        const records: SensitiveActionMutationRecord[] = [];
        const causalElements: Element[] = [];
        const tracker = {
          target: element,
          forms,
          candidates,
          records,
          causalElements,
          metadata: {
            baseline: undefined,
            hrefs: [],
            pathnames: [],
            queryKeys: [],
            queryValues: [],
            hashes: [],
            titles: [],
            unprovenUrl: false,
          },
          ambiguousEvent: false,
          overflow: false,
          observerError: false,
          schedulerActivationUnproven: false,
          schedulerProvenanceUnproven: false,
          scheduledPoison: false,
          scheduledRegistrations: 0,
          scheduledExecutions: 0,
          outstandingPromiseDelegations: 0,
          shadowPoison: false,
          closedMutationBaseline: 0,
          preparedElements: undefined,
          roots: [],
          shadowRegistry: registry,
        } as Omit<
          SensitiveActionMutationTracker,
          "observers" | "restore" | "promiseIntegrity" | "beginCausalAction" | "endCausalAction"
        > & {
          observers?: MutationObserver[];
          restore?: () => boolean;
          promiseIntegrity?: () => boolean;
          beginCausalAction?: (target: Element) => boolean;
          endCausalAction?: (target: Element) => boolean;
        };
        const appendRecords = (mutations: readonly MutationRecord[], causal: boolean): void => {
          try {
            if (records.length + mutations.length > limits.maximumMutations) {
              tracker.overflow = true;
              return;
            }
            for (const record of mutations) {
              if (record.addedNodes.length > limits.maximumCandidates ||
                  record.removedNodes.length > limits.maximumCandidates) {
                tracker.overflow = true;
                return;
              }
              records.push({ record, causal });
            }
          } catch {
            tracker.observerError = true;
          }
        };
        const observers: MutationObserver[] = [];
        tracker.observers = observers;
        const observeRoot = (root: Document | ShadowRoot): void => {
          if (tracker.roots.includes(root)) return;
          if (tracker.roots.length >= limits.maximumShadowRoots + 1) {
            tracker.shadowPoison = true;
            return;
          }
          tracker.roots.push(root);
          const observer = new MutationObserver((mutations) => appendRecords(mutations, false));
          observers.push(observer);
          observer.observe(root, {
            attributes: true,
            characterData: true,
            childList: true,
            subtree: true,
          });
        };
        observeRoot(element.ownerDocument);
        for (const entry of registry.snapshot(limits.maximumShadowRoots).roots) {
          observeRoot(entry.root);
        }

        const values = (properties: SensitiveActionPropertySnapshot): readonly (string | null)[] => [
          properties.inputValue,
          properties.selectValue,
          properties.selectedOptionText,
          properties.textContent,
          ...properties.attributes,
        ];
        const containsForm = (property: string | null): boolean =>
          property !== null && forms.some((form) => property.includes(form));
        const capture = (): readonly SensitiveActionCandidateSnapshot[] => {
          const nodes = boundedCandidates();
          const captured: SensitiveActionCandidateSnapshot[] = [];
          let bytes = 0;
          for (let index = 0; index < nodes.length; index += 1) {
            const candidate = nodes[index];
            if (candidate === undefined) throw new Error("candidate-unprovable");
            const item = snapshot(candidate);
            bytes += item.bytes;
            if (bytes > limits.maximumSnapshotBytes) throw new Error("snapshot-byte-overflow");
            captured.push({ element: candidate, properties: item.properties });
          }
          return captured;
        };
        const finishCausalScope = (before: readonly SensitiveActionCandidateSnapshot[]): void => {
          try {
            for (const observer of observers) appendRecords(observer.takeRecords(), true);
            const after = capture();
            const totalCandidates = before.length + after.filter((candidate) =>
              !before.some((prior) => prior.element === candidate.element)).length;
            if (totalCandidates > limits.maximumCandidates) {
              tracker.overflow = true;
              return;
            }
            for (const candidate of after) {
              const prior = before.find((item) => item.element === candidate.element);
              const priorValues = prior === undefined ? [] : values(prior.properties);
              if (values(candidate.properties).some((property, index) =>
                property !== priorValues[index] && containsForm(property)) &&
                  !causalElements.includes(candidate.element)) {
                if (causalElements.length >= limits.maximumTargets) {
                  tracker.overflow = true;
                  return;
                }
                causalElements.push(candidate.element);
              }
            }
          } catch {
            tracker.observerError = true;
          }
        };

        const eventType = input.kind === "select" ? "change" : "input";
        const promiseSnapshot = input.promiseIntrinsics.snapshot();
        if (!promiseSnapshot.intact) {
          tracker.schedulerActivationUnproven = true;
          tracker.schedulerProvenanceUnproven = true;
        }
        const originalSetTimeout = window.setTimeout;
        const originalSetInterval = window.setInterval;
        const originalClearInterval = window.clearInterval;
        const originalRequestAnimationFrame = window.requestAnimationFrame;
        const originalCancelAnimationFrame = window.cancelAnimationFrame;
        const originalQueueMicrotask = window.queueMicrotask;
        const originalThen = promiseSnapshot.then;
        const metadataSnapshot = (): SensitivePageMetadataSnapshot => ({
          href: location.href,
          pathname: location.pathname,
          decodedPathname: (() => {
            try { return decodeURIComponent(location.pathname); } catch { return location.pathname; }
          })(),
          query: [...new URLSearchParams(location.search).entries()].map(([key, value]) => ({ key, value })),
          hash: location.hash,
          decodedHash: (() => {
            try { return decodeURIComponent(location.hash); } catch { return location.hash; }
          })(),
          title: document.title,
        });
        const containsSensitiveForm = (text: string): boolean =>
          forms.some((form) => text.includes(form));
        const rememberMetadata = (
          before: SensitivePageMetadataSnapshot,
          after: SensitivePageMetadataSnapshot,
        ): void => {
          const remember = (values: string[], value: string): void => {
            if (!values.includes(value)) values.push(value);
          };
          if (before.href !== after.href && containsSensitiveForm(after.href)) {
            remember(tracker.metadata.hrefs, after.href);
          }
          if (before.pathname !== after.pathname &&
              (containsSensitiveForm(after.pathname) || containsSensitiveForm(after.decodedPathname))) {
            remember(tracker.metadata.pathnames, after.pathname);
          }
          for (let index = 0; index < after.query.length; index += 1) {
            const current = after.query[index];
            const prior = before.query[index];
            if (current === undefined) continue;
            if (current.key !== prior?.key && containsSensitiveForm(current.key)) {
              remember(tracker.metadata.queryKeys, current.key);
            }
            if (current.value !== prior?.value && containsSensitiveForm(current.value)) {
              remember(tracker.metadata.queryValues, current.value);
            }
          }
          if (before.hash !== after.hash &&
              (containsSensitiveForm(after.hash) || containsSensitiveForm(after.decodedHash))) {
            remember(tracker.metadata.hashes, after.hash);
          }
          if (before.title !== after.title && containsSensitiveForm(after.title)) {
            remember(tracker.metadata.titles, after.title);
          }
        };
        interface GenerationToken {
          readonly id: number;
          readonly deadline: number;
          remainingCallbacks: number;
        }
        let nextGeneration = 0;
        let scheduledRegistrations = 0;
        let activeGeneration: GenerationToken | undefined;
        let callbackGeneration: GenerationToken | undefined;
        const attachedShadow = (_host: Element, root: ShadowRoot, mode: ShadowRootMode): void => {
          observeRoot(root);
        };
        if (!registry.subscribe(attachedShadow)) tracker.shadowPoison = true;
        let eventSnapshot: readonly SensitiveActionCandidateSnapshot[] | undefined;
        let eventMetadata: SensitivePageMetadataSnapshot | undefined;
        const finishExactTargetEvent = (): void => {
          if (eventSnapshot === undefined) return;
          const before = eventSnapshot;
          const beforeMetadata = eventMetadata;
          eventSnapshot = undefined;
          eventMetadata = undefined;
          finishCausalScope(before);
          if (beforeMetadata !== undefined) rememberMetadata(beforeMetadata, metadataSnapshot());
        };
        const exactTargetEvent = (event: Event): void => {
          if (event.target !== element) {
            try {
              const target = event.target;
              if (target instanceof Element) {
                const candidate = snapshot(target);
                if (values(candidate.properties).some(containsForm)) tracker.ambiguousEvent = true;
              }
            } catch {
              tracker.observerError = true;
            }
            return;
          }
          try {
            eventSnapshot = capture();
            eventMetadata = metadataSnapshot();
          } catch {
            tracker.observerError = true;
          }
          if (activeGeneration === undefined && callbackGeneration === undefined) {
            tracker.observerError = true;
          }
        };
        window.addEventListener(eventType, exactTargetEvent, true);

        const runCausal = <T>(token: GenerationToken, callback: () => T): T => {
          tracker.scheduledExecutions += 1;
          if (Date.now() > token.deadline || token.remainingCallbacks <= 0) {
            tracker.scheduledPoison = true;
            return callback();
          }
          let before: readonly SensitiveActionCandidateSnapshot[];
          try {
            before = capture();
          } catch {
            tracker.observerError = true;
            return callback();
          }
          token.remainingCallbacks -= 1;
          const priorGeneration = callbackGeneration;
          callbackGeneration = token;
          const beforeMetadata = metadataSnapshot();
          try {
            return callback();
          } finally {
            callbackGeneration = priorGeneration;
            finishCausalScope(before);
            rememberMetadata(beforeMetadata, metadataSnapshot());
          }
        };
        const generationForSchedule = (): GenerationToken | undefined =>
          callbackGeneration ?? activeGeneration;
        const registerGeneration = (): GenerationToken | undefined => {
          const generation = generationForSchedule();
          if (generation === undefined) return undefined;
          scheduledRegistrations += 1;
          tracker.scheduledRegistrations = scheduledRegistrations;
          if (scheduledRegistrations > limits.maximumScheduledCallbacks) {
            tracker.scheduledPoison = true;
            return undefined;
          }
          return generation;
        };
        const wrappedSetTimeout = ((
          handler: TimerHandler,
          timeout?: number,
          ...args: unknown[]
        ): number => {
          const generation = registerGeneration();
          if (typeof handler !== "function") {
            return originalSetTimeout(handler, timeout, ...args);
          }
          if (generation === undefined) {
            return originalSetTimeout(handler, timeout, ...args);
          }
          return Number(originalSetTimeout.call(window, () => {
            runCausal(generation, () => handler(...args));
          }, timeout));
        }) as typeof window.setTimeout;
        const wrappedQueueMicrotask = (callback: VoidFunction): void => {
          const generation = registerGeneration();
          if (generation === undefined) {
            originalQueueMicrotask.call(window, callback);
          } else {
            originalQueueMicrotask.call(window, () => runCausal(generation, callback));
          }
        };
        const wrappedSetInterval = ((
          handler: TimerHandler,
          timeout?: number,
          ...args: unknown[]
        ): number => {
          const generation = registerGeneration();
          if (typeof handler !== "function") {
            return originalSetInterval(handler, timeout, ...args);
          }
          if (generation === undefined) {
            return originalSetInterval(handler, timeout, ...args);
          }
          return Number(originalSetInterval.call(window, () => {
            runCausal(generation, () => handler(...args));
          }, timeout));
        }) as typeof window.setInterval;
        const wrappedClearInterval = ((id?: number): void => {
          originalClearInterval.call(window, id);
        }) as typeof window.clearInterval;
        const wrappedRequestAnimationFrame = ((callback: FrameRequestCallback): number => {
          const generation = registerGeneration();
          if (generation === undefined) {
            return originalRequestAnimationFrame.call(window, callback);
          }
          return originalRequestAnimationFrame.call(window, (time) =>
            runCausal(generation, () => callback(time)));
        }) as typeof window.requestAnimationFrame;
        const wrappedCancelAnimationFrame = ((id: number): void => {
          originalCancelAnimationFrame.call(window, id);
        }) as typeof window.cancelAnimationFrame;
        const wrapContinuation = <T, TResult>(
          generation: GenerationToken | undefined,
          callback: ((value: T) => TResult | PromiseLike<TResult>) | null | undefined,
        ): typeof callback => generation === undefined || callback == null
          ? callback
          : ((value: T) => runCausal(generation, () => callback(value)));
        const promiseTokens = new Set<PrivatePromiseDelegationToken>();
        const promiseTokenParents = new Map<PrivatePromiseDelegationToken, PrivatePromiseDelegationToken>();
        const deferredPromiseTokens = new Set<PrivatePromiseDelegationToken>();
        const expectedPromiseReceivers = new WeakSet<object>();
        const promiseHook: PrivatePromiseBoundaryHook = {
          custom(receiver) {
            if ((typeof receiver !== "object" && typeof receiver !== "function") ||
                receiver === null) {
              tracker.schedulerProvenanceUnproven = true;
              return [];
            }
            const expected = expectedPromiseReceivers.delete(receiver);
            if (!expected && generationForSchedule() === undefined) return [];
            if (promiseTokens.size >= limits.maximumScheduledCallbacks) {
              tracker.schedulerProvenanceUnproven = true;
              return [];
            }
            const token: PrivatePromiseDelegationToken = { delegated: false, settled: false };
            promiseTokens.add(token);
            tracker.outstandingPromiseDelegations = promiseTokens.size;
            return [token];
          },
          child(parents) {
            const children: PrivatePromiseDelegationToken[] = [];
            for (const parent of parents) {
              if (!promiseTokens.has(parent) || parent.delegated || deferredPromiseTokens.has(parent)) continue;
              const child: PrivatePromiseDelegationToken = { delegated: false, settled: false };
              promiseTokenParents.set(child, parent);
              deferredPromiseTokens.add(parent);
              children.push(child);
            }
            return children;
          },
          wrap(_receiver, onfulfilled, onrejected, associated) {
            for (const token of associated) token.delegated = true;
            const generation = registerGeneration();
            const wrapResult = (callback: unknown): unknown => {
              if (generation === undefined || typeof callback !== "function") return callback;
              return (value: unknown): unknown => runCausal(generation, () => {
                const result = callback(value);
                if ((typeof result === "object" || typeof result === "function") && result !== null) {
                  promiseHook.returned(result);
                }
                return result;
              });
            };
            return [
              wrapResult(onfulfilled),
              wrapResult(onrejected),
            ];
          },
          settle(tokens) {
            const finish = (token: PrivatePromiseDelegationToken): void => {
              token.settled = true;
              if (deferredPromiseTokens.has(token)) return;
              if (!token.delegated) tracker.schedulerProvenanceUnproven = true;
              promiseTokens.delete(token);
              const parent = promiseTokenParents.get(token);
              if (parent !== undefined) {
                promiseTokenParents.delete(token);
                deferredPromiseTokens.delete(parent);
                parent.delegated = token.delegated;
                finish(parent);
              }
            };
            for (const token of tokens) {
              finish(token);
            }
            tracker.outstandingPromiseDelegations = promiseTokens.size;
            if (!input.promiseIntrinsics.revalidateOwners()) {
              tracker.schedulerProvenanceUnproven = true;
            }
          },
          returned(receiver) {
            if (!input.promiseIntrinsics.observe(receiver)) {
              tracker.schedulerProvenanceUnproven = true;
            }
            expectedPromiseReceivers.add(receiver);
          },
        };
        if (!input.promiseIntrinsics.subscribe(promiseHook)) {
          tracker.schedulerActivationUnproven = true;
          tracker.schedulerProvenanceUnproven = true;
        }
        window.setTimeout = wrappedSetTimeout;
        window.setInterval = wrappedSetInterval;
        window.clearInterval = wrappedClearInterval;
        window.requestAnimationFrame = wrappedRequestAnimationFrame;
        window.cancelAnimationFrame = wrappedCancelAnimationFrame;
        window.queueMicrotask = wrappedQueueMicrotask;
        const originalReplaceState = history.replaceState;
        const originalPushState = history.pushState;
        const wrapHistory = (original: History["replaceState"]): History["replaceState"] =>
          function (data: unknown, unused: string, url?: string | URL | null): void {
            const causal = activeGeneration !== undefined || callbackGeneration !== undefined;
            original.call(history, data, unused, url);
            const after = metadataSnapshot();
            if (causal) rememberMetadata(tracker.metadata.baseline ?? after, after);
            else if (containsSensitiveForm(after.href)) tracker.metadata.unprovenUrl = true;
          };
        const wrappedReplaceState = wrapHistory(originalReplaceState);
        const wrappedPushState = wrapHistory(originalPushState);
        history.replaceState = wrappedReplaceState;
        history.pushState = wrappedPushState;
        tracker.beginCausalAction = (target): boolean => {
          if (target !== element || activeGeneration !== undefined) return false;
          try {
            tracker.metadata.baseline = metadataSnapshot();
            activeGeneration = {
              id: nextGeneration += 1,
              deadline: Date.now() + limits.maximumScheduledMs,
              remainingCallbacks: limits.maximumScheduledCallbacks,
            };
            scheduledRegistrations = 0;
            tracker.closedMutationBaseline = registry.snapshot(
              limits.maximumShadowRoots,
            ).closedMutationCount;
            return true;
          } catch {
            tracker.observerError = true;
            return false;
          }
        };
        tracker.endCausalAction = (target): boolean => {
          if (target !== element || activeGeneration === undefined) {
            tracker.observerError = true;
            return false;
          }
          activeGeneration = undefined;
          try {
            finishExactTargetEvent();
            finishCausalScope(tracker.candidates);
            if (!registry.snapshot(limits.maximumShadowRoots).intact) tracker.shadowPoison = true;
          } catch {
            tracker.observerError = true;
          }
          return !tracker.observerError && !tracker.overflow && !tracker.shadowPoison;
        };
        tracker.promiseIntegrity = (): boolean => {
          const current = input.promiseIntrinsics.snapshot();
          return current.intact && current.descriptorShapeIntact;
        };
        tracker.restore = (): boolean => {
          window.removeEventListener(eventType, exactTargetEvent, true);
          const registryIntact = registry.unsubscribe(attachedShadow);
          const promiseIntact = input.promiseIntrinsics.unsubscribe(promiseHook);
          if ([...promiseTokens].some((token) => !token.delegated)) {
            tracker.schedulerProvenanceUnproven = true;
          }
          promiseTokens.clear();
          promiseTokenParents.clear();
          deferredPromiseTokens.clear();
          tracker.outstandingPromiseDelegations = 0;
          const intact = window.setTimeout === wrappedSetTimeout &&
            window.setInterval === wrappedSetInterval &&
            window.clearInterval === wrappedClearInterval &&
            window.requestAnimationFrame === wrappedRequestAnimationFrame &&
            window.cancelAnimationFrame === wrappedCancelAnimationFrame &&
            window.queueMicrotask === wrappedQueueMicrotask &&
            tracker.promiseIntegrity?.() === true && promiseIntact &&
            history.replaceState === wrappedReplaceState &&
            history.pushState === wrappedPushState && registryIntact;
          if (window.setTimeout === wrappedSetTimeout) window.setTimeout = originalSetTimeout;
          if (window.setInterval === wrappedSetInterval) window.setInterval = originalSetInterval;
          if (window.clearInterval === wrappedClearInterval) window.clearInterval = originalClearInterval;
          if (window.requestAnimationFrame === wrappedRequestAnimationFrame) {
            window.requestAnimationFrame = originalRequestAnimationFrame;
          }
          if (window.cancelAnimationFrame === wrappedCancelAnimationFrame) {
            window.cancelAnimationFrame = originalCancelAnimationFrame;
          }
          if (window.queueMicrotask === wrappedQueueMicrotask) {
            window.queueMicrotask = originalQueueMicrotask;
          }
          if (history.replaceState === wrappedReplaceState) history.replaceState = originalReplaceState;
          if (history.pushState === wrappedPushState) history.pushState = originalPushState;
          for (const observer of observers) observer.disconnect();
          return intact;
        };
        return tracker as SensitiveActionMutationTracker;
      }, {
        kind,
        forms,
        shadowRegistry: this.shadowRegistry,
        promiseIntrinsics: this.promiseIntrinsics,
        hasPriorTracker: this.sensitiveActionTrackers.length > 0,
        limits: {
          maximumCandidates: this.observationCandidateLimit(),
          maximumMutations: MAXIMUM_SENSITIVE_ACTION_MUTATIONS,
          maximumTargets: MAXIMUM_SENSITIVE_ACTION_TARGETS,
          maximumNodeBytes: MAXIMUM_OBSERVATION_NODE_BYTES,
          maximumSnapshotBytes: MAXIMUM_OBSERVATION_SNAPSHOT_BYTES,
          maximumScheduledCallbacks: MAXIMUM_SENSITIVE_SCHEDULED_CALLBACKS,
          maximumScheduledMs: this.options.actionTimeoutMs,
          maximumShadowRoots: MAXIMUM_SENSITIVE_SHADOW_ROOTS,
          maximumDomElements: MAXIMUM_SENSITIVE_DOM_ELEMENTS,
          candidateSelector: SENSITIVE_ACTION_CANDIDATE_SELECTOR,
          attributes: SENSITIVE_ACTION_ATTRIBUTES,
        },
      });
      this.sensitiveActionTrackers.push(tracker);
    } catch {
      throw this.sensitiveEvidenceFailure();
    }
  }

  async beginCausalAction(target: ElementHandle<Element>): Promise<void> {
    const tracker = this.sensitiveActionTrackers.at(-1);
    if (tracker === undefined) throw this.sensitiveEvidenceFailure();
    const started = await tracker.evaluate(
      (state, exactTarget) => state.beginCausalAction(exactTarget),
      target,
    ).catch(() => false);
    if (!started) throw this.sensitiveEvidenceFailure();
  }

  async endCausalAction(target: ElementHandle<Element>): Promise<void> {
    const tracker = this.sensitiveActionTrackers.at(-1);
    if (tracker === undefined) throw this.sensitiveEvidenceFailure();
    const ended = await tracker.evaluate(
      (state, exactTarget) => state.endCausalAction(exactTarget),
      target,
    ).catch(() => false);
    if (!ended) throw this.sensitiveEvidenceFailure();
  }

  private async normalizeSensitiveValue(
    target: ElementHandle<Element>,
    kind: "input" | "select",
    value: string,
  ): Promise<readonly string[]> {
    if (this.context === undefined) throw new Error("browser-context-unavailable");
    const control = await target.evaluate((element, input) => {
      if (input.actionKind === "select" && element instanceof HTMLSelectElement) {
        if (element.options.length > input.maximumOptions) {
          throw new Error("normalization-option-overflow");
        }
        const options: { readonly value: string; readonly label: string; readonly text: string }[] = [];
        let totalChars = 0;
        for (let index = 0; index < element.options.length; index += 1) {
          const option = element.options.item(index);
          if (option === null) throw new Error("normalization-option-unprovable");
          const valueLength = option.value.length;
          const labelLength = option.label.length;
          const textLength = (option.textContent ?? "").length;
          for (const length of [valueLength, labelLength, textLength]) {
            if (length > input.maximumCharsPerValue) {
              throw new Error("normalization-option-length-overflow");
            }
            totalChars += length;
            if (totalChars > input.maximumTotalChars) {
              throw new Error("normalization-option-total-overflow");
            }
          }
          options.push({
            value: option.value.slice(0, input.maximumCharsPerValue),
            label: option.label.slice(0, input.maximumCharsPerValue),
            text: (option.textContent ?? "").slice(0, input.maximumCharsPerValue),
          });
        }
        return { tag: "select" as const, options };
      }
      if (input.actionKind === "input" && element instanceof HTMLInputElement) {
        return { tag: "input" as const, type: element.type };
      }
      if (input.actionKind === "input" && element instanceof HTMLTextAreaElement) {
        return { tag: "textarea" as const };
      }
      throw new Error("normalization-target-unprovable");
    }, {
      actionKind: kind,
      maximumOptions: MAXIMUM_SENSITIVE_ACTION_CANDIDATES,
      maximumCharsPerValue: MAXIMUM_OBSERVATION_NODE_BYTES,
      maximumTotalChars: MAXIMUM_OBSERVATION_SNAPSHOT_BYTES,
    });
    const normalizationPage = await this.context.newPage();
    try {
      await normalizationPage.setContent("<!doctype html><html><body></body></html>");
      const handle = await normalizationPage.evaluateHandle((descriptor) => {
        let element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
        if (descriptor.tag === "select") {
          element = document.createElement("select");
          for (const source of descriptor.options) {
            const option = document.createElement("option");
            option.value = source.value;
            option.label = source.label;
            option.textContent = source.text;
            element.append(option);
          }
        } else if (descriptor.tag === "textarea") {
          element = document.createElement("textarea");
        } else {
          element = document.createElement("input");
          element.type = descriptor.type;
        }
        document.body.append(element);
        return element;
      }, control);
      const element = handle.asElement();
      if (element === null) throw new Error("normalization-control-unprovable");
      try {
        if (kind === "select") await element.selectOption(value);
        else await element.fill(value);
        const normalized = await normalizationPage.evaluate((input): string[] => {
          const candidate = input.candidate;
          const actionKind = input.actionKind;
          if (actionKind === "select" && candidate instanceof HTMLSelectElement) {
            const selected = candidate.selectedOptions.item(0);
            if (selected === null) throw new Error("normalized-selection-unprovable");
            const forms = [selected.value, selected.label, selected.textContent ?? ""];
            let totalChars = 0;
            for (const form of forms) {
              if (form.length > input.maximumCharsPerValue) {
                throw new Error("normalized-form-length-overflow");
              }
              totalChars += form.length;
              if (totalChars > input.maximumTotalChars) {
                throw new Error("normalized-form-total-overflow");
              }
            }
            return forms.map((form) => form.slice(0, input.maximumCharsPerValue));
          }
          if (actionKind === "input" &&
              (candidate instanceof HTMLInputElement || candidate instanceof HTMLTextAreaElement)) {
            if (candidate.value.length > input.maximumCharsPerValue) {
              throw new Error("normalized-form-length-overflow");
            }
            return [candidate.value.slice(0, input.maximumCharsPerValue)];
          }
          throw new Error("normalized-value-unprovable");
        }, {
          candidate: element,
          actionKind: kind,
          maximumCharsPerValue: MAXIMUM_OBSERVATION_NODE_BYTES,
          maximumTotalChars: MAXIMUM_OBSERVATION_SNAPSHOT_BYTES,
        });
        const forms = [...new Set(normalized.filter((form) => form !== ""))];
        let bytes = 0;
        for (const form of forms) {
          if (form.length > MAXIMUM_OBSERVATION_NODE_BYTES) {
            throw new Error("normalized-form-length-overflow");
          }
          const formBytes = new TextEncoder().encode(form).byteLength;
          if (formBytes > MAXIMUM_OBSERVATION_NODE_BYTES) {
            throw new Error("normalized-form-overflow");
          }
          bytes += formBytes;
        }
        if (bytes > MAXIMUM_OBSERVATION_SNAPSHOT_BYTES) {
          throw new Error("normalized-form-overflow");
        }
        return forms;
      } finally {
        await element.dispose();
      }
    } finally {
      await normalizationPage.close();
    }
  }

  async prepareSensitiveEvidenceCapture(): Promise<void> {
    await this.failIfSensitiveTrackingOverflowed();
    if (this.sensitiveActionTrackers.length > 0) await this.verifySensitiveShadowRoots();
    for (const tracker of this.sensitiveActionTrackers) {
      const handles = await this.reconcileSensitiveActionTracking(tracker, false);
      if (handles === undefined) throw new Error("unexpected-preparation-race");
      try {
        await this.retainSensitiveElements(handles);
      } catch {
        throw this.sensitiveEvidenceFailure("Sensitive reflected targets could not be retained.");
      }
    }
  }

  async verifySensitiveShadowRoots(): Promise<void> {
    if (this.page === undefined || this.shadowRegistry === undefined) {
      throw this.sensitiveEvidenceFailure();
    }
    try {
      const frames = this.page.frames();
      if (frames.length > MAXIMUM_SENSITIVE_SHADOW_ROOTS + 1) {
        throw new Error("frame-overflow");
      }
      let registeredCount = 0;
      for (const frame of frames) {
        const boundedElements = await frame.evaluate((maximumElements) => {
          const walker = document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT);
          let count = 0;
          while (walker.nextNode() !== null) {
            count += 1;
            if (count > maximumElements) return false;
          }
          return true;
        }, MAXIMUM_SENSITIVE_DOM_ELEMENTS);
        if (!boundedElements) throw new Error("dom-element-overflow");
        const realmRoots = await frame.evaluate(({ registryKey, accessToken, maximumRoots }) => {
          const gateway = (globalThis as typeof globalThis & Record<symbol, unknown>)[
            Symbol.for(registryKey)
          ] as { access(candidate: string): PrivateShadowRegistry | undefined } | undefined;
          const snapshot = gateway?.access(accessToken)?.snapshot(maximumRoots);
          return snapshot === undefined || !snapshot.intact || snapshot.overflow ||
            snapshot.count !== snapshot.roots.length ? -1 : snapshot.count;
        }, {
          registryKey: this.shadowRegistryKey,
          accessToken: this.shadowRegistryAccessToken,
          maximumRoots: MAXIMUM_SENSITIVE_SHADOW_ROOTS,
        });
        if (realmRoots < 0 || registeredCount + realmRoots > MAXIMUM_SENSITIVE_SHADOW_ROOTS) {
          throw new Error("cross-realm-shadow-root-unproven");
        }
        registeredCount += realmRoots;
      }
      const session = await this.page.context().newCDPSession(this.page);
      const cdp = createBoundedCdpSession({
        getDocument: () => session.send("DOM.getDocument", { depth: 0, pierce: true }),
        describeNode: (reference) => session.send("DOM.describeNode", {
          ...reference,
          depth: 1,
          pierce: false,
        }),
        resolveNode: (backendNodeId) => session.send("DOM.resolveNode", {
          backendNodeId,
          objectGroup: "qualigence-shadow-proof",
        }),
        callFunctionOn: (objectId, functionDeclaration, args) =>
          session.send("Runtime.callFunctionOn", {
            objectId,
            functionDeclaration,
            arguments: args.map((value) => ({ value })),
            returnByValue: true,
          }),
        releaseObjectGroup: () => session.send("Runtime.releaseObjectGroup", {
          objectGroup: "qualigence-shadow-proof",
        }),
      }, MAXIMUM_SENSITIVE_DOM_ELEMENTS);
      try {
        const inventory = await inventoryPiercedDom(
          cdp,
          {
            maximumNodes: MAXIMUM_SENSITIVE_DOM_ELEMENTS,
            maximumShadowRoots: MAXIMUM_SENSITIVE_SHADOW_ROOTS,
            maximumFrames: MAXIMUM_SENSITIVE_SHADOW_ROOTS,
          },
        );
        if (inventory.shadowRootCount !== registeredCount) {
          throw new Error("shadow-root-identity-unproven");
        }
        for (const host of inventory.shadowHosts) {
          const objectId = await cdp.resolveNode(host.backendNodeId);
          const matched = await cdp.callFunctionOnBoolean(
            objectId,
            `function(registryKey, accessToken, maximumRoots, mode) {
              const gateway = globalThis[Symbol.for(registryKey)];
              const snapshot = gateway?.access(accessToken)?.snapshot(maximumRoots);
              return snapshot?.hosts.some((entry) => entry.host === this && entry.mode === mode) === true;
            }`,
            [
              this.shadowRegistryKey,
              this.shadowRegistryAccessToken,
              MAXIMUM_SENSITIVE_SHADOW_ROOTS,
              host.mode,
            ],
          );
          if (!matched) {
            throw new Error("shadow-host-registry-mismatch");
          }
        }
      } finally {
        await cdp.releaseObjectGroup().catch(() => undefined);
        await session.detach();
      }
    } catch {
      this.reportSensitiveEvidenceDiagnostic("ShadowIntegrityUnproven");
      throw this.sensitiveEvidenceFailure();
    }
  }

  async completeSensitiveEvidenceCapture(): Promise<boolean> {
    for (const tracker of this.sensitiveActionTrackers) {
      if (await this.reconcileSensitiveActionTracking(tracker, true) === undefined) return false;
    }
    return true;
  }

  reportSensitiveEvidenceChangedDuringCapture(): void {
    this.reportSensitiveEvidenceDiagnostic("EvidenceChangedDuringCapture");
  }

  sensitiveEvidenceChangedDuringCapture(): WebTargetError {
    return this.sensitiveEvidenceFailure();
  }

  async failIfSensitiveTrackingOverflowed(): Promise<void> {
    if (this.sensitiveActionTrackers.length === 0) return;
    if (this.promiseIntrinsics === undefined || !this.promiseInitAttested) {
      this.reportSensitiveEvidenceDiagnostic("PromiseAuthorityUnavailable");
      throw this.sensitiveEvidenceFailure();
    }
    const promiseReason = await this.promiseIntrinsics.evaluate((authority) => {
      const snapshot = authority.snapshot();
      if (!authority.revalidateOwners()) return "PromiseOwnerIntegrityUnproven" as const;
      if (!snapshot.intact || !snapshot.descriptorShapeIntact) {
        return "PromiseIntegrityUnproven" as const;
      }
      return undefined;
    }).catch(() => "PromiseAuthorityUnavailable" as const);
    if (promiseReason === "PromiseAuthorityUnavailable") {
      this.reportSensitiveEvidenceDiagnostic("PromiseAuthorityUnavailable");
      throw this.sensitiveEvidenceFailure();
    }
    if (promiseReason === "PromiseOwnerIntegrityUnproven") {
      this.reportSensitiveEvidenceDiagnostic("PromiseOwnerIntegrityUnproven");
      throw this.sensitiveEvidenceFailure();
    }
    if (promiseReason === "PromiseIntegrityUnproven") {
      this.reportSensitiveEvidenceDiagnostic("PromiseIntegrityUnproven");
      throw this.sensitiveEvidenceFailure();
    }
    for (const [index, tracker] of this.sensitiveActionTrackers.entries()) {
      const requireCurrentPromiseIntegrity = index === this.sensitiveActionTrackers.length - 1;
      const reason = await tracker.evaluate((state, requireIntegrity) => {
        if (state.overflow) return "TrackerOverflow" as const;
        if (state.observerError) return "TrackerObserverUnproven" as const;
        if (state.scheduledPoison) return "ScheduledCallbackBoundsExceeded" as const;
        if (state.schedulerProvenanceUnproven) return "SchedulerProvenanceUnproven" as const;
        if (state.outstandingPromiseDelegations > 0) return "PromiseDelegationUnsettled" as const;
        if (requireIntegrity && !state.promiseIntegrity()) return "PromiseIntegrityUnproven" as const;
        if (state.shadowPoison) return "ShadowIntegrityUnproven" as const;
        if (state.ambiguousEvent) return "SensitiveEventAmbiguous" as const;
        return undefined;
      },
      requireCurrentPromiseIntegrity).catch(() => "TrackerObserverUnproven" as const);
      if (reason !== undefined) {
        this.reportSensitiveEvidenceDiagnostic(reason);
        throw this.sensitiveEvidenceFailure(
          "Sensitive action provenance tracking exceeded its bounds.",
        );
      }
    }
  }

  /** Internal test evidence for the bounded page scheduler tracker. */
  async sensitiveSchedulerCounts(): Promise<{
    readonly registrations: number;
    readonly executions: number;
  }> {
    let registrations = 0;
    let executions = 0;
    for (const tracker of this.sensitiveActionTrackers) {
      const counts = await tracker.evaluate((state) => ({
        registrations: state.scheduledRegistrations,
        executions: state.scheduledExecutions,
      }));
      registrations += counts.registrations;
      executions += counts.executions;
    }
    return { registrations, executions };
  }

  async abandonSensitiveActionTracking(): Promise<void> {
    for (const tracker of this.sensitiveActionTrackers.splice(0).reverse()) {
      await this.disposeSensitiveActionTracker(tracker, true);
    }
  }

  async redactSensitivePageMetadata(
    href: string,
    title: string,
  ): Promise<{ readonly url: string; readonly title: string }> {
    if (this.sensitiveActionTrackers.length === 0) return { url: href, title };
    const parsed = new URL(href);
    const query = [...parsed.searchParams.entries()];
    let decodedPathname = parsed.pathname;
    let decodedHash = parsed.hash;
    try { decodedPathname = decodeURIComponent(parsed.pathname); } catch { /* fail below if sensitive */ }
    try { decodedHash = decodeURIComponent(parsed.hash); } catch { /* fail below if sensitive */ }
    const redaction: SensitivePageRedaction = {
      pathname: false,
      queryKeys: [],
      queryValues: [],
      hash: false,
      title: false,
    };
    let sensitiveOccurrence = false;
    for (const tracker of this.sensitiveActionTrackers) {
      const result = await tracker.evaluate((state, current) => {
        const contains = (value: string): boolean =>
          state.forms.some((form) => value.includes(form));
        const authorized = (values: readonly string[], value: string): boolean => values.includes(value);
        const baseline = state.metadata.baseline;
        if (baseline === undefined) {
          return {
            occurrence: true,
            unproven: true,
            pathname: false,
            hash: false,
            title: false,
            queryKeyIndexes: [] as number[],
            queryValueIndexes: [] as number[],
          };
        }
        const pathnameSensitive = current.pathname !== baseline.pathname &&
          (contains(current.pathname) || contains(current.decodedPathname));
        const hashSensitive = current.hash !== baseline.hash &&
          (contains(current.hash) || contains(current.decodedHash));
        const titleSensitive = current.title !== baseline.title && contains(current.title);
        const queryKeyIndexes: number[] = [];
        const queryValueIndexes: number[] = [];
        let occurrence = pathnameSensitive || hashSensitive || titleSensitive;
        let unproven = state.metadata.unprovenUrl;
        if (pathnameSensitive) unproven ||= !authorized(state.metadata.pathnames, current.pathname);
        if (hashSensitive) unproven ||= !authorized(state.metadata.hashes, current.hash);
        if (titleSensitive) unproven ||= !authorized(state.metadata.titles, current.title);
        for (let index = 0; index < current.query.length; index += 1) {
          const item = current.query[index];
          const baselineItem = baseline.query[index];
          if (item === undefined) continue;
          if (item.key !== baselineItem?.key && contains(item.key)) {
            occurrence = true;
            queryKeyIndexes.push(index);
            unproven ||= !authorized(state.metadata.queryKeys, item.key);
          }
          if (item.value !== baselineItem?.value && contains(item.value)) {
            occurrence = true;
            queryValueIndexes.push(index);
            unproven ||= !authorized(state.metadata.queryValues, item.value);
          }
        }
        const knownField = pathnameSensitive || hashSensitive || titleSensitive ||
          queryKeyIndexes.length > 0 || queryValueIndexes.length > 0;
        if (current.href !== baseline.href && contains(current.href) && !knownField) unproven = true;
        return {
          occurrence,
          unproven,
          pathname: pathnameSensitive,
          hash: hashSensitive,
          title: titleSensitive,
          queryKeyIndexes,
          queryValueIndexes,
        };
      }, {
        href,
        pathname: parsed.pathname,
        decodedPathname,
        query: query.map(([key, value]) => ({ key, value })),
        hash: parsed.hash,
        decodedHash,
        title,
      }).catch(() => ({
        occurrence: true,
        unproven: true,
        pathname: false,
        hash: false,
        title: false,
        queryKeyIndexes: [] as number[],
        queryValueIndexes: [] as number[],
      }));
      sensitiveOccurrence ||= result.occurrence;
      if (result.unproven) {
        throw this.sensitiveEvidenceFailure("Sensitive page URL or title provenance is unproven.");
      }
      redaction.pathname ||= result.pathname;
      redaction.hash ||= result.hash;
      redaction.title ||= result.title;
      for (const index of result.queryKeyIndexes) {
        if (!redaction.queryKeys.includes(index)) redaction.queryKeys.push(index);
      }
      for (const index of result.queryValueIndexes) {
        if (!redaction.queryValues.includes(index)) redaction.queryValues.push(index);
      }
    }
    if (!sensitiveOccurrence) return { url: href, title };
    if (redaction.pathname) parsed.pathname = "/[REDACTED]";
    if (redaction.hash) parsed.hash = "[REDACTED]";
    if (redaction.queryKeys.length > 0 || redaction.queryValues.length > 0) {
      parsed.search = "";
      for (const [index, [key, value]] of query.entries()) {
        parsed.searchParams.append(
          redaction.queryKeys.includes(index) ? "[REDACTED]" : key,
          redaction.queryValues.includes(index) ? "[REDACTED]" : value,
        );
      }
    }
    return { url: parsed.href, title: redaction.title ? "[REDACTED]" : title };
  }

  private async reconcileSensitiveActionTracking(
    tracker: JSHandle<SensitiveActionMutationTracker>,
    final: boolean,
  ): Promise<readonly ElementHandle<Element>[] | undefined> {
    let result: JSHandle<{ readonly reason: string | undefined; readonly elements: readonly Element[] }> |
      undefined;
    try {
      result = await tracker.evaluateHandle((state, limits) => {
        const fail = (reason: string) => ({ reason, elements: [] as Element[] });
        try {
          const byteLength = (text: string): number => {
            if (text.length > limits.maximumNodeBytes) throw new Error("node-length-overflow");
            return new TextEncoder().encode(text).byteLength;
          };
          const boundedText = (candidate: Element): string => {
            const chunks: string[] = [];
            let bytes = 0;
            const textRoots: Node[] = [candidate];
            if (candidate.shadowRoot !== null) textRoots.push(candidate.shadowRoot);
            let elements = 0;
            for (let rootIndex = 0; rootIndex < textRoots.length; rootIndex += 1) {
              const textRoot = textRoots[rootIndex];
              if (textRoot === undefined) throw new Error("text-root-unprovable");
              const walker = candidate.ownerDocument.createTreeWalker(
                textRoot,
                NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
              );
              for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
                if (node instanceof CharacterData) {
                  bytes += byteLength(node.data);
                  if (bytes > limits.maximumNodeBytes) throw new Error("node-byte-overflow");
                  chunks.push(node.data);
                } else if (node instanceof Element) {
                  elements += 1;
                  if (elements > limits.maximumDomElements) throw new Error("dom-element-overflow");
                  if (node.shadowRoot !== null) {
                    textRoots.push(node.shadowRoot);
                    if (textRoots.length > limits.maximumShadowRoots + 1) {
                      throw new Error("shadow-root-overflow");
                    }
                  }
                }
              }
            }
            return chunks.join("");
          };
          for (const observer of state.observers) {
            const pending = observer.takeRecords();
            if (state.records.length + pending.length > limits.maximumMutations) {
              state.overflow = true;
            } else {
              for (const record of pending) state.records.push({ record, causal: false });
            }
          }
          if (state.observerError) return fail("observer-error");
          if (state.overflow) return fail("tracker-overflow");
          if (state.scheduledPoison) return fail("scheduled-causality-bounds-exceeded");
          if (state.shadowPoison) return fail("shadow-root-unproven");
          if (state.ambiguousEvent) return fail("event-target-causality-ambiguous");
          if (!state.target.isConnected) return fail("target-replaced");
          const shadow = state.shadowRegistry.snapshot(limits.maximumShadowRoots);
          if (!shadow.intact || shadow.overflow ||
              shadow.count !== shadow.roots.length ||
              state.roots.length !== shadow.roots.length + 1) {
            return fail("shadow-root-identity-unproven");
          }

          const snapshot = (candidate: Element): {
            readonly properties: SensitiveActionPropertySnapshot;
            readonly bytes: number;
          } => {
            const selectedOption = candidate instanceof HTMLSelectElement
              ? candidate.selectedOptions.item(0)
              : null;
            const properties: SensitiveActionPropertySnapshot = {
              inputValue: candidate instanceof HTMLInputElement ||
                  candidate instanceof HTMLTextAreaElement ? candidate.value : null,
              selectValue: candidate instanceof HTMLSelectElement ? candidate.value : null,
              selectedOptionText: selectedOption?.text ?? null,
              textContent: boundedText(candidate),
              attributes: limits.attributes.map((name) => candidate.getAttribute(name)),
            };
            let bytes = 0;
            for (const property of [
              properties.inputValue,
              properties.selectValue,
              properties.selectedOptionText,
              properties.textContent,
              ...properties.attributes,
            ]) {
              if (property === null) continue;
              const propertyBytes = byteLength(property);
              if (propertyBytes > limits.maximumNodeBytes) throw new Error("node-byte-overflow");
              bytes += propertyBytes;
              if (bytes > limits.maximumNodeBytes) throw new Error("node-byte-overflow");
            }
            return { properties, bytes };
          };
          const values = (properties: SensitiveActionPropertySnapshot): readonly (string | null)[] => [
            properties.inputValue,
            properties.selectValue,
            properties.selectedOptionText,
            properties.textContent,
            ...properties.attributes,
          ];
          const containsForm = (property: string | null): boolean =>
            property !== null && state.forms.some((form) => property.includes(form));
          const nodes: Element[] = [];
          const roots: (Document | ShadowRoot)[] = [state.target.ownerDocument];
          for (const entry of shadow.roots) roots.push(entry.root);
          let domElements = 0;
          for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
            const root = roots[rootIndex];
            if (root === undefined) return fail("shadow-root-identity-unproven");
            const walker = state.target.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
            for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
              if (!(node instanceof Element)) return fail("candidate-unprovable");
              domElements += 1;
              if (domElements > limits.maximumDomElements) return fail("dom-element-overflow");
              if (node.matches(limits.candidateSelector)) {
                nodes.push(node);
                if (nodes.length > limits.maximumCandidates) return fail("candidate-overflow");
              }
            }
          }
          if (new Set(roots).size !== roots.length || roots.length !== shadow.roots.length + 1 ||
              shadow.roots.some((entry) => !roots.includes(entry.root))) {
            return fail("shadow-root-identity-unproven");
          }
          const current: SensitiveActionCandidateSnapshot[] = [];
          let snapshotBytes = 0;
          for (let index = 0; index < nodes.length; index += 1) {
            const candidate = nodes[index];
            if (candidate === undefined) return fail("candidate-unprovable");
            const captured = snapshot(candidate);
            snapshotBytes += captured.bytes;
            if (snapshotBytes > limits.maximumSnapshotBytes) return fail("snapshot-byte-overflow");
            current.push({ element: candidate, properties: captured.properties });
          }
          const totalCandidates = state.candidates.length + current.filter((candidate) =>
            !state.candidates.some((before) => before.element === candidate.element)).length;
          if (totalCandidates > limits.maximumCandidates) return fail("total-candidate-overflow");

          const elements: Element[] = [];
          const hasCausalRecord = (candidate: Element): boolean =>
            state.records.some((tracked) => tracked.causal && (
              tracked.record.target === candidate ||
              (tracked.record.target instanceof Node && candidate.contains(tracked.record.target))
            ));
          const causallyChanged = (candidate: Element): boolean =>
            candidate === state.target || state.causalElements.includes(candidate) ||
            candidate.hasAttribute(limits.privateTargetAttribute) || hasCausalRecord(candidate);
          const add = (candidate: Element | null): boolean => {
            if (candidate === null || !candidate.isConnected ||
                candidate.ownerDocument !== state.target.ownerDocument) return false;
            if (!elements.includes(candidate)) elements.push(candidate);
            return elements.length <= limits.maximumTargets;
          };
          for (const candidate of current) {
            const before = state.candidates.find((item) => item.element === candidate.element);
            const beforeValues = before === undefined ? [] : values(before.properties);
            const changedToForm = values(candidate.properties).some((property, index) =>
              property !== beforeValues[index] && containsForm(property));
            if (!changedToForm) continue;
            if (candidate.element instanceof HTMLTitleElement) continue;
            if (before !== undefined && beforeValues.some(containsForm) &&
                (candidate.element === state.target || hasCausalRecord(candidate.element))) continue;
            if (candidate.element === state.target) {
              if (!add(candidate.element)) return fail("sensitive-target-overflow");
              continue;
            }
            if (!causallyChanged(candidate.element)) {
              return fail("same-form-causality-ambiguous");
            }
            if (!add(candidate.element)) return fail("sensitive-target-overflow");
          }

          let inspectedBytes = snapshotBytes;
          const inspect = (
            property: string | null,
            candidate: Element | null,
            causal: boolean,
            kind: MutationRecord["type"],
          ): string | undefined => {
            if (property === null) return undefined;
            const bytes = byteLength(property);
            if (bytes > limits.maximumNodeBytes) return "node-byte-overflow";
            inspectedBytes += bytes;
            if (inspectedBytes > limits.maximumSnapshotBytes) return "snapshot-byte-overflow";
            if (!containsForm(property)) return undefined;
            if (candidate instanceof HTMLTitleElement) return undefined;
            if (kind === "childList" && candidate !== null && causallyChanged(candidate)) {
              return add(candidate) ? undefined : "sensitive-target-overflow";
            }
            if (candidate === null || !causallyChanged(candidate) ||
                (!causal && !candidate.hasAttribute(limits.privateTargetAttribute))) {
              return "same-form-causality-ambiguous";
            }
            return add(candidate) ? undefined : "sensitive-target-overflow";
          };
          for (const tracked of state.records) {
            const mutation = tracked.record;
            if (mutation.type === "attributes") {
              if (!(mutation.target instanceof Element) || mutation.attributeName === null) {
                return fail("attribute-target-unprovable");
              }
              if (current.some((candidate) => candidate.element === mutation.target)) continue;
              const reason = inspect(
                mutation.target.getAttribute(mutation.attributeName),
                mutation.target,
                tracked.causal,
                mutation.type,
              );
              if (reason !== undefined) return fail(reason);
            } else if (mutation.type === "characterData") {
              if (!(mutation.target instanceof CharacterData)) return fail("text-target-unprovable");
              const currentCandidate = current.find(
                (candidate) => candidate.element === mutation.target.parentElement,
              );
              if (currentCandidate !== undefined) {
                const beforeCandidate = state.candidates.find(
                  (candidate) => candidate.element === currentCandidate.element,
                );
                if (beforeCandidate !== undefined &&
                    values(beforeCandidate.properties).some(containsForm) &&
                    !hasCausalRecord(currentCandidate.element)) {
                  return fail("same-form-causality-ambiguous");
                }
                continue;
              }
              const reason = inspect(
                mutation.target.data,
                mutation.target.parentElement,
                tracked.causal,
                mutation.type,
              );
              if (reason !== undefined) return fail(`character:${reason}`);
            } else if (mutation.type === "childList") {
              if (mutation.addedNodes.length > limits.maximumCandidates ||
                  mutation.removedNodes.length > limits.maximumCandidates) {
                return fail("mutation-node-overflow");
              }
              for (const node of mutation.addedNodes) {
                const candidate = node instanceof Element ? node : node.parentElement;
                if (candidate !== null && !candidate.isConnected) continue;
                if (candidate instanceof HTMLTitleElement) continue;
                if (candidate !== null &&
                    current.some((currentCandidate) => currentCandidate.element === candidate)) {
                  const beforeCandidate = state.candidates.find(
                    (before) => before.element === candidate,
                  );
                  if (beforeCandidate !== undefined &&
                      values(beforeCandidate.properties).some(containsForm) &&
                      !hasCausalRecord(candidate) && !causallyChanged(candidate)) {
                    return fail("same-form-causality-ambiguous");
                  }
                  continue;
                }
                const text = node instanceof Element
                  ? boundedText(node)
                  : node.nodeValue;
                const reason = inspect(text, candidate, tracked.causal, mutation.type);
                if (reason !== undefined) return fail(`child:${reason}`);
              }
            } else {
              return fail("mutation-type-unprovable");
            }
          }

          if (limits.final) {
            if (state.preparedElements === undefined ||
                state.preparedElements.length !== elements.length ||
                state.preparedElements.some((candidate) => !elements.includes(candidate))) {
              return fail("capture-changed-during-evidence");
            }
            state.candidates = current;
            state.records.length = 0;
            state.preparedElements = undefined;
          } else {
            state.preparedElements = [...elements];
          }
          return { reason: undefined, elements };
        } catch {
          return fail("tracker-evaluation-error");
        }
      }, {
        final,
        maximumMutations: MAXIMUM_SENSITIVE_ACTION_MUTATIONS,
        maximumCandidates: MAXIMUM_SENSITIVE_ACTION_CANDIDATES,
        maximumTargets: MAXIMUM_SENSITIVE_ACTION_TARGETS,
        maximumNodeBytes: MAXIMUM_OBSERVATION_NODE_BYTES,
        maximumSnapshotBytes: MAXIMUM_OBSERVATION_SNAPSHOT_BYTES,
        maximumShadowRoots: MAXIMUM_SENSITIVE_SHADOW_ROOTS,
        maximumDomElements: MAXIMUM_SENSITIVE_DOM_ELEMENTS,
        candidateSelector: SENSITIVE_ACTION_CANDIDATE_SELECTOR,
        attributes: SENSITIVE_ACTION_ATTRIBUTES,
        privateTargetAttribute: PRIVATE_TARGET_ATTRIBUTE,
      });
      const summary = await result.evaluate((value) => ({
        reason: value.reason,
        count: value.elements.length,
      }));
      if (summary.reason !== undefined) throw new Error(summary.reason);
      if (final) return [];
      const elements = await result.getProperty("elements");
      try {
        const properties = await elements.getProperties();
        const handles: ElementHandle<Element>[] = [];
        for (let index = 0; index < summary.count; index += 1) {
          const handle = properties.get(String(index))?.asElement();
          if (handle === null || handle === undefined) throw new Error("element-unprovable");
          handles.push(handle);
        }
        return handles;
      } finally {
        await elements.dispose();
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : "";
      if (final && reason === "capture-changed-during-evidence") return undefined;
      if (reason === "same-form-causality-ambiguous") {
        this.reportSensitiveEvidenceDiagnostic("ReflectionCurrentStateUnproven");
      } else if (reason === "character:same-form-causality-ambiguous") {
        this.reportSensitiveEvidenceDiagnostic("ReflectionCharacterMutationUnproven");
      } else if (reason === "child:same-form-causality-ambiguous") {
        this.reportSensitiveEvidenceDiagnostic("ReflectionChildMutationUnproven");
      } else if (reason.includes("causality-ambiguous")) {
        this.reportSensitiveEvidenceDiagnostic("ReflectionCausalityUnproven");
      } else if (reason.includes("overflow")) {
        this.reportSensitiveEvidenceDiagnostic("TrackerOverflow");
      } else if (reason === "observer-error" || reason === "tracker-evaluation-error") {
        this.reportSensitiveEvidenceDiagnostic("TrackerObserverUnproven");
      } else if (reason.includes("shadow-root")) {
        this.reportSensitiveEvidenceDiagnostic("ShadowIntegrityUnproven");
      } else {
        this.reportSensitiveEvidenceDiagnostic("TrackerReconciliationUnproven");
      }
      throw this.sensitiveEvidenceFailure();
    } finally {
      await result?.dispose().catch(() => { this.sensitiveEvidenceUnproven = true; });
    }
  }

  private async disposeSensitiveActionTracker(
    tracker: JSHandle<SensitiveActionMutationTracker>,
    suppressFailure = false,
  ): Promise<void> {
    let failed = false;
    try {
      if (!(await tracker.evaluate((state) => state.restore()))) failed = true;
    } catch {
      failed = true;
    }
    await tracker.dispose().catch(() => { failed = true; });
    if (failed && !suppressFailure) {
      throw this.sensitiveEvidenceFailure(
        "Sensitive action provenance tracking could not be removed.",
      );
    }
  }

  private async retainSensitiveElements(handles: readonly ElementHandle<Element>[]): Promise<void> {
    if (this.page === undefined) {
      throw new Error("page-unavailable");
    }
    const unique: ElementHandle<Element>[] = [];
    for (const handle of handles) {
      let retained = false;
      for (const target of this.sensitiveActionTargets.values()) {
        if (await handle.evaluate((element, existing) => element === existing, target.handle)) {
          retained = true;
          break;
        }
      }
      if (retained) {
        await handle.dispose();
      } else {
        let duplicate = false;
        for (const candidate of unique) {
          if (await handle.evaluate((element, existing) => element === existing, candidate)) {
            duplicate = true;
            break;
          }
        }
        if (duplicate) {
          await handle.dispose();
        } else {
          unique.push(handle);
        }
      }
    }
    if (this.sensitiveActionTargets.size + unique.length > MAXIMUM_SENSITIVE_ACTION_TARGETS) {
      await Promise.all(unique.map((handle) => handle.dispose().catch(() => undefined)));
      throw new Error("sensitive-target-overflow");
    }

    const registered: SensitiveActionTarget[] = [];
    try {
      for (const handle of unique) {
        this.privateTargetOrdinal += 1;
        const token = `target-${this.privateTargetOrdinal}`;
        const markerInstalled = await handle.evaluate((element, identity) => {
          element.setAttribute(identity.attribute, identity.token);
          return element.isConnected && element.getAttribute(identity.attribute) === identity.token;
        }, { attribute: PRIVATE_TARGET_ATTRIBUTE, token });
        if (!markerInstalled) throw new Error("reflected-marker-unproven");
        const target: SensitiveActionTarget = {
          token,
          locator: this.page.locator(`[${PRIVATE_TARGET_ATTRIBUTE}="${token}"]`),
          handle,
          markerInstalled: true,
          nodeId: undefined,
          closedShadowRoot: await handle.evaluate((element) => {
            const root = element.getRootNode();
            return root instanceof ShadowRoot && root.mode === "closed";
          }),
        };
        this.sensitiveActionTargets.set(token, target);
        registered.push(target);
      }
    } catch (error) {
      for (const target of registered) {
        this.sensitiveActionTargets.delete(target.token);
        await target.handle.evaluate((element, identity) => {
          if (element.getAttribute(identity.attribute) === identity.token) {
            element.removeAttribute(identity.attribute);
          }
        }, { attribute: PRIVATE_TARGET_ATTRIBUTE, token: target.token }).catch(() => undefined);
      }
      await Promise.all(unique.map((handle) => handle.dispose().catch(() => undefined)));
      throw error;
    }
  }

  advanceSensitiveTargets(graphId: string, nodeIds: readonly string[]): void {
    const targets = this.sensitiveTargets();
    if (targets.length !== nodeIds.length) {
      throw new WebTargetError(
        "SensitiveTargetUnproven",
        "The sensitive target observation mapping is incomplete.",
      );
    }
    for (const [index, target] of targets.entries()) {
      const advanced = { ...target, nodeId: nodeIds[index]! };
      this.sensitiveActionTargets.set(target.token, advanced);
      this.privateActionTargets.set(
        `${graphId}\0${advanced.nodeId}`,
        advanced,
      );
    }
  }

  async start(): Promise<void> {
    if (this.state === "started") {
      return;
    }
    if (this.state === "closed" || this.state === "closing") {
      throw new WebTargetError("SessionClosed", "Session is closed.");
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    this.state = "starting";
    this.startPromise = this.doStart();
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    this.validateTarget();

    let browser: Browser;
    try {
      browser = await this.launcher.launch({ headless: !this.options.headed });
    } catch {
      this.state = "closed";
      throw new WebTargetError("BrowserLaunchFailed");
    }

    this.browser = browser;
    try {
      const context = await browser.newContext();
      context.setDefaultTimeout(this.options.actionTimeoutMs);
      context.setDefaultNavigationTimeout(this.options.navigationTimeoutMs);
      this.context = context;

      if (typeof context.addInitScript !== "function") {
        throw new WebTargetError("BrowserLaunchFailed");
      }
      await context.addInitScript(({
        registryKey,
        accessToken,
        maximumRoots,
        promiseKey,
        promiseAccessToken,
        promiseInitEpoch,
        maximumPromiseOwners,
      }) => {
        const nativeObject = Object;
        const nativeReflect = Reflect;
        const nativeDefineProperty = Object.defineProperty;
        const nativeDefineProperties = Object.defineProperties;
        const nativeOwnDescriptor = Object.getOwnPropertyDescriptor;
        const nativePrototypeOf = Object.getPrototypeOf;
        const nativeFreeze = Object.freeze;
        const nativeReflectApply = Reflect.apply;
        const nativeReflectOwnKeys = Reflect.ownKeys;
        const nativePromise = Promise;
        const nativePrototype = Promise.prototype;
        const host = globalThis as typeof globalThis & Record<symbol, unknown>;
        const registrySymbol = Symbol.for(registryKey);
        if (host[registrySymbol] !== undefined) return;
        const originalAttachShadow = Element.prototype.attachShadow;
        const originalDescriptor = nativeOwnDescriptor(Element.prototype, "attachShadow");
        if (originalDescriptor?.value !== originalAttachShadow) return;
        const roots: PrivateShadowRootEntry[] = [];
        const closedObservers: MutationObserver[] = [];
        const listeners = new Set<(element: Element, root: ShadowRoot, mode: ShadowRootMode) => void>();
        let count = 0;
        let overflow = false;
        let closedMutationCount = 0;
        let listenerError = false;
        const wrappedAttachShadow = function (
          this: Element,
          init: ShadowRootInit,
        ): ShadowRoot {
          const root = nativeReflectApply(originalAttachShadow, this, [init]);
          count += 1;
          if (count > maximumRoots) {
            overflow = true;
          } else {
            roots.push(nativeFreeze({ host: this, root, mode: init.mode }));
            if (init.mode === "closed") {
              const observer = new MutationObserver((records) => {
                closedMutationCount += records.length;
              });
              observer.observe(root, {
                attributes: true,
                characterData: true,
                childList: true,
                subtree: true,
              });
              closedObservers.push(observer);
            }
          }
          for (const listener of listeners) {
            try {
              listener(this, root, init.mode);
            } catch {
              listenerError = true;
            }
          }
          return root;
        };
        nativeDefineProperties(wrappedAttachShadow, {
          name: { configurable: true, value: originalAttachShadow.name },
          length: { configurable: true, value: originalAttachShadow.length },
          toString: {
            configurable: true,
            value: () => originalAttachShadow.toString(),
          },
        });
        nativeDefineProperty(Element.prototype, "attachShadow", {
          ...originalDescriptor,
          value: wrappedAttachShadow,
        });
        const authority: PrivateShadowRegistry = nativeFreeze({
          snapshot(limit: number) {
            for (const observer of closedObservers) {
              closedMutationCount += observer.takeRecords().length;
            }
            const descriptor = nativeOwnDescriptor(Element.prototype, "attachShadow");
            return {
              roots: roots.slice(0, limit),
              hosts: roots.slice(0, limit).map(({ host, mode }) => ({ host, mode })),
              count,
              closedMutationCount,
              overflow: overflow || count > limit,
              intact: !listenerError && descriptor?.value === wrappedAttachShadow &&
                descriptor.configurable === originalDescriptor.configurable &&
                descriptor.enumerable === originalDescriptor.enumerable &&
                descriptor.writable === originalDescriptor.writable &&
                host[registrySymbol] === gateway,
            };
          },
          subscribe(listener: (element: Element, root: ShadowRoot, mode: ShadowRootMode) => void) {
            listeners.add(listener);
            return Element.prototype.attachShadow === wrappedAttachShadow;
          },
          unsubscribe(listener: (element: Element, root: ShadowRoot, mode: ShadowRootMode) => void) {
            return listeners.delete(listener) && Element.prototype.attachShadow === wrappedAttachShadow;
          },
        });
        const gateway = nativeFreeze({
          access(candidate: string): PrivateShadowRegistry | undefined {
            return candidate === accessToken ? authority : undefined;
          },
        });
        nativeDefineProperty(host, registrySymbol, {
          configurable: false,
          enumerable: false,
          writable: false,
          value: gateway,
        });
        const promiseSymbol = Symbol.for(promiseKey);
        if (host[promiseSymbol] !== undefined) return;
        const globalDescriptor = nativeOwnDescriptor(globalThis, "Promise");
        const prototypeDescriptor = nativeOwnDescriptor(nativePromise, "prototype");
        const staticDescriptors = nativeReflectOwnKeys(nativePromise).map((key) =>
          [key, nativeOwnDescriptor(nativePromise, key)] as const);
        const thenDescriptor = nativeOwnDescriptor(nativePrototype, "then");
        const catchDescriptor = nativeOwnDescriptor(nativePrototype, "catch");
        const finallyDescriptor = nativeOwnDescriptor(nativePrototype, "finally");
        const constructorDescriptor = nativeOwnDescriptor(nativePrototype, "constructor");
        const speciesDescriptor = nativeOwnDescriptor(nativePromise, Symbol.species);
        if (thenDescriptor === undefined || !("value" in thenDescriptor) ||
            catchDescriptor === undefined || !("value" in catchDescriptor) ||
            finallyDescriptor === undefined || !("value" in finallyDescriptor)) return;
        const sameDescriptor = (
          current: PropertyDescriptor | undefined,
          captured: PropertyDescriptor | undefined,
        ): boolean => current !== undefined && captured !== undefined &&
          current.configurable === captured.configurable && current.enumerable === captured.enumerable &&
          current.get === captured.get && current.set === captured.set &&
          current.value === captured.value && current.writable === captured.writable;
        const hooks = new Set<PrivatePromiseBoundaryHook>();
        type PromiseMethodName = "then" | "catch" | "finally";
        interface PromiseChainOwnerSnapshot {
          readonly owner: object;
          readonly prototype: object | null;
          readonly descriptors: readonly (readonly [PromiseMethodName, PropertyDescriptor | undefined])[];
        }
        interface RegisteredPromiseOwner {
          readonly receiver: object;
          readonly chain: readonly PromiseChainOwnerSnapshot[];
        }
        let registeredOwnerIndex = new WeakMap<object, RegisteredPromiseOwner>();
        const registeredOwners: RegisteredPromiseOwner[] = [];
        let ownerRegistryOverflow = false;
        let ownerIntegrityPoisoned = false;
        let intrinsicIntegrityPoisoned = false;
        let promiseAuthorityClosed = false;
        const instrumentedMethods = new WeakMap<Function, {
          readonly method: Function;
          readonly name: PromiseMethodName;
        }>();
        const approvedMethods = new WeakSet<Function>([
          thenDescriptor.value,
          catchDescriptor.value,
          finallyDescriptor.value,
        ]);
        const sameDescriptorShape = (
          current: PropertyDescriptor | undefined,
          captured: PropertyDescriptor | undefined,
        ): boolean => current !== undefined && captured !== undefined &&
          "value" in current && "value" in captured &&
          current.configurable === captured.configurable &&
          current.enumerable === captured.enumerable &&
          current.writable === captured.writable;
        const ambientIntrinsicsIntact = (): boolean => {
          if (intrinsicIntegrityPoisoned) return false;
          try {
            const intact = Object === nativeObject && Reflect === nativeReflect &&
              Object.defineProperty === nativeDefineProperty &&
              Object.defineProperties === nativeDefineProperties &&
              Object.getOwnPropertyDescriptor === nativeOwnDescriptor &&
              Object.getPrototypeOf === nativePrototypeOf &&
              Object.freeze === nativeFreeze && Reflect.apply === nativeReflectApply &&
              Reflect.ownKeys === nativeReflectOwnKeys;
            if (!intact) intrinsicIntegrityPoisoned = true;
            return intact;
          } catch {
            intrinsicIntegrityPoisoned = true;
            return false;
          }
        };
        interface CustomCallFrame {
          readonly token: readonly PrivatePromiseDelegationToken[];
          readonly expectedReceiver: unknown;
          delegated: boolean;
        }
        // Only the top frame's exact receiver may attest it. A cross-receiver
        // native delegation can prove its parent only through its exact result.
        const pendingCustomCalls: CustomCallFrame[] = [];
        let pendingContinuationFrames = new WeakMap<object, CustomCallFrame[]>();
        let delegatedContinuations = new WeakMap<CustomCallFrame, WeakSet<object>>();
        const captureOwnerChain = (receiver: object): readonly PromiseChainOwnerSnapshot[] | undefined => {
          const chain: PromiseChainOwnerSnapshot[] = [];
          try {
            for (let owner: object | null = receiver; owner !== null; owner = nativePrototypeOf(owner)) {
              if (chain.length >= maximumPromiseOwners) return undefined;
              const descriptors = (["then", "catch", "finally"] as const).map((name) =>
                nativeFreeze([name, (() => {
                  const descriptor = nativeOwnDescriptor(owner, name);
                  return descriptor === undefined ? undefined : nativeFreeze({ ...descriptor });
                })()] as const));
              chain.push(nativeFreeze({
                owner,
                prototype: nativePrototypeOf(owner),
                descriptors: nativeFreeze(descriptors),
              }));
            }
            return nativeFreeze(chain);
          } catch {
            return undefined;
          }
        };
        const registerOwner = (receiver: unknown): void => {
          if ((typeof receiver !== "object" && typeof receiver !== "function") || receiver === null ||
              registeredOwnerIndex.has(receiver) || ownerIntegrityPoisoned) return;
          if (registeredOwners.length >= maximumPromiseOwners) {
            ownerRegistryOverflow = true;
            return;
          }
          const chain = captureOwnerChain(receiver);
          if (chain === undefined) {
            ownerRegistryOverflow = true;
            return;
          }
          const registered = nativeFreeze({ receiver, chain });
          registeredOwnerIndex.set(receiver, registered);
          registeredOwners.push(registered);
        };
        const registeredOwnersIntact = (): boolean => {
          if (promiseAuthorityClosed || ownerRegistryOverflow || ownerIntegrityPoisoned) return false;
          try {
            const intact = registeredOwners.every((registered) =>
              registeredOwnerIndex.get(registered.receiver) === registered &&
              registered.chain.every((captured) =>
                nativePrototypeOf(captured.owner) === captured.prototype &&
                captured.descriptors.every(([name, descriptor]) =>
                  descriptor === undefined
                    ? nativeOwnDescriptor(captured.owner, name) === undefined
                    : sameDescriptor(nativeOwnDescriptor(captured.owner, name), descriptor))));
            if (!intact) ownerIntegrityPoisoned = true;
            return intact;
          } catch {
            ownerIntegrityPoisoned = true;
            return false;
          }
        };
        const settle = (frame: CustomCallFrame): void => {
          for (const hook of hooks) hook.settle(frame.token);
        };
        const takeContinuationFrame = (receiver: unknown): CustomCallFrame | undefined => {
          if ((typeof receiver !== "object" && typeof receiver !== "function") || receiver === null) {
            return undefined;
          }
          const frames = pendingContinuationFrames.get(receiver);
          const frame = frames?.shift();
          if (frames?.length === 0) pendingContinuationFrames.delete(receiver);
          return frame;
        };
        const deferThroughContinuation = (frame: CustomCallFrame, receiver: object): boolean => {
          if (!delegatedContinuations.get(frame)?.has(receiver)) return false;
          const tokens: PrivatePromiseDelegationToken[] = [];
          for (const hook of hooks) tokens.push(...hook.child(frame.token));
          if (tokens.length === 0) return false;
          const frames = pendingContinuationFrames.get(receiver) ?? [];
          frames.push({ token: tokens, expectedReceiver: receiver, delegated: false });
          pendingContinuationFrames.set(receiver, frames);
          return true;
        };
        let observeReceiver: (
          receiver: unknown,
        ) => readonly PromiseMethodName[];
        const wrappedThen = function <T, TResult1 = T, TResult2 = never>(
          this: Promise<T>,
          onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ): Promise<TResult1 | TResult2> {
          let fulfilled: unknown = onfulfilled;
          let rejected: unknown = onrejected;
          let frame = pendingCustomCalls.at(-1);
          let continuationFrame = false;
          const customMethods = hooks.size === 0 ? [] : observeReceiver(this);
          if (frame === undefined) {
            frame = takeContinuationFrame(this);
            if (frame !== undefined) {
              pendingCustomCalls.push(frame);
              continuationFrame = true;
            }
          }
          if (frame === undefined && customMethods.length > 0) {
            const tokens: PrivatePromiseDelegationToken[] = [];
            for (const hook of hooks) tokens.push(...hook.custom(this));
            frame = { token: tokens, expectedReceiver: this, delegated: false };
            pendingCustomCalls.push(frame);
            continuationFrame = true;
          }
          const associated = frame?.expectedReceiver === this ? frame.token : [];
          if (frame?.expectedReceiver === this) frame.delegated = true;
          for (const hook of hooks) {
            [fulfilled, rejected] = hook.wrap(this, fulfilled, rejected, associated);
          }
          try {
            const result = nativeReflectApply(thenDescriptor.value, this, [fulfilled, rejected]) as
              Promise<TResult1 | TResult2>;
            if (frame !== undefined && frame.expectedReceiver !== this) {
              const continuations = delegatedContinuations.get(frame) ?? new WeakSet<object>();
              continuations.add(result);
              delegatedContinuations.set(frame, continuations);
            }
            return result;
          } finally {
            if (continuationFrame && frame !== undefined) {
              pendingCustomCalls.pop();
              settle(frame);
            }
          }
        };
        nativeDefineProperties(wrappedThen, {
          name: { configurable: true, value: thenDescriptor.value.name },
          length: { configurable: true, value: thenDescriptor.value.length },
        });
        approvedMethods.add(wrappedThen);
        const instrumentCustom = (method: Function, name: PromiseMethodName): Function => {
          const existing = instrumentedMethods.get(method);
          if (existing?.name === name) return method;
          const instrumented = function (this: unknown, ...args: unknown[]): unknown {
            observeReceiver(this);
            registerOwner(this);
            const parent = pendingCustomCalls.at(-1);
            let frame = takeContinuationFrame(this);
            if (frame === undefined) {
              const tokens: PrivatePromiseDelegationToken[] = [];
              for (const hook of hooks) tokens.push(...hook.custom(this));
              frame = { token: tokens, expectedReceiver: this, delegated: false };
            }
            pendingCustomCalls.push(frame);
            try {
              const result = nativeReflectApply(method, this, args);
              if ((typeof result === "object" || typeof result === "function") && result !== null) {
                if (parent !== undefined && frame.delegated) {
                  const continuations = delegatedContinuations.get(parent) ?? new WeakSet<object>();
                  continuations.add(result);
                  delegatedContinuations.set(parent, continuations);
                }
                if (!frame.delegated && deferThroughContinuation(frame, result)) {
                  return result;
                }
                for (const hook of hooks) hook.returned(result);
              }
              return result;
            } finally {
              pendingCustomCalls.pop();
              settle(frame);
            }
          };
          nativeDefineProperties(instrumented, {
            name: { configurable: true, value: method.name },
            length: { configurable: true, value: method.length },
          });
          instrumentedMethods.set(instrumented, { method, name });
          approvedMethods.add(instrumented);
          return instrumented;
        };
        observeReceiver = (receiver) => {
          if ((typeof receiver !== "object" && typeof receiver !== "function") || receiver === null) {
            return [];
          }
          if (!registeredOwnersIntact()) return [];
          const customMethods: PromiseMethodName[] = [];
          const owners: object[] = [];
          const discoveredOwners: object[] = [];
          try {
            for (let owner: object | null = receiver; owner !== null; owner = nativePrototypeOf(owner)) {
              owners.push(owner);
              if (owner === nativePrototype) break;
            }
            for (const owner of owners) {
              let discoveredCustomMethod = false;
              for (const name of ["then", "catch", "finally"] as const) {
                const descriptor = nativeOwnDescriptor(owner, name);
                if (descriptor === undefined) continue;
                if (!("value" in descriptor) || typeof descriptor.value !== "function") {
                  discoveredCustomMethod = true;
                  customMethods.push(name);
                  continue;
                }
                const method = descriptor.value;
                const nativeMethod = name === "then" ? thenDescriptor.value
                  : name === "catch" ? catchDescriptor.value : finallyDescriptor.value;
                if (owner === nativePrototype && name === "then" &&
                    (method === nativeMethod || method === wrappedThen)) {
                  if (method !== wrappedThen) {
                    nativeDefineProperty(owner, name, { ...descriptor, value: wrappedThen });
                  }
                } else if (method !== nativeMethod && method !== wrappedThen) {
                  discoveredCustomMethod = true;
                  customMethods.push(name);
                  if (!instrumentedMethods.has(method)) {
                    nativeDefineProperty(owner, name, {
                      ...descriptor,
                      value: instrumentCustom(method, name),
                    });
                  }
                }
              }
              if (discoveredCustomMethod) discoveredOwners.push(owner);
            }
            for (const owner of discoveredOwners) registerOwner(owner);
          } catch {
            ownerIntegrityPoisoned = true;
          }
          return customMethods;
        };
        nativeDefineProperty(nativePrototype, "then", {
          ...thenDescriptor,
          value: wrappedThen,
        });
        observeReceiver(nativePrototype);
        const wrappedCatch = catchDescriptor.value as Promise<unknown>["catch"];
        const wrappedFinally = finallyDescriptor.value as Promise<unknown>["finally"];
        const promiseAuthority: PrivatePromiseIntrinsics = nativeFreeze({
          attest(epoch: string) {
            return epoch === promiseInitEpoch && host[promiseSymbol] === promiseGateway &&
              ambientIntrinsicsIntact();
          },
          snapshot() {
            const ownersIntact = registeredOwnersIntact();
            observeReceiver(nativePrototype);
            return {
              then: thenDescriptor?.value as Promise<unknown>["then"],
              catch: catchDescriptor?.value as Promise<unknown>["catch"],
              finally: finallyDescriptor?.value as Promise<unknown>["finally"],
              wrappedThen,
              wrappedCatch,
              wrappedFinally,
              intact: ownersIntact && ambientIntrinsicsIntact() && Promise === nativePromise &&
                Promise.prototype === nativePrototype &&
                sameDescriptor(nativeOwnDescriptor(globalThis, "Promise"), globalDescriptor) &&
                sameDescriptor(nativeOwnDescriptor(nativePromise, "prototype"), prototypeDescriptor) &&
                staticDescriptors.every(([key, descriptor]) =>
                  key === "prototype" || sameDescriptor(nativeOwnDescriptor(nativePromise, key), descriptor)) &&
                approvedMethods.has(Promise.prototype.then) &&
                approvedMethods.has(Promise.prototype.catch) &&
                approvedMethods.has(Promise.prototype.finally) &&
                sameDescriptor(nativeOwnDescriptor(nativePrototype, "constructor"), constructorDescriptor) &&
                sameDescriptor(nativeOwnDescriptor(nativePromise, Symbol.species), speciesDescriptor) &&
                host[promiseSymbol] === promiseGateway,
              ownDescriptor: nativeOwnDescriptor,
              prototypeOf: nativePrototypeOf,
              descriptorShapeIntact: (() => {
                return sameDescriptorShape(nativeOwnDescriptor(nativePrototype, "then"), thenDescriptor) &&
                  sameDescriptorShape(nativeOwnDescriptor(nativePrototype, "catch"), catchDescriptor) &&
                  sameDescriptorShape(nativeOwnDescriptor(nativePrototype, "finally"), finallyDescriptor);
              })(),
            };
          },
          observe(receiver: unknown) {
            observeReceiver(receiver);
            return registeredOwnersIntact();
          },
          subscribe(hook: PrivatePromiseBoundaryHook) {
            observeReceiver(nativePrototype);
            hooks.add(hook);
            return promiseAuthority.snapshot().intact;
          },
          unsubscribe(hook: PrivatePromiseBoundaryHook) {
            return hooks.delete(hook) && promiseAuthority.snapshot().intact;
          },
          isWrappedThen(candidate: unknown) {
            return candidate === wrappedThen;
          },
          revalidateOwners() {
            return registeredOwnersIntact();
          },
          close() {
            const intact = promiseAuthority.snapshot().intact;
            promiseAuthorityClosed = true;
            ownerRegistryOverflow = false;
            hooks.clear();
            pendingCustomCalls.length = 0;
            registeredOwners.length = 0;
            registeredOwnerIndex = new WeakMap();
            pendingContinuationFrames = new WeakMap();
            delegatedContinuations = new WeakMap();
            return intact;
          },
        });
        const promiseGateway = nativeFreeze({
          access(candidate: string): PrivatePromiseIntrinsics | undefined {
            return candidate === promiseAccessToken ? promiseAuthority : undefined;
          },
        });
        nativeDefineProperty(host, promiseSymbol, {
          configurable: false,
          enumerable: false,
          writable: false,
          value: promiseGateway,
        });
      }, {
        registryKey: this.shadowRegistryKey,
        accessToken: this.shadowRegistryAccessToken,
        maximumRoots: MAXIMUM_SENSITIVE_SHADOW_ROOTS,
        promiseKey: this.promiseIntrinsicsKey,
        promiseAccessToken: this.promiseIntrinsicsAccessToken,
        promiseInitEpoch: this.promiseInitEpoch,
        maximumPromiseOwners: MAXIMUM_OBSERVED_PROMISE_OWNERS,
      });

      const page = await context.newPage();
      this.page = page;

      await page.goto(this.options.url, {
        waitUntil: "domcontentloaded",
        timeout: this.options.navigationTimeoutMs,
      });
      const registry = await page.evaluateHandle(({ registryKey, accessToken }) => {
        const gateway = (globalThis as typeof globalThis & Record<symbol, unknown>)[
          Symbol.for(registryKey)
        ] as { access(candidate: string): PrivateShadowRegistry | undefined } | undefined;
        return gateway?.access(accessToken);
      }, {
        registryKey: this.shadowRegistryKey,
        accessToken: this.shadowRegistryAccessToken,
      });
      const proven = await registry.evaluate((candidate, maximumRoots) =>
        candidate?.snapshot(maximumRoots).intact === true,
      MAXIMUM_SENSITIVE_SHADOW_ROOTS);
      if (proven) this.shadowRegistry = registry as JSHandle<PrivateShadowRegistry>;
      else await registry.dispose();
      const promiseIntrinsics = await page.evaluateHandle(({ promiseKey, accessToken }) => {
        const gateway = (globalThis as typeof globalThis & Record<symbol, unknown>)[
          Symbol.for(promiseKey)
        ] as { access(candidate: string): PrivatePromiseIntrinsics | undefined } | undefined;
        return gateway?.access(accessToken);
      }, {
        promiseKey: this.promiseIntrinsicsKey,
        accessToken: this.promiseIntrinsicsAccessToken,
      });
      this.promiseIntrinsics = promiseIntrinsics as JSHandle<PrivatePromiseIntrinsics>;
      this.promiseInitAttested = await promiseIntrinsics.evaluate(
        (authority, epoch) => authority?.attest(epoch) === true,
        this.promiseInitEpoch,
      ).catch(() => false);
    } catch (error) {
      await this.disposeResources();
      this.state = "closed";
      throw this.toNavigationError(error);
    }

    this.state = "started";
  }

  private validateTarget(): void {
    let parsed: URL;
    try {
      parsed = new URL(this.options.url);
    } catch {
      throw new WebTargetError(
        "NavigationFailed",
        `Invalid target URL: ${this.options.url}`,
      );
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new WebTargetError(
        "NavigationFailed",
        `Unsupported scheme: ${parsed.protocol}`,
      );
    }

    if (parsed.username !== "" || parsed.password !== "") {
      throw new WebTargetError(
        "NavigationFailed",
        "Target URL must not embed credentials.",
      );
    }

    if (!this.options.allowedOrigins.includes(parsed.origin)) {
      throw new WebTargetError(
        "OriginViolation",
        `Target origin ${parsed.origin} is not in the allowlist.`,
      );
    }
  }

  private toNavigationError(error: unknown): WebTargetError {
    if (error instanceof WebTargetError) {
      return error;
    }
    const message = error instanceof Error ? error.message : "";
    if (/timeout/i.test(message)) {
      return new WebTargetError("NavigationTimedOut");
    }
    return new WebTargetError("NavigationFailed");
  }

  /**
   * Serialized access to the live Playwright page. The page never escapes this
   * closure, keeping Playwright objects inside the adapter.
   */
  async withPage<T>(operation: (page: Page) => Promise<T>): Promise<T> {
    const run = this.operation.then(async () => {
      if (this.state !== "started" || !this.page) {
        throw new WebTargetError(
          "SessionClosed",
          "Session is not started or already closed.",
        );
      }
      return operation(this.page);
    });

    this.operation = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async close(): Promise<void> {
    if (this.state === "closed") {
      return;
    }
    if (this.state === "starting" && this.startPromise) {
      await this.startPromise.catch(() => undefined);
    }

    this.state = "closing";
    const firstError = await this.disposeResources();
    this.state = "closed";

    if (firstError) {
      throw firstError;
    }
  }

  private async disposeResources(): Promise<Error | undefined> {
    let firstError: Error | undefined;
    const record = (error: unknown): void => {
      if (!firstError) {
        firstError = error instanceof Error ? error : new Error(String(error));
      }
    };

    const targets = new Map([
      ...[...this.privateActionTargets.values()].map((target) => [target.token, target] as const),
      ...[...this.sensitiveActionTargets.values()].map((target) => [target.token, target] as const),
    ]);
    if (this.page) {
      await this.abandonSensitiveActionTracking().catch(record);
      for (const target of targets.values()) {
        if (target.markerInstalled) {
          await target.handle.evaluate((element, identity) => {
            if (element.getAttribute(identity.attribute) === identity.token) {
              element.removeAttribute(identity.attribute);
            }
          }, { attribute: PRIVATE_TARGET_ATTRIBUTE, token: target.token }).catch(() => undefined);
        }
      }
      if (this.promiseIntrinsics) {
        await this.promiseIntrinsics.evaluate((authority) => authority.close()).catch(record);
      }
      await this.page.close().catch(record);
      this.page = undefined;
    }
    if (this.shadowRegistry) {
      await this.shadowRegistry.dispose().catch(record);
      this.shadowRegistry = undefined;
    }
    if (this.promiseIntrinsics) {
      await this.promiseIntrinsics.dispose().catch(record);
      this.promiseIntrinsics = undefined;
    }
    for (const target of targets.values()) {
      await target.handle.dispose().catch(() => undefined);
    }
    if (this.context) {
      await this.context.close().catch(record);
      this.context = undefined;
    }
    if (this.browser) {
      await this.browser.close().catch(record);
      this.browser = undefined;
    }
    this.sensitiveActionTargets.clear();
    this.privateActionTargets.clear();
    this.sensitiveEvidenceUnproven = false;
    return firstError;
  }
}

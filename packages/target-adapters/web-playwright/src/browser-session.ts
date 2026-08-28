import { type ChildProcess } from "node:child_process";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { ExecutionTargetError, type ExecutionTargetErrorStatus } from "@qualigence/runner-kernel";
import type { CapturedArtifact, LocatorDescriptor } from "./types.js";
import {
  MAX_SENSITIVE_PROMISE_OWNER_REGISTRY_OWNERS,
  MAX_SENSITIVE_SCHEDULER_REGISTRATIONS_PER_EPOCH,
  MAX_SENSITIVE_SCHEDULER_REGISTRATIONS_PER_SESSION,
  MAX_SENSITIVE_SHADOW_ROOTS,
  SensitiveEvidenceAuthority,
  SENSITIVE_EVIDENCE_STATE_PROPERTY,
  SENSITIVE_SHADOW_ROOTS_PROPERTY,
  type PreparedSensitiveEvidenceRecord,
  type SensitiveEvidenceMaskRefreshRequest,
  type SensitiveEvidencePageStateSnapshot,
  type SensitiveEvidenceScanRecord,
  type SensitiveMaskSnapshotEntry,
} from "./sensitive-evidence-authority.js";

export type WebTargetErrorCode =
  | "BrowserLaunchFailed"
  | "BrowserCloseTimedOut"
  | "NavigationFailed"
  | "NavigationTimedOut"
  | "StaleObservation"
  | "UnknownObservationNode"
  | "TargetNotFound"
  | "AmbiguousTarget"
  | "OriginViolation"
  | "ActionTimedOut"
  | "ActionInfrastructureFailure"
  | "TargetNotVisible"
  | "TargetDisabled"
  | "ActionValueUnavailable"
  | "SensitiveEvidenceUnavailable"
  | "UnsupportedAction"
  | "ConcurrentSessionOperation"
  | "SessionClosed";

export class WebTargetError extends ExecutionTargetError {
  constructor(
    readonly code: WebTargetErrorCode,
    message?: string,
  ) {
    super(code, completionStatus(code), message);
    this.name = "WebTargetError";
  }
}

function completionStatus(code: WebTargetErrorCode): ExecutionTargetErrorStatus {
  switch (code) {
    case "StaleObservation":
    case "UnknownObservationNode":
    case "TargetNotFound":
    case "AmbiguousTarget":
    case "OriginViolation":
    case "ActionTimedOut":
    case "TargetNotVisible":
    case "TargetDisabled":
    case "ActionValueUnavailable":
    case "UnsupportedAction":
      return "blocked";
    case "SensitiveEvidenceUnavailable":
    case "BrowserLaunchFailed":
    case "BrowserCloseTimedOut":
    case "NavigationFailed":
    case "NavigationTimedOut":
    case "ActionInfrastructureFailure":
    case "ConcurrentSessionOperation":
    case "SessionClosed":
      return "error";
    default:
      return assertNever(code);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled WebTargetError code: ${String(value)}`);
}

function sensitiveEvidenceUnavailable(): WebTargetError {
  return new WebTargetError(
    "SensitiveEvidenceUnavailable",
    "Sensitive target evidence could not be proven.",
  );
}

function validateSensitivePromiseOwnerRegistryInPage(input: {
  readonly runtimeRegistryProperty: string;
  readonly maxPromiseOwners: number;
}): { readonly status: "ok" | "failed"; readonly reason?: string } {
  type RuntimeAuthorityValidationResult = { readonly status: "ok" | "failed"; readonly reason?: string };
  type RuntimeRegistry = {
    readonly validatePromiseOwners?: (maxPromiseOwners: number) => RuntimeAuthorityValidationResult;
    readonly validateShadowRootAuthority?: () => RuntimeAuthorityValidationResult;
    promiseOwnerValidationFailed?: boolean;
    shadowRootAuthorityFailed?: boolean;
  };
  const registry = (globalThis as unknown as Record<string, RuntimeRegistry | undefined>)[input.runtimeRegistryProperty];
  if (registry === undefined) return { status: "ok" };
  const validateShadowRootAuthority = registry.validateShadowRootAuthority;
  if (typeof validateShadowRootAuthority !== "function") return fail(registry, "missing-shadow-root-validator", "shadow");
  try {
    const shadowResult = validateShadowRootAuthority();
    if (shadowResult.status !== "ok") return fail(registry, shadowResult.reason ?? "shadow-root-authority-failed", "shadow");
  } catch {
    return fail(registry, "shadow-root-inspection-threw", "shadow");
  }
  const validatePromiseOwners = registry.validatePromiseOwners;
  if (typeof validatePromiseOwners !== "function") return fail(registry, "missing-validator", "promise");
  try {
    const result = validatePromiseOwners(input.maxPromiseOwners);
    if (result.status !== "ok") {
      try {
        registry.promiseOwnerValidationFailed = true;
      } catch {
        // The authoritative validation latch is closure-owned; a read-only debug
        // surface may reject direct writes. The returned failure is sufficient.
      }
    }
    return result;
  } catch {
    return fail(registry, "inspection-threw", "promise");
  }

  function fail(
    target: RuntimeRegistry,
    reason: string,
    authority: "promise" | "shadow",
  ): { readonly status: "failed"; readonly reason: string } {
    try {
      if (authority === "shadow") {
        target.shadowRootAuthorityFailed = true;
      } else {
        target.promiseOwnerValidationFailed = true;
      }
    } catch {
      // Best effort only: validation must fail closed even if page-visible debug
      // fields are immutable or accessor-backed.
    }
    return { status: "failed", reason };
  }
}

const SENSITIVE_EVIDENCE_MUTATION_NOTIFICATION_FUNCTION = "__qualigenceSensitiveEvidenceMutationObserved";

async function installSensitiveEvidenceRuntime(page: Page, mutationNotificationFunction: string): Promise<void> {
  if (typeof page.addInitScript !== "function") return;
  await page.addInitScript((input: {
    readonly shadowRootsProperty: string;
    readonly evidenceStateProperty: string;
    readonly mutationNotificationFunction: string;
    readonly maxShadowRoots: number;
    readonly maxSchedulerRegistrationsPerEpoch: number;
    readonly maxSchedulerRegistrationsPerSession: number;
    readonly maxPromiseOwners: number;
  }) => {
    type PromiseMethodName = "then" | "catch" | "finally";
    type DescriptorSnapshot =
      | { readonly present: false }
      | {
        readonly present: true;
        readonly kind: "data";
        readonly configurable: boolean;
        readonly enumerable: boolean;
        readonly writable: boolean;
        readonly value: unknown;
      }
      | {
        readonly present: true;
        readonly kind: "accessor";
        readonly configurable: boolean;
        readonly enumerable: boolean;
        readonly get: unknown;
        readonly set: unknown;
      };
    type ResolvedMethodOwnerSnapshot =
      | { readonly present: false }
      | { readonly present: true; readonly owner: object };
    type PromiseOwnerRecord = {
      readonly owner: object;
      readonly prototype: object | null;
      readonly descriptors: Readonly<Record<PromiseMethodName, DescriptorSnapshot>>;
      readonly resolvedMethodOwners: Readonly<Record<PromiseMethodName, ResolvedMethodOwnerSnapshot>>;
    };
    type PromiseOwnerValidationResult = { readonly status: "ok" | "failed"; readonly reason?: string };
    type NativeDomAuthority = {
      readonly arrayFrom: typeof Array.from;
      readonly arrayIsArray: typeof Array.isArray;
      readonly htmlCollectionItem: (index: number) => Element | null;
      readonly htmlCollectionLengthGet: (() => number) | undefined;
      readonly htmlOptionsCollectionItem: (index: number) => HTMLOptionElement | null;
      readonly htmlOptionsCollectionLengthGet: (() => number) | undefined;
      readonly nodeListItem: (index: number) => Node | null;
      readonly nodeListLengthGet: (() => number) | undefined;
      readonly objectDefineProperty: typeof Object.defineProperty;
      readonly reflectApply: typeof Reflect.apply;
      readonly stringIncludes: typeof String.prototype.includes;
      readonly stringNormalize: typeof String.prototype.normalize;
      readonly stringReplace: typeof String.prototype.replace;
      readonly stringToLowerCase: typeof String.prototype.toLowerCase;
      readonly stringTrim: typeof String.prototype.trim;
      readonly weakMap: WeakMapConstructor;
      readonly weakMapGet: typeof WeakMap.prototype.get;
      readonly weakMapSet: typeof WeakMap.prototype.set;
      readonly cssStyleDeclarationGetPropertyValue: typeof CSSStyleDeclaration.prototype.getPropertyValue;
      readonly documentGetElementById: typeof Document.prototype.getElementById;
      readonly documentQuerySelector: typeof Document.prototype.querySelector;
      readonly documentQuerySelectorAll: typeof Document.prototype.querySelectorAll;
      readonly documentTitleGet: (() => string) | undefined;
      readonly documentFragmentQuerySelectorAll: typeof DocumentFragment.prototype.querySelectorAll;
      readonly elementClosest: typeof Element.prototype.closest;
      readonly elementGetAttribute: typeof Element.prototype.getAttribute;
      readonly elementGetClientRects: typeof Element.prototype.getClientRects;
      readonly elementHasAttribute: typeof Element.prototype.hasAttribute;
      readonly elementQuerySelectorAll: typeof Element.prototype.querySelectorAll;
      readonly elementRemoveAttribute: typeof Element.prototype.removeAttribute;
      readonly elementSetAttribute: typeof Element.prototype.setAttribute;
      readonly elementShadowRootGet: (() => ShadowRoot | null) | undefined;
      readonly elementTagNameGet: (() => string) | undefined;
      readonly htmlElementHiddenGet: (() => boolean) | undefined;
      readonly htmlInputElementPlaceholderGet: (() => string) | undefined;
      readonly htmlInputElementValueGet: (() => string) | undefined;
      readonly htmlOptionElementLabelGet: (() => string) | undefined;
      readonly htmlOptionElementTextGet: (() => string) | undefined;
      readonly htmlOptionElementValueGet: (() => string) | undefined;
      readonly htmlSelectElementOptionsGet: (() => HTMLOptionsCollection) | undefined;
      readonly htmlSelectElementSelectedOptionsGet: (() => HTMLCollectionOf<HTMLOptionElement>) | undefined;
      readonly htmlSelectElementValueGet: (() => string) | undefined;
      readonly htmlTextAreaElementPlaceholderGet: (() => string) | undefined;
      readonly htmlTextAreaElementValueGet: (() => string) | undefined;
      readonly nodeChildNodesGet: (() => NodeListOf<ChildNode>) | undefined;
      readonly nodeContains: typeof Node.prototype.contains;
      readonly nodeGetRootNode: typeof Node.prototype.getRootNode;
      readonly nodeParentElementGet: (() => HTMLElement | null) | undefined;
      readonly nodeTextContentGet: (() => string | null) | undefined;
      readonly characterDataDataGet: (() => string) | undefined;
      readonly shadowRootHostGet: (() => Element) | undefined;
      readonly shadowRootModeGet: (() => ShadowRootMode) | undefined;
      readonly windowGetComputedStyle: typeof window.getComputedStyle;
    };
    type SensitiveRuntimeRegistry = {
      readonly roots: readonly ShadowRoot[];
      readonly listenerTargets: { readonly type: string; readonly target: EventTarget; readonly listener: EventListenerOrEventListenerObject }[];
      readonly nativeDom?: NativeDomAuthority;
      readonly promiseOwners?: readonly PromiseOwnerRecord[];
      shadowRootOverflow: boolean;
      readonly promiseOwnerOverflow?: boolean;
      readonly promiseOwnerValidationFailed?: boolean;
      readonly validatePromiseOwners?: (maxPromiseOwners: number) => PromiseOwnerValidationResult;
      readonly retainSensitiveSchedulerEpoch?: (epoch: SensitiveSchedulerEpoch) => void;
      readonly sensitiveSchedulerRegistrationCount?: (epoch: SensitiveSchedulerEpoch) => number;
      readonly sensitiveSchedulerRetirementStatus?: () => "retired" | "pending" | "unavailable";
      readonly validateShadowRootAuthority?: () => PromiseOwnerValidationResult;
      readonly shadowRootAuthorityFailed?: boolean;
      readonly originalAddEventListener: typeof EventTarget.prototype.addEventListener;
      readonly originalSetTimeout: typeof window.setTimeout;
      readonly originalSetInterval: typeof window.setInterval;
      readonly originalRequestAnimationFrame: typeof window.requestAnimationFrame;
      readonly originalQueueMicrotask: typeof window.queueMicrotask;
      readonly originalPromiseThen: typeof Promise.prototype.then;
      readonly originalPromiseCatch: typeof Promise.prototype.catch;
      readonly originalPromiseFinally: typeof Promise.prototype.finally;
    };
    type PendingSchedulerCallback = {
      settled: boolean;
      readonly settles: boolean;
      readonly retainObjectResult: boolean;
      retainedAfterReturn: boolean;
    };
    type SensitiveSchedulerEpoch = {
      schedulerRegistrations?: number;
      pendingSchedulerCallbacks?: number;
      retainedSchedulerCallbacks?: number;
      inSchedulerCallback?: boolean;
      poisoned?: boolean;
      processSchedulerCallback?: () => void;
    };
    type SensitiveSchedulerEpochAuthority = {
      schedulerRegistrations: number;
      pendingSchedulerCallbacks: number;
      retainedSchedulerCallbacks: number;
      inSchedulerCallback: boolean;
      poisoned: boolean;
    };
    type SensitiveRuntimeState = {
      active?: SensitiveSchedulerEpoch | null;
      poisoned?: boolean;
      schedulerSessionRegistrations?: number;
      retainedSchedulerEpochs?: SensitiveSchedulerEpoch[];
    };
    type InternalPromiseThenCall = {
      readonly receiver: unknown;
      readonly onfulfilled?: unknown;
      readonly onrejected?: unknown;
      readonly epoch: SensitiveSchedulerEpoch | undefined;
      readonly wrapHandlers: boolean;
      consumed: boolean;
    };
    const promiseMethods: readonly PromiseMethodName[] = ["then", "catch", "finally"];
    const nativeArrayIsArray: typeof Array.isArray = Array.isArray;
    const nativeArrayPrototypeFind: typeof Array.prototype.find = Array.prototype.find;
    const nativeArrayPrototypeIncludes: typeof Array.prototype.includes = Array.prototype.includes;
    const nativeArrayPrototypeLastIndexOf: typeof Array.prototype.lastIndexOf = Array.prototype.lastIndexOf;
    const nativeArrayPrototypePush: typeof Array.prototype.push = Array.prototype.push;
    const nativeArrayPrototypeSlice: typeof Array.prototype.slice = Array.prototype.slice;
    const nativeArrayPrototypeSplice: typeof Array.prototype.splice = Array.prototype.splice;
    const NativeSet = Set;
    const nativeSetPrototypeAdd: typeof Set.prototype.add = Set.prototype.add;
    const nativeSetPrototypeHas: typeof Set.prototype.has = Set.prototype.has;
    const nativeObjectAssign: typeof Object.assign = Object.assign;
    const nativeObjectDefineProperties: typeof Object.defineProperties = Object.defineProperties;
    const nativeObjectDefineProperty: typeof Object.defineProperty = Object.defineProperty;
    const nativeObjectFreeze: typeof Object.freeze = Object.freeze;
    const nativeObjectGetOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
    const nativeNodeListItem: (index: number) => Node | null = NodeList.prototype.item;
    const nativeNodeListLengthGet = nativeObjectGetOwnPropertyDescriptor(NodeList.prototype, "length")?.get;
    const nativeHTMLCollectionItem: (index: number) => Element | null = HTMLCollection.prototype.item;
    const nativeHTMLCollectionLengthGet = nativeObjectGetOwnPropertyDescriptor(HTMLCollection.prototype, "length")?.get;
    const nativeHTMLOptionsCollectionItem: (index: number) => HTMLOptionElement | null = HTMLOptionsCollection.prototype.item ?? HTMLCollection.prototype.item;
    const nativeHTMLOptionsCollectionLengthGet = nativeObjectGetOwnPropertyDescriptor(HTMLOptionsCollection.prototype, "length")?.get ?? nativeHTMLCollectionLengthGet;
    const nativeObjectGetPrototypeOf: typeof Object.getPrototypeOf = Object.getPrototypeOf;
    const nativeObjectSetPrototypeOf: typeof Object.setPrototypeOf = Object.setPrototypeOf;
    const nativeObjectPrototypeHasOwnProperty: typeof Object.prototype.hasOwnProperty = Object.prototype.hasOwnProperty;
    const nativeReflectApply: typeof Reflect.apply = Reflect.apply;
    const nativeReflectDefineProperty: typeof Reflect.defineProperty = Reflect.defineProperty;
    const nativeReflectGet: typeof Reflect.get = Reflect.get;
    const nativeStringPrototypeIncludes: typeof String.prototype.includes = String.prototype.includes;
    const nativeStringPrototypeNormalize: typeof String.prototype.normalize = String.prototype.normalize;
    const nativeStringPrototypeReplace: typeof String.prototype.replace = String.prototype.replace;
    const nativeStringPrototypeToLowerCase: typeof String.prototype.toLowerCase = String.prototype.toLowerCase;
    const nativeStringPrototypeTrim: typeof String.prototype.trim = String.prototype.trim;
    const nativeReflectDeleteProperty: typeof Reflect.deleteProperty = Reflect.deleteProperty;
    const nativeReflectSet: typeof Reflect.set = Reflect.set;
    const nativeReflectSetPrototypeOf: typeof Reflect.setPrototypeOf = Reflect.setPrototypeOf;
    const NativeWeakMap: WeakMapConstructor = WeakMap;
    const nativeWeakMapPrototypeGet: typeof WeakMap.prototype.get = WeakMap.prototype.get;
    const nativeWeakMapPrototypeSet: typeof WeakMap.prototype.set = WeakMap.prototype.set;
    const nativeCssStyleDeclarationGetPropertyValue: typeof CSSStyleDeclaration.prototype.getPropertyValue = CSSStyleDeclaration.prototype.getPropertyValue;
    const nativeDocumentGetElementById: typeof Document.prototype.getElementById = Document.prototype.getElementById;
    const nativeDocumentQuerySelector: typeof Document.prototype.querySelector = Document.prototype.querySelector;
    const nativeDocumentQuerySelectorAll: typeof Document.prototype.querySelectorAll = Document.prototype.querySelectorAll;
    const nativeDocumentTitleGet = nativeObjectGetOwnPropertyDescriptor(Document.prototype, "title")?.get;
    const nativeDocumentFragmentQuerySelectorAll: typeof DocumentFragment.prototype.querySelectorAll = DocumentFragment.prototype.querySelectorAll;
    const nativeElementAttachShadow: typeof Element.prototype.attachShadow = Element.prototype.attachShadow;
    const nativeElementClosest: typeof Element.prototype.closest = Element.prototype.closest;
    const nativeElementGetAttribute: typeof Element.prototype.getAttribute = Element.prototype.getAttribute;
    const nativeElementGetClientRects: typeof Element.prototype.getClientRects = Element.prototype.getClientRects;
    const nativeElementHasAttribute: typeof Element.prototype.hasAttribute = Element.prototype.hasAttribute;
    const nativeElementQuerySelectorAll: typeof Element.prototype.querySelectorAll = Element.prototype.querySelectorAll;
    const nativeElementRemoveAttribute: typeof Element.prototype.removeAttribute = Element.prototype.removeAttribute;
    const nativeElementSetAttribute: typeof Element.prototype.setAttribute = Element.prototype.setAttribute;
    const nativeElementShadowRootGet = nativeObjectGetOwnPropertyDescriptor(Element.prototype, "shadowRoot")?.get;
    const nativeElementTagNameGet = nativeObjectGetOwnPropertyDescriptor(Element.prototype, "tagName")?.get;
    const nativeHTMLElementHiddenGet = nativeObjectGetOwnPropertyDescriptor(HTMLElement.prototype, "hidden")?.get;
    const nativeHTMLInputElementPlaceholderGet = nativeObjectGetOwnPropertyDescriptor(HTMLInputElement.prototype, "placeholder")?.get;
    const nativeHTMLInputElementValueGet = nativeObjectGetOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.get;
    const nativeHTMLOptionElementLabelGet = nativeObjectGetOwnPropertyDescriptor(HTMLOptionElement.prototype, "label")?.get;
    const nativeHTMLOptionElementTextGet = nativeObjectGetOwnPropertyDescriptor(HTMLOptionElement.prototype, "text")?.get;
    const nativeHTMLOptionElementValueGet = nativeObjectGetOwnPropertyDescriptor(HTMLOptionElement.prototype, "value")?.get;
    const nativeHTMLSelectElementOptionsGet = nativeObjectGetOwnPropertyDescriptor(HTMLSelectElement.prototype, "options")?.get;
    const nativeHTMLSelectElementSelectedOptionsGet = nativeObjectGetOwnPropertyDescriptor(HTMLSelectElement.prototype, "selectedOptions")?.get;
    const nativeHTMLSelectElementValueGet = nativeObjectGetOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.get;
    const nativeHTMLTextAreaElementPlaceholderGet = nativeObjectGetOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "placeholder")?.get;
    const nativeHTMLTextAreaElementValueGet = nativeObjectGetOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.get;
    const nativeNodeChildNodesGet = nativeObjectGetOwnPropertyDescriptor(Node.prototype, "childNodes")?.get;
    const nativeNodeContains: typeof Node.prototype.contains = Node.prototype.contains;
    const nativeNodeGetRootNode: typeof Node.prototype.getRootNode = Node.prototype.getRootNode;
    const nativeNodeParentElementGet = nativeObjectGetOwnPropertyDescriptor(Node.prototype, "parentElement")?.get;
    const nativeNodeTextContentGet = nativeObjectGetOwnPropertyDescriptor(Node.prototype, "textContent")?.get;
    const nativeCharacterDataDataGet = nativeObjectGetOwnPropertyDescriptor(CharacterData.prototype, "data")?.get;
    const nativeShadowRootHostGet = nativeObjectGetOwnPropertyDescriptor(ShadowRoot.prototype, "host")?.get;
    const nativeShadowRootModeGet = nativeObjectGetOwnPropertyDescriptor(ShadowRoot.prototype, "mode")?.get;
    const nativeWindowGetComputedStyle: typeof window.getComputedStyle = window.getComputedStyle;
    const NativeProxy: ProxyConstructor = Proxy;
    const nativeDomAuthority = nativeObjectFreeze({
      arrayFrom: Array.from,
      arrayIsArray: Array.isArray,
      htmlCollectionItem: nativeHTMLCollectionItem,
      htmlCollectionLengthGet: nativeHTMLCollectionLengthGet,
      htmlOptionsCollectionItem: nativeHTMLOptionsCollectionItem,
      htmlOptionsCollectionLengthGet: nativeHTMLOptionsCollectionLengthGet,
      nodeListItem: nativeNodeListItem,
      nodeListLengthGet: nativeNodeListLengthGet,
      objectDefineProperty: nativeObjectDefineProperty,
      reflectApply: nativeReflectApply,
      stringIncludes: nativeStringPrototypeIncludes,
      stringNormalize: nativeStringPrototypeNormalize,
      stringReplace: nativeStringPrototypeReplace,
      stringToLowerCase: nativeStringPrototypeToLowerCase,
      stringTrim: nativeStringPrototypeTrim,
      weakMap: NativeWeakMap,
      weakMapGet: nativeWeakMapPrototypeGet,
      weakMapSet: nativeWeakMapPrototypeSet,
      cssStyleDeclarationGetPropertyValue: nativeCssStyleDeclarationGetPropertyValue,
      documentGetElementById: nativeDocumentGetElementById,
      documentQuerySelector: nativeDocumentQuerySelector,
      documentQuerySelectorAll: nativeDocumentQuerySelectorAll,
      documentTitleGet: nativeDocumentTitleGet,
      documentFragmentQuerySelectorAll: nativeDocumentFragmentQuerySelectorAll,
      elementClosest: nativeElementClosest,
      elementGetAttribute: nativeElementGetAttribute,
      elementGetClientRects: nativeElementGetClientRects,
      elementHasAttribute: nativeElementHasAttribute,
      elementQuerySelectorAll: nativeElementQuerySelectorAll,
      elementRemoveAttribute: nativeElementRemoveAttribute,
      elementSetAttribute: nativeElementSetAttribute,
      elementShadowRootGet: nativeElementShadowRootGet,
      elementTagNameGet: nativeElementTagNameGet,
      htmlElementHiddenGet: nativeHTMLElementHiddenGet,
      htmlInputElementPlaceholderGet: nativeHTMLInputElementPlaceholderGet,
      htmlInputElementValueGet: nativeHTMLInputElementValueGet,
      htmlOptionElementLabelGet: nativeHTMLOptionElementLabelGet,
      htmlOptionElementTextGet: nativeHTMLOptionElementTextGet,
      htmlOptionElementValueGet: nativeHTMLOptionElementValueGet,
      htmlSelectElementOptionsGet: nativeHTMLSelectElementOptionsGet,
      htmlSelectElementSelectedOptionsGet: nativeHTMLSelectElementSelectedOptionsGet,
      htmlSelectElementValueGet: nativeHTMLSelectElementValueGet,
      htmlTextAreaElementPlaceholderGet: nativeHTMLTextAreaElementPlaceholderGet,
      htmlTextAreaElementValueGet: nativeHTMLTextAreaElementValueGet,
      nodeChildNodesGet: nativeNodeChildNodesGet,
      nodeContains: nativeNodeContains,
      nodeGetRootNode: nativeNodeGetRootNode,
      nodeParentElementGet: nativeNodeParentElementGet,
      nodeTextContentGet: nativeNodeTextContentGet,
      characterDataDataGet: nativeCharacterDataDataGet,
      shadowRootHostGet: nativeShadowRootHostGet,
      shadowRootModeGet: nativeShadowRootModeGet,
      windowGetComputedStyle: nativeWindowGetComputedStyle,
    });
    const intrinsicAuthorityFailed = [
      nativeArrayIsArray,
      nativeArrayPrototypeFind,
      nativeArrayPrototypeIncludes,
      nativeArrayPrototypeLastIndexOf,
      nativeArrayPrototypePush,
      nativeArrayPrototypeSlice,
      nativeArrayPrototypeSplice,
      nativeNodeListItem,
      nativeNodeListLengthGet,
      nativeHTMLCollectionItem,
      nativeHTMLCollectionLengthGet,
      nativeHTMLOptionsCollectionItem,
      nativeHTMLOptionsCollectionLengthGet,
      NativeSet,
      nativeSetPrototypeAdd,
      nativeSetPrototypeHas,
      nativeObjectAssign,
      nativeObjectDefineProperties,
      nativeObjectDefineProperty,
      nativeObjectFreeze,
      nativeObjectGetOwnPropertyDescriptor,
      nativeObjectGetPrototypeOf,
      nativeObjectSetPrototypeOf,
      nativeObjectPrototypeHasOwnProperty,
      nativeReflectApply,
      nativeReflectDefineProperty,
      nativeReflectGet,
      nativeStringPrototypeIncludes,
      nativeStringPrototypeNormalize,
      nativeStringPrototypeReplace,
      nativeStringPrototypeToLowerCase,
      nativeStringPrototypeTrim,
      nativeReflectDeleteProperty,
      nativeReflectSet,
      nativeReflectSetPrototypeOf,
      NativeWeakMap,
      nativeWeakMapPrototypeGet,
      nativeWeakMapPrototypeSet,
      nativeCssStyleDeclarationGetPropertyValue,
      nativeDocumentGetElementById,
      nativeDocumentQuerySelector,
      nativeDocumentQuerySelectorAll,
      nativeDocumentFragmentQuerySelectorAll,
      nativeElementClosest,
      nativeElementGetAttribute,
      nativeElementGetClientRects,
      nativeElementHasAttribute,
      nativeElementQuerySelectorAll,
      nativeElementRemoveAttribute,
      nativeElementSetAttribute,
      nativeElementAttachShadow,
      nativeNodeGetRootNode,
      nativeWindowGetComputedStyle,
      NativeProxy,
      nativeDomAuthority.arrayFrom,
      nativeDomAuthority.arrayIsArray,
      nativeDomAuthority.htmlCollectionItem,
      nativeDomAuthority.htmlCollectionLengthGet,
      nativeDomAuthority.htmlOptionsCollectionItem,
      nativeDomAuthority.htmlOptionsCollectionLengthGet,
      nativeDomAuthority.nodeListItem,
      nativeDomAuthority.nodeListLengthGet,
      nativeDomAuthority.objectDefineProperty,
      nativeDomAuthority.reflectApply,
      nativeDomAuthority.stringIncludes,
      nativeDomAuthority.stringNormalize,
      nativeDomAuthority.stringReplace,
      nativeDomAuthority.stringToLowerCase,
      nativeDomAuthority.stringTrim,
      nativeDomAuthority.weakMap,
      nativeDomAuthority.weakMapGet,
      nativeDomAuthority.weakMapSet,
      nativeDomAuthority.cssStyleDeclarationGetPropertyValue,
      nativeDomAuthority.documentTitleGet,
      nativeDomAuthority.elementShadowRootGet,
      nativeDomAuthority.elementTagNameGet,
      nativeDomAuthority.htmlElementHiddenGet,
      nativeDomAuthority.htmlInputElementPlaceholderGet,
      nativeDomAuthority.htmlInputElementValueGet,
      nativeDomAuthority.htmlOptionElementLabelGet,
      nativeDomAuthority.htmlOptionElementTextGet,
      nativeDomAuthority.htmlOptionElementValueGet,
      nativeDomAuthority.htmlSelectElementOptionsGet,
      nativeDomAuthority.htmlSelectElementSelectedOptionsGet,
      nativeDomAuthority.htmlSelectElementValueGet,
      nativeDomAuthority.htmlTextAreaElementPlaceholderGet,
      nativeDomAuthority.htmlTextAreaElementValueGet,
      nativeDomAuthority.nodeChildNodesGet,
      nativeDomAuthority.nodeContains,
      nativeDomAuthority.nodeParentElementGet,
      nativeDomAuthority.nodeTextContentGet,
      nativeDomAuthority.characterDataDataGet,
      nativeDomAuthority.shadowRootHostGet,
      nativeDomAuthority.shadowRootModeGet,
    ].some((fn) => typeof fn !== "function");
    const win = window as unknown as Record<string, SensitiveRuntimeRegistry | undefined>;
    if (win[input.shadowRootsProperty] !== undefined) return;
    const notifySensitiveEvidenceMutation = (window as unknown as Record<string, unknown>)[input.mutationNotificationFunction];
    const promiseOwnerRecords: PromiseOwnerRecord[] = [];
    const schedulerEpochAuthority = new NativeWeakMap<SensitiveSchedulerEpoch, SensitiveSchedulerEpochAuthority>();
    const retainedSensitiveSchedulerEpochs: SensitiveSchedulerEpoch[] = [];
    const trackedShadowRoots: ShadowRoot[] = [];
    let shadowRootOverflow = false;
    let promiseOwnerOverflow = false;
    let promiseOwnerValidationFailed = intrinsicAuthorityFailed;
    let shadowRootAuthorityFailed = intrinsicAuthorityFailed;
    const registry = {
      listenerTargets: [],
      originalAddEventListener: EventTarget.prototype.addEventListener,
      originalSetTimeout: window.setTimeout,
      originalSetInterval: window.setInterval,
      originalRequestAnimationFrame: window.requestAnimationFrame,
      originalQueueMicrotask: window.queueMicrotask,
      originalPromiseThen: Promise.prototype.then,
      originalPromiseCatch: Promise.prototype.catch,
      originalPromiseFinally: Promise.prototype.finally,
    } as unknown as SensitiveRuntimeRegistry;
    nativeObjectDefineProperties(registry, {
      roots: {
        configurable: false,
        enumerable: false,
        get: shadowRootSnapshot,
        set: replaceShadowRootSnapshot,
      },
      shadowRootOverflow: {
        configurable: false,
        enumerable: false,
        get: () => shadowRootOverflow,
        set: setShadowRootOverflow,
      },
      promiseOwners: {
        configurable: false,
        enumerable: false,
        get: promiseOwnerDebugSnapshot,
      },
      promiseOwnerOverflow: {
        configurable: false,
        enumerable: false,
        get: () => promiseOwnerOverflow,
      },
      promiseOwnerValidationFailed: {
        configurable: false,
        enumerable: false,
        get: () => promiseOwnerValidationFailed,
      },
      nativeDom: {
        configurable: false,
        enumerable: false,
        value: nativeDomAuthority,
        writable: false,
      },
      validatePromiseOwners: {
        configurable: false,
        enumerable: false,
        value: validatePromiseOwnerRecords,
        writable: false,
      },
      retainSensitiveSchedulerEpoch: {
        configurable: false,
        enumerable: false,
        value: retainSensitiveSchedulerEpoch,
        writable: false,
      },
      sensitiveSchedulerRegistrationCount: {
        configurable: false,
        enumerable: false,
        value: sensitiveSchedulerRegistrationCount,
        writable: false,
      },
      sensitiveSchedulerRetirementStatus: {
        configurable: false,
        enumerable: false,
        value: sensitiveSchedulerRetirementStatus,
        writable: false,
      },
      validateShadowRootAuthority: {
        configurable: false,
        enumerable: false,
        value: validateShadowRootAuthority,
        writable: false,
      },
      shadowRootAuthorityFailed: {
        configurable: false,
        enumerable: false,
        get: () => shadowRootAuthorityFailed,
      },
    });
    nativeObjectDefineProperty(win, input.shadowRootsProperty, {
      configurable: false,
      enumerable: false,
      value: registry,
      writable: false,
    });
    const trackedAttachShadow = function attachShadow(this: Element, init: ShadowRootInit): ShadowRoot {
      const root = nativeReflectApply(nativeElementAttachShadow, this, [init]) as ShadowRoot;
      const state = sensitiveState();
      const active = state === undefined ? undefined : currentSensitiveEpoch(state);
      if (init.mode === "closed" && state !== undefined && active !== undefined) {
        poison(state, active);
      }
      registerShadowRoot(root, state, active);
      return root;
    };
    const attachShadowGetter = function attachShadow(): typeof Element.prototype.attachShadow {
      return trackedAttachShadow;
    };
    const attachShadowSetter = function attachShadow(_value: unknown): void {
      latchShadowRootAuthorityFailure();
    };
    if (!nativeReflectDefineProperty(Element.prototype, "attachShadow", {
      configurable: false,
      enumerable: false,
      get: attachShadowGetter,
      set: attachShadowSetter,
    })) {
      latchShadowRootAuthorityFailure();
    }
    EventTarget.prototype.addEventListener = function addEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ): void {
      const isSensitiveInstrumentation = listener !== null &&
        (typeof listener === "function" || typeof listener === "object") &&
        (listener as unknown as Record<string, unknown>).__qualigenceSensitiveInstrumentation === true;
      if ((type === "input" || type === "change") && listener !== null && !isSensitiveInstrumentation) {
        arrayPush(registry.listenerTargets, { type, target: this, listener });
      }
      nativeReflectApply(registry.originalAddEventListener, this, [type, listener, options]);
    };

    window.setTimeout = function setTimeout(handler: TimerHandler, timeout?: number, ...args: unknown[]): number {
      const epoch = countSensitiveSchedulerRegistration();
      const wrapped = typeof handler === "function" && epoch !== undefined
        ? wrapSchedulerCallback(handler as (...callbackArgs: unknown[]) => unknown, epoch, true)
        : handler;
      poisonUnwrappedSensitiveSchedulerCallback(epoch, handler);
      return nativeReflectApply(registry.originalSetTimeout as (...callArgs: unknown[]) => number, window, [
        wrapped,
        timeout,
        ...args,
      ]) as number;
    } as typeof window.setTimeout;
    window.setInterval = function setInterval(handler: TimerHandler, timeout?: number, ...args: unknown[]): number {
      const epoch = countSensitiveSchedulerRegistration();
      const wrapped = typeof handler === "function" && epoch !== undefined
        ? wrapSchedulerCallback(handler as (...callbackArgs: unknown[]) => unknown, epoch, false)
        : handler;
      poisonUnwrappedSensitiveSchedulerCallback(epoch, handler);
      return nativeReflectApply(registry.originalSetInterval as (...callArgs: unknown[]) => number, window, [
        wrapped,
        timeout,
        ...args,
      ]) as number;
    } as typeof window.setInterval;
    window.requestAnimationFrame = function requestAnimationFrame(callback: FrameRequestCallback): number {
      const epoch = countSensitiveSchedulerRegistration();
      return nativeReflectApply(
        registry.originalRequestAnimationFrame,
        window,
        [epoch === undefined ? callback : wrapSchedulerCallback(callback, epoch, true)],
      ) as number;
    };
    window.queueMicrotask = function queueMicrotask(callback: VoidFunction): void {
      const epoch = countSensitiveSchedulerRegistration();
      nativeReflectApply(
        registry.originalQueueMicrotask,
        window,
        [epoch === undefined ? callback : wrapSchedulerCallback(callback, epoch, true)],
      );
    };
    const internalPromiseThenCalls: InternalPromiseThenCall[] = [];
    const retainedInternalPromiseThenCalls: InternalPromiseThenCall[] = [];

    const instrumentedPromiseThen = function then<TResult1 = unknown, TResult2 = never>(
      this: unknown,
      onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
      "use strict";
      const internalCall = consumeInternalPromiseThenCall(this, onfulfilled, onrejected);
      const epoch = internalCall === undefined
        ? countSensitiveSchedulerRegistration()
        : internalCall.epoch;
      registerPromiseMethodAuthority(this, "then", epoch);
      const wrapHandlers = internalCall?.wrapHandlers ?? true;
      const handlers = epoch === undefined || !wrapHandlers
        ? { onfulfilled, onrejected }
        : wrapPromiseReactionHandlers(onfulfilled, onrejected, epoch);
      try {
        return nativeReflectApply(
          registry.originalPromiseThen,
          this,
          [handlers.onfulfilled, handlers.onrejected],
        ) as Promise<TResult1 | TResult2>;
      } catch (error) {
        if ("pending" in handlers && handlers.pending !== undefined) {
          settlePendingSchedulerCallback(epoch, handlers.pending);
        }
        throw error;
      }
    };
    definePromisePrototypeMethod("then", instrumentedPromiseThen);
    const instrumentedPromiseCatch = function promiseCatch<TResult = never>(
      this: unknown,
      onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
    ): Promise<unknown | TResult> {
      "use strict";
      const epoch = countSensitiveSchedulerRegistration();
      registerPromiseMethodAuthority(this, "catch", epoch);
      return invokePromiseThen(this, undefined, onrejected, epoch, true) as Promise<unknown | TResult>;
    };
    definePromisePrototypeMethod("catch", instrumentedPromiseCatch);
    const instrumentedPromiseFinally = function promiseFinally(this: unknown, onfinally?: (() => void) | null): Promise<unknown> {
      "use strict";
      const receiver = this;
      const epoch = countSensitiveSchedulerRegistration();
      registerPromiseMethodAuthority(receiver, "finally", epoch);
      const C = promiseSpeciesConstructor(receiver);
      const finallyHandler = epoch === undefined || typeof onfinally !== "function"
        ? { callback: onfinally }
        : wrapPromiseFinallyHandler(onfinally, epoch);
      const finallyCallback = finallyHandler.callback;
      const onFulfilled = typeof finallyCallback === "function"
        ? (value: unknown) => {
          const result = finallyCallback();
          const promise = promiseResolve(C, result);
          const continuation = invokePromiseThenResult(promise, () => value, undefined, epoch, false);
          retainReturnedPromiseAssimilation(continuation, epoch);
          return continuation.value;
        }
        : finallyCallback;
      const onRejected = typeof finallyCallback === "function"
        ? (reason: unknown) => {
          const result = finallyCallback();
          const promise = promiseResolve(C, result);
          const continuation = invokePromiseThenResult(promise, () => { throw reason; }, undefined, epoch, false);
          retainReturnedPromiseAssimilation(continuation, epoch);
          return continuation.value;
        }
        : finallyCallback;
      try {
        return invokePromiseThen(receiver, onFulfilled, onRejected, epoch, false) as Promise<unknown>;
      } catch (error) {
        if ("pending" in finallyHandler && finallyHandler.pending !== undefined) {
          settlePendingSchedulerCallback(epoch, finallyHandler.pending);
        }
        throw error;
      }
    };
    definePromisePrototypeMethod("finally", instrumentedPromiseFinally);
    installPromiseOwnerMutationGuards();

    function withInternalPromiseThenCall<T>(call: InternalPromiseThenCall, operation: () => T): T {
      arrayPush(internalPromiseThenCalls, call);
      try {
        return operation();
      } finally {
        const index = arrayLastIndexOf(internalPromiseThenCalls, call);
        if (index !== -1) arraySplice(internalPromiseThenCalls, index, 1);
      }
    }

    function consumeInternalPromiseThenCall(
      receiver: unknown,
      onfulfilled: unknown,
      onrejected: unknown,
    ): InternalPromiseThenCall | undefined {
      const stacked = consumeMatchingInternalPromiseThenCall(internalPromiseThenCalls, receiver, onfulfilled, onrejected);
      if (stacked !== undefined) return stacked;
      return consumeMatchingInternalPromiseThenCall(retainedInternalPromiseThenCalls, receiver, onfulfilled, onrejected);
    }

    function consumeMatchingInternalPromiseThenCall(
      calls: InternalPromiseThenCall[],
      receiver: unknown,
      onfulfilled: unknown,
      onrejected: unknown,
    ): InternalPromiseThenCall | undefined {
      for (let index = calls.length - 1; index >= 0; index -= 1) {
        const call = calls[index]!;
        if (call.consumed || call.receiver !== receiver) continue;
        const fulfilledMatches = call.onfulfilled === undefined || call.onfulfilled === onfulfilled;
        const rejectedMatches = call.onrejected === undefined || call.onrejected === onrejected;
        if (!fulfilledMatches || !rejectedMatches) continue;
        call.consumed = true;
        if (calls === retainedInternalPromiseThenCalls) arraySplice(calls, index, 1);
        return call;
      }
      return undefined;
    }

    function definePromisePrototypeMethod(method: PromiseMethodName, value: unknown): void {
      const descriptor = nativeObjectGetOwnPropertyDescriptor(Promise.prototype, method);
      if (descriptor === undefined || !("value" in descriptor || "writable" in descriptor)) {
        latchPromiseOwnerValidationFailure();
        return;
      }
      nativeObjectDefineProperty(Promise.prototype, method, {
        configurable: descriptor.configurable === true,
        enumerable: descriptor.enumerable === true,
        writable: descriptor.writable === true,
        value,
      });
    }

    function installPromiseOwnerMutationGuards(): void {
      replaceDataFunction(Object, "assign", function assign(target: object, source?: unknown): object {
        const sources = nativeReflectApply(nativeArrayPrototypeSlice, arguments, [1]) as unknown[];
        const additionalSources = nativeReflectApply(nativeArrayPrototypeSlice, sources, [1]) as unknown[];
        const approvedPromiseOwnerTarget = isApprovedPromiseOwner(target);
        try {
          const result = nativeObjectAssign(target, source, ...additionalSources);
          noteObjectAssignMutations(target, sources, false);
          return result;
        } catch (error) {
          noteObjectAssignMutations(target, sources, approvedPromiseOwnerTarget);
          throw error;
        }
      });
      replaceDataFunction(Object, "defineProperty", function defineProperty<T>(target: T, propertyKey: PropertyKey, attributes: PropertyDescriptor): T {
        const result = nativeObjectDefineProperty(target, propertyKey, attributes);
        notePromiseOwnerPropertyMutation(target, propertyKey);
        return result;
      });
      replaceDataFunction(Object, "defineProperties", function defineProperties<T>(target: T, properties: PropertyDescriptorMap & ThisType<unknown>): T {
        const approvedPromiseOwnerTarget = isApprovedPromiseOwner(target);
        try {
          const result = nativeObjectDefineProperties(target, properties);
          forEachPromiseMethod((method) => {
            if (hasOwnProperty(properties, method)) notePromiseOwnerPropertyMutation(target, method);
          });
          notePromiseOwnerMutationIfSnapshotChanged(target);
          return result;
        } catch (error) {
          notePromiseOwnerMutationIfSnapshotChanged(target);
          if (approvedPromiseOwnerTarget) notePromiseOwnerMutationIfApproved(target);
          throw error;
        }
      });
      replaceDataFunction(Object, "setPrototypeOf", function setPrototypeOf<T>(target: T, prototype: object | null): T {
        const result = nativeObjectSetPrototypeOf(target, prototype);
        notePromiseOwnerPrototypeMutation(target);
        return result;
      });
      replaceDataFunction(Reflect, "defineProperty", function defineProperty(target: object, propertyKey: PropertyKey, attributes: PropertyDescriptor): boolean {
        const changed = nativeReflectDefineProperty(target, propertyKey, attributes);
        if (changed) notePromiseOwnerPropertyMutation(target, propertyKey);
        return changed;
      });
      replaceDataFunction(Reflect, "deleteProperty", function deleteProperty(target: object, propertyKey: PropertyKey): boolean {
        const changed = nativeReflectDeleteProperty(target, propertyKey);
        if (changed) notePromiseOwnerPropertyMutation(target, propertyKey);
        return changed;
      });
      replaceDataFunction(Reflect, "set", function set(target: object, propertyKey: PropertyKey, value: unknown): boolean {
        const hasReceiver = arguments.length >= 4;
        const receiver = hasReceiver ? arguments[3] : undefined;
        const changed = hasReceiver
          ? nativeReflectSet(target, propertyKey, value, receiver)
          : nativeReflectSet(target, propertyKey, value);
        if (changed) {
          notePromiseOwnerPropertyMutation(target, propertyKey);
          if (hasReceiver) notePromiseOwnerPropertyMutation(receiver, propertyKey);
        }
        return changed;
      });
      replaceDataFunction(Reflect, "setPrototypeOf", function setPrototypeOf(target: object, prototype: object | null): boolean {
        const changed = nativeReflectSetPrototypeOf(target, prototype);
        if (changed) notePromiseOwnerPrototypeMutation(target);
        return changed;
      });
    }

    function replaceDataFunction(owner: object, propertyKey: PropertyKey, value: unknown): void {
      const descriptor = nativeObjectGetOwnPropertyDescriptor(owner, propertyKey);
      if (descriptor === undefined || !("value" in descriptor || "writable" in descriptor)) return;
      nativeObjectDefineProperty(owner, propertyKey, {
        configurable: descriptor.configurable === true,
        enumerable: descriptor.enumerable === true,
        writable: descriptor.writable === true,
        value,
      });
    }

    function noteObjectAssignMutations(target: unknown, sources: readonly unknown[], failedAfterPartialMutationBoundary: boolean): void {
      try {
        for (let index = 0; index < sources.length; index += 1) {
          noteObjectAssignMutation(target, sources[index]);
        }
        notePromiseOwnerMutationIfSnapshotChanged(target);
      } catch {
        notePromiseOwnerMutationIfSnapshotChanged(target);
        if (failedAfterPartialMutationBoundary) notePromiseOwnerMutationIfApproved(target);
      }
    }

    function noteObjectAssignMutation(target: unknown, source: unknown): void {
      if (!isObjectLike(source)) return;
      forEachPromiseMethod((method) => {
        const descriptor = nativeObjectGetOwnPropertyDescriptor(source, method);
        if (descriptor?.enumerable === true) notePromiseOwnerPropertyMutation(target, method);
      });
    }

    function notePromiseOwnerPropertyMutation(target: unknown, propertyKey: PropertyKey): void {
      if (!isPromiseMethodName(propertyKey)) return;
      notePromiseOwnerMutation(target);
    }

    function isApprovedPromiseOwner(target: unknown): boolean {
      return isObjectLike(target) && findPromiseOwnerRecord(target) !== undefined;
    }

    function notePromiseOwnerPrototypeMutation(target: unknown): void {
      notePromiseOwnerMutation(target);
    }

    function notePromiseOwnerMutation(target: unknown): void {
      if (!isObjectLike(target)) return;
      if (findPromiseOwnerRecord(target) === undefined) return;
      latchPromiseOwnerValidationFailure();
      const state = sensitiveState();
      const active = state === undefined ? undefined : currentSensitiveEpoch(state);
      if (state !== undefined && active !== undefined) poison(state, active);
    }

    function notePromiseOwnerMutationIfApproved(target: unknown): void {
      notePromiseOwnerMutation(target);
    }

    function notePromiseOwnerMutationIfSnapshotChanged(target: unknown): void {
      if (!isObjectLike(target)) return;
      const record = findPromiseOwnerRecord(target);
      if (record === undefined) return;
      try {
        if (!samePromiseOwnerRecord(snapshotPromiseOwner(target), record)) notePromiseOwnerMutation(target);
      } catch {
        notePromiseOwnerMutation(target);
      }
    }

    function latchPromiseOwnerValidationFailure(): void {
      promiseOwnerValidationFailed = true;
      notifyHostSensitiveEvidenceMutation();
    }

    function notifyHostSensitiveEvidenceMutation(): void {
      if (typeof notifySensitiveEvidenceMutation !== "function") return;
      try {
        const notified = nativeReflectApply(notifySensitiveEvidenceMutation as () => unknown, window, []);
        if (isObjectLike(notified)) {
          nativeReflectApply(registry.originalPromiseCatch, notified, [() => undefined]);
        }
      } catch {
        // The host can already be closing when an asynchronous page signal
        // resolves. Page-local validation remains latched for the current
        // document and close is the only supported way to clear host state.
      }
    }

    function isPromiseMethodName(propertyKey: PropertyKey): propertyKey is PromiseMethodName {
      return propertyKey === "then" || propertyKey === "catch" || propertyKey === "finally";
    }

    function hasOwnProperty(owner: object, propertyKey: PropertyKey): boolean {
      return nativeReflectApply(nativeObjectPrototypeHasOwnProperty, owner, [propertyKey]) as boolean;
    }

    function arrayFind<T>(array: readonly T[], predicate: (value: T) => boolean): T | undefined {
      return nativeReflectApply(nativeArrayPrototypeFind, array, [predicate]) as T | undefined;
    }

    function arrayIncludes<T>(array: readonly T[], value: T): boolean {
      return nativeReflectApply(nativeArrayPrototypeIncludes, array, [value]) as boolean;
    }

    function arrayLastIndexOf<T>(array: readonly T[], value: T): number {
      return nativeReflectApply(nativeArrayPrototypeLastIndexOf, array, [value]) as number;
    }

    function arrayPush<T>(array: T[], value: T): void {
      nativeReflectApply(nativeArrayPrototypePush, array, [value]);
    }

    function arraySplice<T>(array: T[], start: number, deleteCount: number): void {
      nativeReflectApply(nativeArrayPrototypeSplice, array, [start, deleteCount]);
    }

    function setHas<T>(set: Set<T>, value: T): boolean {
      return nativeReflectApply(nativeSetPrototypeHas, set, [value]) as boolean;
    }

    function setAdd<T>(set: Set<T>, value: T): void {
      nativeReflectApply(nativeSetPrototypeAdd, set, [value]);
    }

    function forEachPromiseMethod(operation: (method: PromiseMethodName) => void): void {
      for (let index = 0; index < promiseMethods.length; index += 1) {
        operation(promiseMethods[index]!);
      }
    }

    function sensitiveState(): SensitiveRuntimeState | undefined {
      return (window as unknown as Record<string, SensitiveRuntimeState | undefined>)[input.evidenceStateProperty];
    }

    function latchShadowRootAuthorityFailure(): void {
      shadowRootAuthorityFailed = true;
      const state = sensitiveState();
      const active = state === undefined ? undefined : currentSensitiveEpoch(state);
      if (state !== undefined) state.poisoned = true;
      if (state !== undefined && active !== undefined) poison(state, active);
    }

    function registerShadowRoot(
      root: ShadowRoot,
      state: SensitiveRuntimeState | undefined,
      active: SensitiveSchedulerEpoch | undefined,
    ): void {
      if (arrayIncludes(trackedShadowRoots, root)) return;
      if (trackedShadowRoots.length >= input.maxShadowRoots) {
        shadowRootOverflow = true;
        if (state !== undefined) state.poisoned = true;
        if (state !== undefined && active !== undefined) poison(state, active);
        return;
      }
      arrayPush(trackedShadowRoots, root);
    }

    function shadowRootSnapshot(): readonly ShadowRoot[] {
      const snapshot: ShadowRoot[] = [];
      for (let index = 0; index < trackedShadowRoots.length; index += 1) {
        snapshot[index] = trackedShadowRoots[index]!;
      }
      return new NativeProxy(snapshot, shadowRootSnapshotHandler);
    }

    function replaceShadowRootSnapshot(_value: unknown): void {
      latchShadowRootAuthorityFailure();
    }

    function setShadowRootOverflow(_value: unknown): void {
      shadowRootOverflow = true;
      latchShadowRootAuthorityFailure();
    }

    function shadowRootSnapshotMutationAttempt(): unknown {
      latchShadowRootAuthorityFailure();
      return undefined;
    }

    function isShadowRootSnapshotMutator(property: string | symbol): boolean {
      return property === "copyWithin" ||
        property === "fill" ||
        property === "pop" ||
        property === "push" ||
        property === "reverse" ||
        property === "shift" ||
        property === "sort" ||
        property === "splice" ||
        property === "unshift";
    }

    const shadowRootSnapshotHandler: ProxyHandler<ShadowRoot[]> = nativeObjectFreeze({
      get(target: ShadowRoot[], property: string | symbol, receiver: unknown): unknown {
        if (isShadowRootSnapshotMutator(property)) return shadowRootSnapshotMutationAttempt;
        return nativeReflectGet(target, property, receiver);
      },
      set(): boolean {
        latchShadowRootAuthorityFailure();
        return true;
      },
      defineProperty(_target: ShadowRoot[], property: string | symbol): boolean {
        latchShadowRootAuthorityFailure();
        return property !== "length";
      },
      deleteProperty(_target: ShadowRoot[], property: string | symbol): boolean {
        latchShadowRootAuthorityFailure();
        return property !== "length";
      },
      setPrototypeOf(): boolean {
        latchShadowRootAuthorityFailure();
        return false;
      },
      preventExtensions(): boolean {
        latchShadowRootAuthorityFailure();
        return false;
      },
    });

    function validateShadowRootAuthority(): PromiseOwnerValidationResult {
      const descriptor = nativeObjectGetOwnPropertyDescriptor(Element.prototype, "attachShadow");
      const rootsDescriptor = nativeObjectGetOwnPropertyDescriptor(registry, "roots");
      const overflowDescriptor = nativeObjectGetOwnPropertyDescriptor(registry, "shadowRootOverflow");
      if (
        shadowRootAuthorityFailed ||
        shadowRootOverflow ||
        descriptor === undefined ||
        descriptor.configurable !== false ||
        descriptor.get !== attachShadowGetter ||
        descriptor.set !== attachShadowSetter ||
        rootsDescriptor === undefined ||
        rootsDescriptor.configurable !== false ||
        rootsDescriptor.get !== shadowRootSnapshot ||
        rootsDescriptor.set !== replaceShadowRootSnapshot ||
        overflowDescriptor === undefined ||
        overflowDescriptor.configurable !== false ||
        overflowDescriptor.get === undefined ||
        overflowDescriptor.set !== setShadowRootOverflow
      ) {
        latchShadowRootAuthorityFailure();
        return { status: "failed", reason: "shadow-root-authority-mutated" };
      }
      return { status: "ok" };
    }

    function registerPromiseMethodAuthority(
      receiver: unknown,
      method: PromiseMethodName,
      epoch: SensitiveSchedulerEpoch | undefined,
    ): void {
      const state = sensitiveState();
      if (state === undefined || epoch === undefined || !shouldTrackPromiseOwnerAuthority(state) || !isObjectLike(receiver)) {
        return;
      }
      try {
        const owners = traversedMethodOwners(receiver, method);
        for (let index = 0; index < owners.length; index += 1) {
          registerPromiseOwner(owners[index]!, state, epoch);
        }
      } catch {
        latchPromiseOwnerValidationFailure();
        poison(state, epoch);
      }
    }

    function shouldTrackPromiseOwnerAuthority(state: SensitiveRuntimeState): boolean {
      // Production sensitive-evidence epochs created by the action executor carry
      // `records`. Counter-only oracle epochs intentionally omit it so Ticket 42
      // native Promise trap/order tests remain side-effect-free.
      return nativeArrayIsArray((state as { readonly records?: unknown }).records);
    }

    function traversedMethodOwners(receiver: object, method: PromiseMethodName): object[] {
      const owners: object[] = [];
      const visited = new NativeSet<object>();
      let current: object | null = receiver;
      while (current !== null) {
        if (setHas(visited, current)) throw new Error("cyclic-prototype-chain");
        setAdd(visited, current);
        arrayPush(owners, current);
        if (hasOwnProperty(current, method)) break;
        current = nativeObjectGetPrototypeOf(current);
      }
      return owners;
    }

    function registerPromiseOwner(owner: object, state: SensitiveRuntimeState, epoch: SensitiveSchedulerEpoch): void {
      if (intrinsicAuthorityFailed) {
        latchPromiseOwnerValidationFailure();
        poison(state, epoch);
        return;
      }
      const existingRecord = findPromiseOwnerRecord(owner);
      let snapshot: PromiseOwnerRecord;
      try {
        snapshot = snapshotPromiseOwner(owner);
      } catch {
        latchPromiseOwnerValidationFailure();
        poison(state, epoch);
        return;
      }
      if (existingRecord !== undefined) {
        if (!samePromiseOwnerRecord(snapshot, existingRecord)) {
          latchPromiseOwnerValidationFailure();
          poison(state, epoch);
        }
        return;
      }
      if (promiseOwnerRecords.length >= input.maxPromiseOwners) {
        promiseOwnerOverflow = true;
        latchPromiseOwnerValidationFailure();
        poison(state, epoch);
        return;
      }
      arrayPush(promiseOwnerRecords, snapshot);
    }

    function findPromiseOwnerRecord(owner: object): PromiseOwnerRecord | undefined {
      for (let index = 0; index < promiseOwnerRecords.length; index += 1) {
        const record = promiseOwnerRecords[index];
        if (record?.owner === owner) return record;
      }
      return undefined;
    }

    function snapshotPromiseOwner(owner: object): PromiseOwnerRecord {
      const descriptors = nativeObjectFreeze({
        then: nativeObjectFreeze(snapshotOwnDescriptor(owner, "then")),
        catch: nativeObjectFreeze(snapshotOwnDescriptor(owner, "catch")),
        finally: nativeObjectFreeze(snapshotOwnDescriptor(owner, "finally")),
      });
      const resolvedMethodOwners = nativeObjectFreeze({
        then: nativeObjectFreeze(snapshotResolvedMethodOwner(owner, "then")),
        catch: nativeObjectFreeze(snapshotResolvedMethodOwner(owner, "catch")),
        finally: nativeObjectFreeze(snapshotResolvedMethodOwner(owner, "finally")),
      });
      return nativeObjectFreeze({
        owner,
        prototype: nativeObjectGetPrototypeOf(owner),
        descriptors,
        resolvedMethodOwners,
      });
    }

    function promiseOwnerDebugSnapshot(): readonly PromiseOwnerRecord[] {
      const records: PromiseOwnerRecord[] = [];
      for (let index = 0; index < promiseOwnerRecords.length; index += 1) {
        records[index] = clonePromiseOwnerRecord(promiseOwnerRecords[index]!);
      }
      return nativeObjectFreeze(records);
    }

    function clonePromiseOwnerRecord(record: PromiseOwnerRecord): PromiseOwnerRecord {
      return nativeObjectFreeze({
        owner: record.owner,
        prototype: record.prototype,
        descriptors: nativeObjectFreeze({
          then: nativeObjectFreeze(cloneDescriptorSnapshot(record.descriptors.then)),
          catch: nativeObjectFreeze(cloneDescriptorSnapshot(record.descriptors.catch)),
          finally: nativeObjectFreeze(cloneDescriptorSnapshot(record.descriptors.finally)),
        }),
        resolvedMethodOwners: nativeObjectFreeze({
          then: nativeObjectFreeze(cloneResolvedMethodOwnerSnapshot(record.resolvedMethodOwners.then)),
          catch: nativeObjectFreeze(cloneResolvedMethodOwnerSnapshot(record.resolvedMethodOwners.catch)),
          finally: nativeObjectFreeze(cloneResolvedMethodOwnerSnapshot(record.resolvedMethodOwners.finally)),
        }),
      });
    }

    function cloneDescriptorSnapshot(snapshot: DescriptorSnapshot): DescriptorSnapshot {
      if (!snapshot.present) return { present: false };
      if (snapshot.kind === "data") {
        return {
          present: true,
          kind: "data",
          configurable: snapshot.configurable,
          enumerable: snapshot.enumerable,
          writable: snapshot.writable,
          value: snapshot.value,
        };
      }
      return {
        present: true,
        kind: "accessor",
        configurable: snapshot.configurable,
        enumerable: snapshot.enumerable,
        get: snapshot.get,
        set: snapshot.set,
      };
    }

    function cloneResolvedMethodOwnerSnapshot(snapshot: ResolvedMethodOwnerSnapshot): ResolvedMethodOwnerSnapshot {
      if (!snapshot.present) return { present: false };
      return { present: true, owner: snapshot.owner };
    }

    function snapshotOwnDescriptor(owner: object, method: PromiseMethodName): DescriptorSnapshot {
      const descriptor = nativeObjectGetOwnPropertyDescriptor(owner, method);
      if (descriptor === undefined) return { present: false };
      if ("value" in descriptor || "writable" in descriptor) {
        return {
          present: true,
          kind: "data",
          configurable: descriptor.configurable === true,
          enumerable: descriptor.enumerable === true,
          writable: descriptor.writable === true,
          value: descriptor.value,
        };
      }
      return {
        present: true,
        kind: "accessor",
        configurable: descriptor.configurable === true,
        enumerable: descriptor.enumerable === true,
        get: descriptor.get,
        set: descriptor.set,
      };
    }

    function snapshotResolvedMethodOwner(owner: object, method: PromiseMethodName): ResolvedMethodOwnerSnapshot {
      const visited = new NativeSet<object>();
      let current: object | null = owner;
      while (current !== null) {
        if (setHas(visited, current)) throw new Error("cyclic-prototype-chain");
        setAdd(visited, current);
        if (hasOwnProperty(current, method)) {
          return { present: true, owner: current };
        }
        current = nativeObjectGetPrototypeOf(current);
      }
      return { present: false };
    }

    function validatePromiseOwnerRecords(maxPromiseOwners: number): PromiseOwnerValidationResult {
      if (promiseOwnerOverflow || promiseOwnerValidationFailed) {
        latchPromiseOwnerValidationFailure();
        return { status: "failed", reason: "poisoned" };
      }
      if (promiseOwnerRecords.length > maxPromiseOwners) return failPromiseOwnerValidation("overflow-length");
      const seen = new NativeSet<object>();
      try {
        for (let index = 0; index < promiseOwnerRecords.length; index += 1) {
          if (!(index in promiseOwnerRecords)) return failPromiseOwnerValidation("incomplete-enumeration");
          const record = promiseOwnerRecords[index]!;
          if (!isObjectLike(record) || !isObjectLike(record.owner)) return failPromiseOwnerValidation("invalid-record");
          if (setHas(seen, record.owner)) return failPromiseOwnerValidation("duplicate-owner");
          setAdd(seen, record.owner);
          if (nativeObjectGetPrototypeOf(record.owner) !== record.prototype) return failPromiseOwnerValidation("prototype-mismatch");
          for (let methodIndex = 0; methodIndex < promiseMethods.length; methodIndex += 1) {
            const method = promiseMethods[methodIndex]!;
            if (!sameDescriptorSnapshot(snapshotOwnDescriptor(record.owner, method), record.descriptors[method])) {
              return failPromiseOwnerValidation(`${method}-descriptor-mismatch`);
            }
            if (!sameResolvedMethodOwner(snapshotResolvedMethodOwner(record.owner, method), record.resolvedMethodOwners[method])) {
              return failPromiseOwnerValidation(`${method}-owner-mismatch`);
            }
          }
        }
      } catch {
        return failPromiseOwnerValidation("inspection-threw");
      }
      return { status: "ok" };
    }

    function failPromiseOwnerValidation(reason: string): PromiseOwnerValidationResult {
      latchPromiseOwnerValidationFailure();
      return { status: "failed", reason };
    }

    function sameDescriptorSnapshot(left: DescriptorSnapshot, right: DescriptorSnapshot): boolean {
      if (left.present !== right.present) return false;
      if (!left.present || !right.present) return true;
      if (left.kind !== right.kind) return false;
      if (left.configurable !== right.configurable || left.enumerable !== right.enumerable) return false;
      if (left.kind === "data") {
        return right.kind === "data" && left.writable === right.writable && left.value === right.value;
      }
      return right.kind === "accessor" && left.get === right.get && left.set === right.set;
    }

    function sameResolvedMethodOwner(left: ResolvedMethodOwnerSnapshot, right: ResolvedMethodOwnerSnapshot): boolean {
      if (left.present !== right.present) return false;
      if (!left.present || !right.present) return true;
      return left.owner === right.owner;
    }

    function samePromiseOwnerRecord(left: PromiseOwnerRecord, right: PromiseOwnerRecord): boolean {
      if (left.owner !== right.owner || left.prototype !== right.prototype) return false;
      for (let index = 0; index < promiseMethods.length; index += 1) {
        const method = promiseMethods[index]!;
        if (!sameDescriptorSnapshot(left.descriptors[method], right.descriptors[method])) return false;
        if (!sameResolvedMethodOwner(left.resolvedMethodOwners[method], right.resolvedMethodOwners[method])) return false;
      }
      return true;
    }

    function invokePromiseThen(
      receiver: unknown,
      onfulfilled: unknown,
      onrejected: unknown,
      epoch: SensitiveSchedulerEpoch | undefined,
      wrapHandlers: boolean,
    ): unknown {
      return invokePromiseThenResult(receiver, onfulfilled, onrejected, epoch, wrapHandlers).value;
    }

    function invokePromiseThenResult(
      receiver: unknown,
      onfulfilled: unknown,
      onrejected: unknown,
      epoch: SensitiveSchedulerEpoch | undefined,
      wrapHandlers: boolean,
    ): { readonly value: unknown; readonly usedDefaultThen: boolean } {
      const then = (receiver as { readonly then?: unknown }).then;
      registerPromiseMethodAuthority(receiver, "then", epoch);
      const usedDefaultThen = isDefaultPromiseThenFunction(then);
      const internalCall = usedDefaultThen
        ? {
          receiver,
          onfulfilled,
          onrejected,
          epoch,
          wrapHandlers,
          consumed: false,
        }
        : undefined;
      const operation = () => callFunction(then, receiver, [onfulfilled, onrejected]);
      const value = internalCall === undefined
        ? operation()
        : withInternalPromiseThenCall(internalCall, operation);
      return { value, usedDefaultThen };
    }

    function retainReturnedPromiseAssimilation(
      continuation: { readonly value: unknown; readonly usedDefaultThen: boolean },
      epoch: SensitiveSchedulerEpoch | undefined,
    ): void {
      if (!continuation.usedDefaultThen || !isObjectLike(continuation.value)) return;
      arrayPush(retainedInternalPromiseThenCalls, {
        receiver: continuation.value,
        epoch,
        wrapHandlers: false,
        consumed: false,
      });
    }

    function isDefaultPromiseThenFunction(value: unknown): boolean {
      return value === instrumentedPromiseThen || value === registry.originalPromiseThen;
    }

    function callFunction(fn: unknown, thisArg: unknown, args: unknown[]): unknown {
      if (typeof fn !== "function") {
        throw nativeNonCallableThenError(fn);
      }
      return nativeReflectApply(fn as (...callArgs: unknown[]) => unknown, thisArg, args);
    }

    function promiseSpeciesConstructor(receiver: unknown): PromiseConstructor {
      if (!isObjectLike(receiver)) {
        throw nativeFinallyReceiverError(receiver);
      }
      const constructorValue = (receiver as { readonly constructor?: unknown }).constructor;
      if (constructorValue === undefined) return Promise;
      if (!isObjectLike(constructorValue)) {
        throw nativePromiseConstructorError(constructorValue);
      }
      const species = (constructorValue as { readonly [Symbol.species]?: unknown })[Symbol.species];
      if (species === undefined || species === null) return Promise;
      if (!isConstructor(species)) {
        throw nativePromiseSpeciesError(species);
      }
      return species as PromiseConstructor;
    }

    function nativeNonCallableThenError(then: unknown): unknown {
      try {
        nativeReflectApply(registry.originalPromiseCatch, { then }, [undefined]);
      } catch (error) {
        return error;
      }
      return new TypeError("Promise method is not callable");
    }

    function nativeFinallyReceiverError(receiver: unknown): unknown {
      try {
        nativeReflectApply(registry.originalPromiseFinally, receiver, [undefined]);
      } catch (error) {
        return error;
      }
      return new TypeError("Promise receiver is not an object");
    }

    function nativePromiseConstructorError(constructorValue: unknown): unknown {
      const probe = new Promise((resolve) => resolve(undefined));
      nativeObjectDefineProperty(probe, "constructor", {
        configurable: true,
        value: constructorValue,
      });
      try {
        nativeReflectApply(registry.originalPromiseThen, probe, [undefined, undefined]);
      } catch (error) {
        return error;
      }
      return new TypeError("Promise constructor is not an object");
    }

    function nativePromiseSpeciesError(species: unknown): unknown {
      const probe = new Promise((resolve) => resolve(undefined));
      nativeObjectDefineProperty(probe, "constructor", {
        configurable: true,
        value: { [Symbol.species]: species },
      });
      try {
        nativeReflectApply(registry.originalPromiseThen, probe, [undefined, undefined]);
      } catch (error) {
        return error;
      }
      return new TypeError("Promise species is not a constructor");
    }

    function promiseResolve(C: PromiseConstructor, value: unknown): unknown {
      if (isObjectLike(value) && value instanceof Promise && (value as { readonly constructor?: unknown }).constructor === C) {
        return value;
      }
      let resolveCapability: unknown;
      let rejectCapability: unknown;
      let executorCalled = false;
      const promise = new (C as unknown as new (executor: (resolve: unknown, reject: unknown) => void) => unknown)((resolve, reject) => {
        if (executorCalled) {
          throw new TypeError("Promise capability executor was already invoked");
        }
        executorCalled = true;
        resolveCapability = resolve;
        rejectCapability = reject;
      });
      if (typeof resolveCapability !== "function" || typeof rejectCapability !== "function") {
        throw new TypeError("Promise capability functions are not callable");
      }
      callFunction(resolveCapability, undefined, [value]);
      return promise;
    }

    function isConstructor(value: unknown): boolean {
      if (typeof value !== "function") return false;
      try {
        const constructorProbe = new Proxy(value as new () => object, {
          construct() {
            return {};
          },
        });
        new constructorProbe();
        return true;
      } catch {
        return false;
      }
    }

    function schedulerAuthority(epoch: SensitiveSchedulerEpoch): SensitiveSchedulerEpochAuthority {
      const existing = nativeReflectApply(nativeWeakMapPrototypeGet as (...args: unknown[]) => SensitiveSchedulerEpochAuthority | undefined, schedulerEpochAuthority, [epoch]) as SensitiveSchedulerEpochAuthority | undefined;
      if (existing !== undefined) return existing;
      const created: SensitiveSchedulerEpochAuthority = {
        schedulerRegistrations: typeof epoch.schedulerRegistrations === "number" ? epoch.schedulerRegistrations : 0,
        pendingSchedulerCallbacks: typeof epoch.pendingSchedulerCallbacks === "number" ? epoch.pendingSchedulerCallbacks : 0,
        retainedSchedulerCallbacks: typeof epoch.retainedSchedulerCallbacks === "number" ? epoch.retainedSchedulerCallbacks : 0,
        inSchedulerCallback: epoch.inSchedulerCallback === true,
        poisoned: epoch.poisoned === true,
      };
      nativeReflectApply(nativeWeakMapPrototypeSet as (...args: unknown[]) => WeakMap<SensitiveSchedulerEpoch, SensitiveSchedulerEpochAuthority>, schedulerEpochAuthority, [epoch, created]);
      return created;
    }

    function mirrorSchedulerAuthority(epoch: SensitiveSchedulerEpoch, authority: SensitiveSchedulerEpochAuthority): void {
      epoch.schedulerRegistrations = authority.schedulerRegistrations;
      epoch.pendingSchedulerCallbacks = authority.pendingSchedulerCallbacks;
      epoch.retainedSchedulerCallbacks = authority.retainedSchedulerCallbacks;
      epoch.inSchedulerCallback = authority.inSchedulerCallback;
      epoch.poisoned = authority.poisoned;
    }

    function retainSensitiveSchedulerEpoch(epoch: SensitiveSchedulerEpoch): void {
      schedulerAuthority(epoch);
      if (!arrayIncludes(retainedSensitiveSchedulerEpochs, epoch)) {
        arrayPush(retainedSensitiveSchedulerEpochs, epoch);
      }
    }

    function sensitiveSchedulerRegistrationCount(epoch: SensitiveSchedulerEpoch): number {
      return schedulerAuthority(epoch).schedulerRegistrations;
    }

    function sensitiveSchedulerRetirementStatus(): "retired" | "pending" | "unavailable" {
      for (let index = 0; index < retainedSensitiveSchedulerEpochs.length; index += 1) {
        const epoch = retainedSensitiveSchedulerEpochs[index]!;
        const authority = schedulerAuthority(epoch);
        if (authority.poisoned || epoch.poisoned === true) return "unavailable";
        if (authority.pendingSchedulerCallbacks > 0) return "pending";
      }
      return "retired";
    }

    function countSensitiveSchedulerRegistration(): SensitiveSchedulerEpoch | undefined {
      const state = sensitiveState();
      if (state === undefined) return undefined;
      const epoch = currentSensitiveEpoch(state);
      if (epoch === undefined) return undefined;
      const authority = schedulerAuthority(epoch);
      state.schedulerSessionRegistrations = (state.schedulerSessionRegistrations ?? 0) + 1;
      authority.schedulerRegistrations += 1;
      mirrorSchedulerAuthority(epoch, authority);
      if (
        authority.schedulerRegistrations > input.maxSchedulerRegistrationsPerEpoch ||
        state.schedulerSessionRegistrations > input.maxSchedulerRegistrationsPerSession
      ) {
        poison(state, epoch);
        return undefined;
      }
      return epoch;
    }

    function wrapPromiseReactionHandlers<TResult1, TResult2>(
      onfulfilled: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null | undefined,
      onrejected: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null | undefined,
      epoch: SensitiveSchedulerEpoch,
    ): {
      readonly onfulfilled: typeof onfulfilled;
      readonly onrejected: typeof onrejected;
      readonly pending?: PendingSchedulerCallback;
    } {
      if (typeof onfulfilled !== "function" && typeof onrejected !== "function") {
        return { onfulfilled, onrejected };
      }
      const reaction = beginPendingSchedulerCallback(epoch, true, true);
      return {
        onfulfilled: wrapSchedulerCallbackWithPending(
          typeof onfulfilled === "function"
            ? onfulfilled
            : ((value: unknown) => value),
          epoch,
          reaction,
        ) as typeof onfulfilled,
        onrejected: wrapSchedulerCallbackWithPending(
          typeof onrejected === "function"
            ? onrejected
            : ((reason: unknown) => { throw reason; }),
          epoch,
          reaction,
        ) as typeof onrejected,
        pending: reaction,
      };
    }

    function wrapPromiseFinallyHandler<T extends (...args: any[]) => unknown>(
      callback: T,
      epoch: SensitiveSchedulerEpoch,
    ): { readonly callback: T; readonly pending: PendingSchedulerCallback } {
      const pending = beginPendingSchedulerCallback(epoch, true, true);
      return {
        callback: wrapSchedulerCallbackWithPending(callback, epoch, pending),
        pending,
      };
    }

    function wrapSchedulerCallback<T extends (...args: any[]) => unknown>(callback: T, epoch: SensitiveSchedulerEpoch, settles: boolean): T {
      return wrapSchedulerCallbackWithPending(callback, epoch, beginPendingSchedulerCallback(epoch, settles, false));
    }

    function beginPendingSchedulerCallback(epoch: SensitiveSchedulerEpoch, settles: boolean, retainObjectResult: boolean): PendingSchedulerCallback {
      const authority = schedulerAuthority(epoch);
      authority.pendingSchedulerCallbacks += 1;
      mirrorSchedulerAuthority(epoch, authority);
      return { settled: false, settles, retainObjectResult, retainedAfterReturn: false };
    }

    function wrapSchedulerCallbackWithPending<T extends (...args: any[]) => unknown>(
      callback: T,
      epoch: SensitiveSchedulerEpoch,
      pending: PendingSchedulerCallback,
    ): T {
      return function sensitiveSchedulerCallback(this: unknown): unknown {
        "use strict";
        const args = nativeReflectApply(nativeArrayPrototypeSlice, arguments, []) as any[];
        const authority = schedulerAuthority(epoch);
        const previous = authority.inSchedulerCallback;
        authority.inSchedulerCallback = true;
        mirrorSchedulerAuthority(epoch, authority);
        let callbackResult: unknown;
        let callbackCompleted = false;
        try {
          callbackResult = nativeReflectApply(callback, this, args);
          callbackCompleted = true;
          return callbackResult;
        } finally {
          authority.inSchedulerCallback = previous;
          if (callbackCompleted && pending.retainObjectResult && isObjectLike(callbackResult)) {
            pending.retainedAfterReturn = true;
            authority.retainedSchedulerCallbacks += 1;
          }
          mirrorSchedulerAuthority(epoch, authority);
          processSchedulerCallbackEpoch(epoch);
          queuePendingSchedulerSettle(epoch, pending);
        }
      } as T;
    }

    function queuePendingSchedulerSettle(epoch: SensitiveSchedulerEpoch, pending: PendingSchedulerCallback): void {
      const settle = () => {
        try {
          processSchedulerCallbackEpoch(epoch);
        } finally {
          settlePendingSchedulerCallback(epoch, pending);
        }
      };
      if (pending.retainedAfterReturn) {
        queueMicrotaskAfterPromiseAssimilation(settle);
        return;
      }
      nativeReflectApply(registry.originalQueueMicrotask, window, [settle]);
    }

    function queueMicrotaskAfterPromiseAssimilation(callback: () => void): void {
      let remainingTurns = 8;
      const step = () => {
        remainingTurns -= 1;
        if (remainingTurns <= 0) {
          callback();
          return;
        }
        nativeReflectApply(registry.originalQueueMicrotask, window, [step]);
      };
      nativeReflectApply(registry.originalQueueMicrotask, window, [step]);
    }

    function settlePendingSchedulerCallback(epoch: SensitiveSchedulerEpoch | undefined, pending: PendingSchedulerCallback): void {
      if (epoch === undefined || !pending.settles || pending.settled) return;
      pending.settled = true;
      const authority = schedulerAuthority(epoch);
      if (pending.retainedAfterReturn) {
        authority.retainedSchedulerCallbacks = Math.max(0, authority.retainedSchedulerCallbacks - 1);
        pending.retainedAfterReturn = false;
      }
      authority.pendingSchedulerCallbacks = Math.max(0, authority.pendingSchedulerCallbacks - 1);
      mirrorSchedulerAuthority(epoch, authority);
    }

    function isObjectLike(value: unknown): value is object {
      return (typeof value === "object" && value !== null) || typeof value === "function";
    }

    function poisonUnwrappedSensitiveSchedulerCallback(epoch: SensitiveSchedulerEpoch | undefined, handler: TimerHandler): void {
      if (epoch === undefined || typeof handler === "function") return;
      const state = sensitiveState();
      if (state !== undefined) poison(state, epoch);
    }

    function currentSensitiveEpoch(state: SensitiveRuntimeState): SensitiveSchedulerEpoch | undefined {
      const active = state.active;
      if (active !== undefined && active !== null) return active;
      const retained = arrayFind(retainedSensitiveSchedulerEpochs, (candidate) => {
        const authority = schedulerAuthority(candidate);
        return authority.inSchedulerCallback || authority.retainedSchedulerCallbacks > 0;
      });
      if (retained !== undefined) return retained;
      return state.retainedSchedulerEpochs === undefined
        ? undefined
        : arrayFind(state.retainedSchedulerEpochs, (candidate) => {
          const authority = schedulerAuthority(candidate);
          return authority.inSchedulerCallback || authority.retainedSchedulerCallbacks > 0;
        });
    }

    function processSchedulerCallbackEpoch(epoch: SensitiveSchedulerEpoch): void {
      try {
        epoch.processSchedulerCallback?.();
      } catch {
        const state = sensitiveState();
        if (state !== undefined) poison(state, epoch);
      }
    }

    function poison(state: SensitiveRuntimeState, epoch: SensitiveSchedulerEpoch): void {
      state.poisoned = true;
      const authority = schedulerAuthority(epoch);
      authority.poisoned = true;
      mirrorSchedulerAuthority(epoch, authority);
    }
  }, {
    shadowRootsProperty: SENSITIVE_SHADOW_ROOTS_PROPERTY,
    evidenceStateProperty: SENSITIVE_EVIDENCE_STATE_PROPERTY,
    mutationNotificationFunction,
    maxShadowRoots: MAX_SENSITIVE_SHADOW_ROOTS,
    maxSchedulerRegistrationsPerEpoch: MAX_SENSITIVE_SCHEDULER_REGISTRATIONS_PER_EPOCH,
    maxSchedulerRegistrationsPerSession: MAX_SENSITIVE_SCHEDULER_REGISTRATIONS_PER_SESSION,
    maxPromiseOwners: MAX_SENSITIVE_PROMISE_OWNER_REGISTRY_OWNERS,
  });
}

export interface WebSessionOptions {
  readonly url: string;
  readonly expectedOrigin?: string;
  readonly headed: boolean;
  readonly navigationTimeoutMs: number;
  readonly actionTimeoutMs: number;
  readonly allowedOrigins: readonly string[];
  readonly allowedWebQueryKeys?: readonly string[];
}

/**
 * Test seam for injecting a fake browser in unit tests. Product code always
 * uses {@link chromiumLauncher}. This interface intentionally references the
 * Playwright `Browser` type; it is only reachable through the package's
 * internal (test-only) entry point, never through the public product surface.
 */
/** The finite time allowed for closing one repository-owned browser resource. */
export const BROWSER_CLOSE_TIMEOUT_MS = 5_000;

export interface BrowserProcessIdentity {
  readonly pid: number;
  isAlive(): boolean;
}

/**
 * A browser plus the exact process started for it. This is a test-only
 * lifecycle seam: it never exposes a Playwright object through the public
 * adapter surface, but lets platform tests prove that closing the adapter
 * reaps only the browser it launched.
 */
export interface BrowserLaunch {
  readonly browser: Browser;
  readonly process: BrowserProcessIdentity;
  /** Internal test-only deadline override for failure-injection coverage. */
  readonly closeTimeoutMs?: number;
  /** Exact-owned fallback only; never receives an arbitrary PID. */
  forceClose?(): Promise<void>;
  close(): Promise<void>;
}

export interface BrowserLauncher {
  launch(options: { readonly headless: boolean }): Promise<Browser>;
  /** Optional internal lifecycle extension used by real-browser platform tests. */
  launchWithLifecycle?(options: { readonly headless: boolean }): Promise<BrowserLaunch>;
}

export const chromiumLauncher: BrowserLauncher = {
  async launch(options): Promise<Browser> {
    const launched = await this.launchWithLifecycle!(options);
    return launched.browser;
  },
  async launchWithLifecycle(options): Promise<BrowserLaunch> {
    const server = await chromium.launchServer({ headless: options.headless });
    const child = server.process();
    const pid = child.pid;
    if (pid === undefined) {
      await server.close().catch(() => undefined);
      throw new Error("Chromium did not provide a process identity.");
    }
    try {
      const browser = await chromium.connect(server.wsEndpoint());
      return {
        browser,
        process: {
          pid,
          isAlive: () => child.exitCode === null && isPidAlive(pid),
        },
        async forceClose(): Promise<void> {
          await forceCloseOwnedBrowserChild(child);
        },
        async close(): Promise<void> {
          let firstError: Error | undefined;
          const record = (error: unknown): void => {
            if (firstError === undefined) firstError = error instanceof Error ? error : new Error(String(error));
          };
          // Close both exact resources concurrently so a hung Browser.close
          // cannot delay closing the owned launch server beyond the deadline.
          await Promise.all([
            closeWithinDeadline(() => browser.close()).catch(record),
            closeWithinDeadline(() => server.close()).catch(record),
          ]);
          if (firstError !== undefined) {
            await forceCloseOwnedBrowserChild(child).catch(record);
            throw firstError;
          }
        },
      };
    } catch (error) {
      await closeWithinDeadline(() => server.close()).catch(async (closeError) => {
        await forceCloseOwnedBrowserChild(child).catch(() => undefined);
        throw closeError;
      });
      throw error;
    }
  },
};

/**
 * Reap only the ChildProcess returned by this exact launchServer call. This
 * deliberately has no PID/name lookup fallback, so timeout recovery cannot
 * affect an unrelated Chromium process.
 */
async function forceCloseOwnedBrowserChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  try {
    child.kill("SIGKILL");
  } catch {
    // The handle may have exited between the check and the exact-child kill.
  }
  await closeWithinDeadline(() => waitForChildExit(child));
}

function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    child.once("exit", () => resolve());
    child.once("error", reject);
  });
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function closeWithinDeadline(close: () => Promise<void>, timeoutMs = BROWSER_CLOSE_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new WebTargetError("BrowserCloseTimedOut", "Repository-owned browser close timed out."));
    }, timeoutMs);
    void close().then(
      () => { clearTimeout(timeout); resolve(); },
      (error: unknown) => { clearTimeout(timeout); reject(error); },
    );
  });
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
}

interface RegisteredObservation extends StoredObservation {
  readonly navigationGeneration: number;
}

export class PlaywrightBrowserSession {
  private state: SessionState = "new";
  private startPromise?: Promise<void>;
  private browser: Browser | undefined;
  private browserLaunch: BrowserLaunch | undefined;
  private context: BrowserContext | undefined;
  private page: Page | undefined;
  private operation: Promise<unknown> = Promise.resolve();
  private navigationGeneration = 0;
  private crossOriginNavigationCount = 0;
  private observationOrdinal = 0;
  private latestGraph: string | undefined;
  private readonly observations = new Map<string, RegisteredObservation>();
  private readonly observationGenerations = new Map<string, number>();
  private readonly resolvedActionGenerations = new WeakMap<object, number>();
  private readonly sensitiveEvidence = new SensitiveEvidenceAuthority();
  private sensitiveDispatchOrdinal = 0;
  private sensitiveEvidenceUnavailable = false;
  private activeSensitiveDispatch: PreparedSensitiveEvidenceRecord | undefined;
  private pendingSensitiveCapture = false;
  private readonly pendingSensitiveCaptureMarkers = new Set<string>();
  private readonly configuredTargetUrl: string;
  private readonly configuredExpectedOrigin: string;

  constructor(
    private readonly options: WebSessionOptions,
    private readonly launcher: BrowserLauncher = chromiumLauncher,
  ) {
    this.configuredTargetUrl = options.url;
    this.configuredExpectedOrigin = options.expectedOrigin ?? options.url;
  }

  get allowedOrigins(): readonly string[] {
    return this.options.allowedOrigins;
  }

  get allowedWebQueryKeys(): readonly string[] {
    return this.options.allowedWebQueryKeys ?? [];
  }

  get actionTimeoutMs(): number {
    return this.options.actionTimeoutMs;
  }

  get navigationTimeoutMs(): number {
    return this.options.navigationTimeoutMs;
  }

  get targetUrl(): string {
    return this.configuredTargetUrl;
  }

  get currentNavigationGeneration(): number {
    return this.navigationGeneration;
  }

  get currentCrossOriginNavigationCount(): number {
    return this.crossOriginNavigationCount;
  }

  isTargetOrigin(url: string): boolean {
    try {
      return normalizeOrigin(url) === normalizeOrigin(this.configuredExpectedOrigin);
    } catch {
      return false;
    }
  }

  assertPageTargetOrigin(
    page: Pick<Page, "url">,
    expectedNavigationGeneration?: number,
  ): string {
    let currentUrl: string;
    try {
      currentUrl = page.url();
    } catch {
      throw new WebTargetError(
        "OriginViolation",
        "The current page origin could not be verified.",
      );
    }
    if (!this.isTargetOrigin(currentUrl)) {
      throw new WebTargetError(
        "OriginViolation",
        "The current page left the configured target origin.",
      );
    }
    if (
      expectedNavigationGeneration !== undefined &&
      this.navigationGeneration !== expectedNavigationGeneration
    ) {
      throw new WebTargetError(
        "OriginViolation",
        "The page navigated while its target origin was being verified.",
      );
    }
    return currentUrl;
  }

  async readOnExpectedOrigin<T>(
    page: Pick<Page, "url">,
    expectedNavigationGeneration: number,
    read: () => Promise<T>,
  ): Promise<T> {
    this.assertPageTargetOrigin(page, expectedNavigationGeneration);
    let value: T;
    try {
      value = await read();
    } catch (error) {
      this.assertPageTargetOrigin(page, expectedNavigationGeneration);
      throw error;
    }
    this.assertPageTargetOrigin(page, expectedNavigationGeneration);
    return value;
  }

  get latestGraphId(): string | undefined {
    return this.latestGraph;
  }

  nextObservationOrdinal(): number {
    this.observationOrdinal += 1;
    return this.observationOrdinal;
  }

  registerObservation(
    graphId: string,
    observation: StoredObservation,
    navigationGeneration = this.navigationGeneration,
  ): void {
    this.assertNavigationGeneration(navigationGeneration);
    this.observations.set(graphId, { ...observation, navigationGeneration });
    this.observationGenerations.set(graphId, navigationGeneration);
    this.latestGraph = graphId;
  }

  registerCapturedObservation(
    page: Pick<Page, "url">,
    graphId: string,
    observation: StoredObservation,
    navigationGeneration: number,
  ): void {
    this.assertPageTargetOrigin(page, navigationGeneration);
    this.registerObservation(graphId, observation, navigationGeneration);
    try {
      this.assertPageTargetOrigin(page, navigationGeneration);
    } catch (error) {
      this.observations.delete(graphId);
      if (this.latestGraph === graphId) this.latestGraph = undefined;
      throw error;
    }
  }

  hasGraph(graphId: string): boolean {
    return this.latestGraph === graphId &&
      this.observations.get(graphId)?.navigationGeneration === this.navigationGeneration;
  }

  descriptorFor(graphId: string, nodeId: string): LocatorDescriptor | undefined {
    const observation = this.requireCurrentObservation(graphId);
    return observation.descriptors.get(nodeId);
  }

  requireCurrentObservationGeneration(graphId: string): number {
    return this.requireCurrentObservation(graphId).navigationGeneration;
  }

  assertObservationGeneration(graphId: string, navigationGeneration: number): void {
    this.assertNavigationGeneration(navigationGeneration);
    const observation = this.requireCurrentObservation(graphId);
    if (observation.navigationGeneration !== navigationGeneration) {
      throw new WebTargetError(
        "OriginViolation",
        "The observation belongs to a different navigation generation.",
      );
    }
  }

  async readForObservation<T>(
    page: Pick<Page, "url">,
    graphId: string,
    navigationGeneration: number,
    read: () => Promise<T>,
  ): Promise<T> {
    this.assertObservationGeneration(graphId, navigationGeneration);
    try {
      const value = await this.readOnExpectedOrigin(page, navigationGeneration, read);
      this.assertObservationGeneration(graphId, navigationGeneration);
      return value;
    } catch (error) {
      this.assertObservationGeneration(graphId, navigationGeneration);
      throw error;
    }
  }

  bindResolvedAction<T extends object>(action: T, navigationGeneration: number): T {
    this.assertNavigationGeneration(navigationGeneration);
    this.resolvedActionGenerations.set(action, navigationGeneration);
    return action;
  }

  requireResolvedActionGeneration(action: object): number {
    const navigationGeneration = this.resolvedActionGenerations.get(action);
    if (navigationGeneration === undefined) {
      throw new WebTargetError(
        "OriginViolation",
        "The resolved action has no navigation-generation authority.",
      );
    }
    this.assertNavigationGeneration(navigationGeneration);
    return navigationGeneration;
  }

  invalidateObservations(): void {
    this.observations.clear();
    this.latestGraph = undefined;
  }

  artifactsFor(graphId: string): readonly CapturedArtifact[] {
    const observation = this.observations.get(graphId);
    if (observation === undefined) {
      throw new WebTargetError(
        "StaleObservation",
        `No observation registered for graph ${graphId}.`,
      );
    }
    this.assertNavigationGeneration(observation.navigationGeneration);
    if (this.page !== undefined) {
      this.assertPageTargetOrigin(this.page, observation.navigationGeneration);
    }
    return observation.artifacts;
  }

  prepareSensitiveEvidenceRecord(input: {
    readonly navigationGeneration: number;
    readonly nodeId: string;
    readonly sourceValue: string;
  }): PreparedSensitiveEvidenceRecord {
    this.assertNavigationGeneration(input.navigationGeneration);
    const dispatchOrdinal = this.nextSensitiveDispatchOrdinal();
    const result = this.sensitiveEvidence.prepare({
      navigationGeneration: input.navigationGeneration,
      dispatchOrdinal,
      nodeId: input.nodeId,
      sourceValue: input.sourceValue,
    });
    if (result.status === "failed" || result.value === undefined) {
      throw sensitiveEvidenceUnavailable();
    }
    return result.value;
  }

  beginSensitiveEvidenceDispatch(prepared: PreparedSensitiveEvidenceRecord): void {
    this.assertNavigationGeneration(prepared.navigationGeneration);
    this.assertSensitiveEvidenceAvailable();
    if (this.activeSensitiveDispatch !== undefined || this.pendingSensitiveCapture) {
      this.markSensitiveEvidenceUnavailable();
      throw sensitiveEvidenceUnavailable();
    }
    this.activeSensitiveDispatch = prepared;
  }

  cancelSensitiveEvidenceDispatch(prepared: PreparedSensitiveEvidenceRecord): void {
    if (this.activeSensitiveDispatch?.markerId === prepared.markerId) {
      this.activeSensitiveDispatch = undefined;
    }
  }

  abandonSensitiveEvidenceDispatch(prepared: PreparedSensitiveEvidenceRecord): void {
    this.cancelSensitiveEvidenceDispatch(prepared);
    this.markSensitiveEvidenceUnavailable();
  }

  completeSensitiveEvidenceRecord(
    prepared: PreparedSensitiveEvidenceRecord,
    observedForms: readonly string[],
    maskSnapshot: readonly SensitiveMaskSnapshotEntry[],
  ): void {
    this.assertNavigationGeneration(prepared.navigationGeneration);
    const result = this.sensitiveEvidence.complete(prepared, observedForms, maskSnapshot);
    this.cancelSensitiveEvidenceDispatch(prepared);
    if (result.status === "failed") {
      this.markSensitiveEvidenceUnavailable();
      return;
    }
    this.pendingSensitiveCapture = true;
    this.pendingSensitiveCaptureMarkers.clear();
    this.pendingSensitiveCaptureMarkers.add(prepared.markerId);
  }

  markSensitiveEvidenceUnavailable(): void {
    this.activeSensitiveDispatch = undefined;
    this.pendingSensitiveCapture = false;
    this.pendingSensitiveCaptureMarkers.clear();
    this.sensitiveEvidenceUnavailable = true;
  }

  assertSensitiveEvidenceAvailable(): void {
    if (this.sensitiveEvidenceUnavailable || this.activeSensitiveDispatch !== undefined) {
      throw sensitiveEvidenceUnavailable();
    }
  }

  async revalidateSensitivePromiseOwners(page: Page, navigationGeneration: number): Promise<void> {
    this.assertNavigationGeneration(navigationGeneration);
    this.assertPageTargetOrigin(page, navigationGeneration);
    this.assertSensitiveEvidenceAvailable();
    let result: { readonly status: "ok" | "failed"; readonly reason?: string };
    try {
      result = await page.evaluate(validateSensitivePromiseOwnerRegistryInPage, {
        runtimeRegistryProperty: SENSITIVE_SHADOW_ROOTS_PROPERTY,
        maxPromiseOwners: MAX_SENSITIVE_PROMISE_OWNER_REGISTRY_OWNERS,
      });
    } catch {
      this.markSensitiveEvidenceUnavailable();
      throw sensitiveEvidenceUnavailable();
    }
    this.assertNavigationGeneration(navigationGeneration);
    this.assertPageTargetOrigin(page, navigationGeneration);
    if (result.status !== "ok") {
      this.markSensitiveEvidenceUnavailable();
      throw sensitiveEvidenceUnavailable();
    }
    this.assertSensitiveEvidenceAvailable();
  }

  hasPendingSensitiveEvidenceCapture(): boolean {
    return this.pendingSensitiveCapture;
  }

  sensitiveMaskSnapshot(): readonly SensitiveMaskSnapshotEntry[] {
    this.assertSensitiveEvidenceAvailable();
    return this.sensitiveEvidence.maskSnapshot();
  }

  sensitiveEvidenceScanRecords(): readonly SensitiveEvidenceScanRecord[] {
    this.assertSensitiveEvidenceAvailable();
    return this.sensitiveEvidence.scanRecords();
  }

  pendingSensitiveMaskRefreshRequests(snapshot: SensitiveEvidencePageStateSnapshot): readonly SensitiveEvidenceMaskRefreshRequest[] {
    this.assertSensitiveEvidenceAvailable();
    if (!this.pendingSensitiveCapture) return [];
    const requests = this.sensitiveEvidence.pendingMaskRefreshRequests(snapshot, [...this.pendingSensitiveCaptureMarkers]);
    if (requests === undefined) {
      this.markSensitiveEvidenceUnavailable();
      throw sensitiveEvidenceUnavailable();
    }
    return requests;
  }

  refreshPendingSensitiveMaskSnapshot(markerId: string, maskSnapshot: readonly SensitiveMaskSnapshotEntry[]): void {
    this.assertSensitiveEvidenceAvailable();
    if (!this.pendingSensitiveCapture || !this.pendingSensitiveCaptureMarkers.has(markerId)) {
      this.markSensitiveEvidenceUnavailable();
      throw sensitiveEvidenceUnavailable();
    }
    if (!this.sensitiveEvidence.refreshPendingMaskSnapshot(markerId, maskSnapshot)) {
      this.markSensitiveEvidenceUnavailable();
      throw sensitiveEvidenceUnavailable();
    }
  }

  validatePendingSensitivePageState(snapshot: SensitiveEvidencePageStateSnapshot): void {
    this.assertSensitiveEvidenceAvailable();
    if (!this.pendingSensitiveCapture) return;
    if (!this.sensitiveEvidence.validatePendingPageState(snapshot, [...this.pendingSensitiveCaptureMarkers])) {
      this.markSensitiveEvidenceUnavailable();
      throw sensitiveEvidenceUnavailable();
    }
  }

  sensitiveMaskIdBelongsToAuthority(maskId: string | undefined): boolean {
    this.assertSensitiveEvidenceAvailable();
    return this.sensitiveEvidence.hasSensitiveMaskId(maskId);
  }

  completeSensitiveEvidenceCapture(): void {
    this.assertSensitiveEvidenceAvailable();
    this.pendingSensitiveCapture = false;
    this.pendingSensitiveCaptureMarkers.clear();
  }

  private resetSensitiveEvidenceForNavigation(): void {
    this.sensitiveEvidence.clear();
    this.sensitiveEvidenceUnavailable = false;
    this.activeSensitiveDispatch = undefined;
    this.pendingSensitiveCapture = false;
    this.pendingSensitiveCaptureMarkers.clear();
  }

  redactSensitiveTargetField(
    sensitiveTargetIds: readonly string[] | undefined,
    value: string,
    sensitiveMaskId?: string,
  ): string {
    this.assertSensitiveEvidenceAvailable();
    const result = this.sensitiveEvidence.redactField(sensitiveTargetIds, value, sensitiveMaskId);
    if (result.status === "unavailable") {
      this.markSensitiveEvidenceUnavailable();
      throw sensitiveEvidenceUnavailable();
    }
    return result.value;
  }

  redactSensitiveAccessibleNameField(
    sensitiveTargetIds: readonly string[] | undefined,
    value: string,
    sensitiveMaskId?: string,
  ): string {
    this.assertSensitiveEvidenceAvailable();
    const result = this.sensitiveEvidence.redactMetadataField(sensitiveTargetIds, value, sensitiveMaskId);
    if (result.status === "unavailable") {
      this.markSensitiveEvidenceUnavailable();
      throw sensitiveEvidenceUnavailable();
    }
    return result.value;
  }

  redactSensitiveTitleField(
    sensitiveTargetIds: readonly string[] | undefined,
    value: string,
    sensitiveMaskId?: string,
  ): string {
    this.assertSensitiveEvidenceAvailable();
    const result = this.sensitiveEvidence.redactMetadataField(sensitiveTargetIds, value, sensitiveMaskId);
    if (result.status === "unavailable") {
      this.markSensitiveEvidenceUnavailable();
      throw sensitiveEvidenceUnavailable();
    }
    return result.value;
  }

  async start(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
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
    this.startPromise = this.doStart(signal);
    return this.startPromise;
  }

  private async doStart(signal?: AbortSignal): Promise<void> {
    this.validateTarget();
    signal?.throwIfAborted();

    let browser: Browser;
    try {
      const launchWithLifecycle = this.launcher.launchWithLifecycle;
      if (launchWithLifecycle !== undefined) {
        const launched = await launchWithLifecycle.call(this.launcher, { headless: !this.options.headed });
        browser = launched.browser;
        this.browserLaunch = launched;
      } else {
        browser = await this.launcher.launch({ headless: !this.options.headed });
      }
      this.browser = browser;
      signal?.throwIfAborted();
    } catch (error) {
      await this.disposeResources();
      this.state = "closed";
      if (signal?.aborted) throw signal.reason;
      throw new WebTargetError(
        "BrowserLaunchFailed",
        error instanceof Error ? error.message : String(error),
      );
    }

    const startupCrossOriginNavigationCount = this.crossOriginNavigationCount;
    try {
      const context = await browser.newContext();
      this.context = context;
      signal?.throwIfAborted();
      context.setDefaultTimeout(this.options.actionTimeoutMs);
      context.setDefaultNavigationTimeout(this.options.navigationTimeoutMs);

      const page = await context.newPage();
      if (typeof page.exposeFunction === "function") {
        await page.exposeFunction(SENSITIVE_EVIDENCE_MUTATION_NOTIFICATION_FUNCTION, () => {
          this.markSensitiveEvidenceUnavailable();
        });
      }
      await installSensitiveEvidenceRuntime(page, SENSITIVE_EVIDENCE_MUTATION_NOTIFICATION_FUNCTION);
      this.page = page;
      page.on("framenavigated", (frame) => {
        if (frame !== page.mainFrame()) return;
        this.invalidateObservations();
        this.navigationGeneration += 1;
        this.resetSensitiveEvidenceForNavigation();
        try {
          if (!this.isTargetOrigin(frame.url())) this.crossOriginNavigationCount += 1;
        } catch {
          this.crossOriginNavigationCount += 1;
        }
      });
      signal?.throwIfAborted();

      await page.goto(this.configuredTargetUrl, {
        waitUntil: "domcontentloaded",
        timeout: this.options.navigationTimeoutMs,
      });
      this.assertPageTargetOrigin(page);
      if (this.crossOriginNavigationCount !== startupCrossOriginNavigationCount) {
        throw new WebTargetError(
          "OriginViolation",
          "Initial navigation left the configured target origin.",
        );
      }
      signal?.throwIfAborted();
    } catch (error) {
      await this.disposeResources();
      this.state = "closed";
      if (signal?.aborted) throw signal.reason;
      if (this.crossOriginNavigationCount !== startupCrossOriginNavigationCount) {
        throw new WebTargetError(
          "OriginViolation",
          "Initial navigation left the configured target origin.",
        );
      }
      throw this.toNavigationError(error);
    }

    this.state = "started";
  }

  private validateTarget(): void {
    let parsed: URL;
    try {
      parsed = new URL(this.configuredTargetUrl);
    } catch {
      throw new WebTargetError(
        "NavigationFailed",
        `Invalid target URL: ${this.configuredTargetUrl}`,
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

    let expectedOrigin: string;
    try {
      expectedOrigin = normalizeOrigin(this.configuredExpectedOrigin);
    } catch {
      throw new WebTargetError(
        "OriginViolation",
        "The configured Job target origin is invalid.",
      );
    }
    if (parsed.origin !== expectedOrigin) {
      throw new WebTargetError(
        "OriginViolation",
        "The navigation target does not match the configured Job target origin.",
      );
    }

    if (!this.options.allowedOrigins.includes(expectedOrigin)) {
      throw new WebTargetError(
        "OriginViolation",
        `Target origin ${parsed.origin} is not in the allowlist.`,
      );
    }
  }

  private nextSensitiveDispatchOrdinal(): number {
    this.sensitiveDispatchOrdinal += 1;
    return this.sensitiveDispatchOrdinal;
  }

  private assertNavigationGeneration(expectedNavigationGeneration: number): void {
    if (this.navigationGeneration !== expectedNavigationGeneration) {
      throw new WebTargetError(
        "OriginViolation",
        "The page navigation generation no longer matches the captured authority.",
      );
    }
  }

  private requireCurrentObservation(graphId: string): RegisteredObservation {
    const registeredGeneration = this.observationGenerations.get(graphId);
    if (
      registeredGeneration !== undefined &&
      registeredGeneration !== this.navigationGeneration
    ) {
      throw new WebTargetError(
        "OriginViolation",
        "The observation belongs to a prior navigation generation.",
      );
    }
    const observation = this.observations.get(graphId);
    if (this.latestGraph !== graphId || observation === undefined) {
      throw new WebTargetError(
        "StaleObservation",
        `No current observation is registered for graph ${graphId}.`,
      );
    }
    this.assertNavigationGeneration(observation.navigationGeneration);
    return observation;
  }

  private toNavigationError(error: unknown): WebTargetError {
    if (error instanceof WebTargetError) {
      return error;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (/timeout/i.test(message)) {
      return new WebTargetError("NavigationTimedOut", message);
    }
    return new WebTargetError("NavigationFailed", message);
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
      const startup = this.startPromise;
      this.state = "closing";
      const firstError = await this.disposeResources();
      void startup.finally(async () => {
        await this.disposeResources();
        this.state = "closed";
      }).catch(() => undefined);
      if (firstError) throw firstError;
      return;
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
    const recordUnlessClosedByOwner = (error: unknown): void => {
      if (error instanceof Error && error.message.includes("Target page, context or browser has been closed")) return;
      record(error);
    };

    const page = this.page;
    this.page = undefined;
    const context = this.context;
    this.context = undefined;
    const browser = this.browser;
    this.browser = undefined;
    const browserLaunch = this.browserLaunch;
    this.browserLaunch = undefined;
    this.resetSensitiveEvidenceForNavigation();

    // Start every owned close before awaiting any one of them. A hung page or
    // context close must not prevent disposal of the exact browser launch.
    await Promise.all([
      ...(page === undefined ? [] : [closeWithinDeadline(() => page.close()).catch(recordUnlessClosedByOwner)]),
      ...(context === undefined ? [] : [closeWithinDeadline(() => context.close()).catch(recordUnlessClosedByOwner)]),
      ...(browserLaunch !== undefined
        ? [closeWithinDeadline(() => browserLaunch.close(), browserLaunch.closeTimeoutMs).catch(async (error) => {
          record(error);
          if (browserLaunch.forceClose !== undefined) {
            await closeWithinDeadline(() => browserLaunch.forceClose!(), browserLaunch.closeTimeoutMs).catch(record);
          }
        })]
        : browser === undefined ? [] : [closeWithinDeadline(() => browser.close()).catch(record)]),
    ]);
    return firstError;
  }
}

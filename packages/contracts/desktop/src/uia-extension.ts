/**
 * `uia/v1` Observation extension contract (LS-13 / M3).
 *
 * Windows UI Automation carries semantics (AutomationId, ControlType, patterns,
 * framework) that do not fit the generic {@link ObservationNodeV1} shape. Rather
 * than widen the core Graph, LS-13 preserves them losslessly inside a versioned
 * extension keyed `uia/v1`. This is structurally the same forward-compatibility
 * mechanism as `@qualigence/observation-contracts`' {@link VersionedExtension}:
 * a consumer that requires the major must fail closed when it is absent, and one
 * that does not understand it may round-trip and ignore it.
 *
 * This PR only defines the contract type. Producing an actual `uia/v1` payload
 * from a captured desktop tree is PR-26 (the Windows UIA adapter).
 */

export type UiaPattern =
  | "Invoke"
  | "Value"
  | "Selection"
  | "SelectionItem"
  | "Scroll"
  | "ExpandCollapse"
  | "Toggle"
  | "Window";

export interface UiaPatternDescriptor {
  readonly pattern: UiaPattern;
  readonly available: boolean;
  readonly readOnly?: boolean;
}

export interface UiaExtensionV1 {
  readonly type: "uia/v1";
  readonly version: "1.0";
  readonly payload: {
    readonly automationId?: string;
    readonly controlTypeId: number;
    readonly frameworkId?: string;
    readonly className?: string;
    readonly nativeWindowHandle?: string;
    readonly processId: number;
    readonly isOffscreen: boolean;
    readonly isKeyboardFocusable: boolean;
    readonly hasKeyboardFocus: boolean;
    readonly patterns: readonly UiaPatternDescriptor[];
  };
}

export const UIA_EXTENSION_TYPE = "uia/v1";
export const UIA_EXTENSION_VERSION = "1.0";

export type DesktopActionKind = "click" | "input" | "select" | "scroll" | "window";

export interface DesktopAdapterCapabilities {
  readonly observationExtensions: readonly ["uia/v1"];
  readonly actionKinds: readonly DesktopActionKind[];
  readonly visualFallback: boolean;
  readonly coordinateFallback: boolean;
  readonly localApproval: true;
}

export interface AdapterSupport {
  readonly status: "supported" | "unsupported";
  readonly reasonCode?: string;
  readonly capabilities?: DesktopAdapterCapabilities;
}

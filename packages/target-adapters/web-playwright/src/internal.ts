/**
 * Internal, test-only entry point.
 *
 * This module exposes adapter internals (including the Playwright-aware
 * {@link BrowserLauncher} seam) to the package's own unit/component tests.
 * Product consumers and the composition root must import from the package
 * root (`.`) only, which never exposes Playwright types.
 */
export {
  PlaywrightBrowserSession,
  WebTargetError,
  chromiumLauncher,
  isOriginAllowed,
  normalizeOrigin,
  MAXIMUM_OBSERVATION_CANDIDATES,
  MAXIMUM_OBSERVATION_NODE_BYTES,
  MAXIMUM_OBSERVATION_SNAPSHOT_BYTES,
  MAXIMUM_OBSERVATION_SHADOW_ROOTS,
  MAXIMUM_OBSERVATION_DOM_ELEMENTS,
  MAXIMUM_SENSITIVE_ACTION_TARGETS,
  PRIVATE_TARGET_ATTRIBUTE,
  createBoundedCdpSession,
  inventoryPiercedDom,
  finalizeArtifactBatch,
  type BoundedCdpSession,
  type RawCdpSession,
  type BrowserLauncher,
  type BrowserSessionTestHooks,
  type SensitiveEvidenceDiagnosticReason,
  type SerializedArtifact,
  type StoredObservation,
  type SensitiveActionTarget,
  type WebSessionOptions,
  type WebTargetErrorCode,
} from "./browser-session.js";
export {
  buildObservationGraph,
  normalizeVisibleText,
  type BuiltObservation,
  type ObservationCandidate,
} from "./observation-builder.js";
export { PlaywrightObserver } from "./playwright-observer.js";
export { PlaywrightActionResolver } from "./playwright-action-resolver.js";
export { PlaywrightActionExecutor } from "./playwright-action-executor.js";
export {
  redactPngRectangles,
  type ScreenshotRectangle,
} from "./png-redactor.js";
export { actionToken, isActionToken } from "./action-token.js";
export type { CapturedArtifact, LocatorDescriptor } from "./types.js";
export {
  PlaywrightWebTargetAdapter,
  type WebTargetSession,
} from "./playwright-web-target-adapter.js";

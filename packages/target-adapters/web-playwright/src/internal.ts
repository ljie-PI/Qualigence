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
  type BrowserLauncher,
  type StoredObservation,
  type WebSessionOptions,
  type WebTargetErrorCode,
} from "./browser-session.js";
export {
  buildObservationGraph,
  normalizeVisibleText,
  type BuiltObservation,
  type ObservationCandidate,
} from "./observation-builder.js";
export {
  PlaywrightObserver,
  type PlaywrightObserverHooks,
} from "./playwright-observer.js";
export { PlaywrightActionResolver } from "./playwright-action-resolver.js";
export { PlaywrightActionExecutor } from "./playwright-action-executor.js";
export { actionToken, isActionToken } from "./action-token.js";
export type { CapturedArtifact, LocatorDescriptor } from "./types.js";
export {
  PlaywrightWebTargetAdapter,
  type WebTargetSession,
} from "./playwright-web-target-adapter.js";

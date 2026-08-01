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
  type WebSessionOptions,
  type WebTargetErrorCode,
} from "./browser-session.js";

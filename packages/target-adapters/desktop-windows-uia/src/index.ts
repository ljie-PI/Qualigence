export type { UiaSource, UiaSourceNode, UiaSourceBounds } from "./uia-source.js";

export {
  mapUiaPayloadToObservationV1,
  type MapUiaOptions,
} from "./uia-mapping.js";

export {
  DesktopExecutionError,
  type ActionOutcomeReport,
  type CompanionClient,
  type DesktopActionExecuteRequest,
  type DesktopExecutionErrorCode,
  type UiaCaptureRequest,
} from "./companion-client.js";

export { AppEnvironmentProvider } from "./app-environment-provider.js";

export {
  UiaActionResolver,
  UiaResolutionError,
  type UiaResolutionErrorCode,
  type UiaResolutionInput,
} from "./uia-action-resolver.js";

export {
  UiaActionExecutor,
  type UiaActionExecutorContext,
} from "./uia-action-executor.js";

export {
  WindowsDesktopAdapter,
  DESKTOP_WINDOWS_UIA_ADAPTER_ID,
  type WindowsDesktopCaptureRequest,
} from "./windows-desktop-adapter.js";

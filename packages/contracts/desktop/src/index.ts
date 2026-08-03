export type {
  DesktopPlatform,
  AppTargetLaunch,
  AppTargetProcess,
  AppTargetWindow,
  AppTargetReset,
  AppTargetShutdown,
  AppSession,
  DesktopEnvironmentProvider,
  AppTargetErrorCode,
} from "./app-target.js";

export {
  AppTarget,
  validateAppTarget,
  AppTargetError,
  APP_TARGET_LIMITS,
} from "./app-target.js";

export type {
  UiaPattern,
  UiaPatternDescriptor,
  UiaExtensionV1,
  DesktopActionKind,
  DesktopAdapterCapabilities,
  AdapterSupport,
} from "./uia-extension.js";

export {
  UIA_EXTENSION_TYPE,
  UIA_EXTENSION_VERSION,
} from "./uia-extension.js";

export type {
  LocalActionRisk,
  DesktopActionResolution,
  ResolvedDesktopActionBase,
  ResolvedDesktopAction,
  ResolvedWebAction,
  ResolvedAction,
  LocalPermitAuthorization,
  LocalPermitRequest,
  LocalApprovalStatus,
  LocalApprovalDecision,
  LocalExecutionPermit,
  CompanionRequest,
  CompanionRequestType,
  CompanionIpcErrorCode,
  LocalAuthorizationClass,
} from "./companion-ipc.js";

export {
  COMPANION_REQUEST_TYPES,
  COMPANION_IPC_LIMITS,
  PROTOCOL_MAJOR,
  CompanionIpcError,
  assertDeclaredFrameLength,
  parseResolvedDesktopAction,
  parseLocalPermitAuthorization,
  parseLocalExecutionPermit,
  parseLocalPermitRequest,
  parseCompanionDecision,
  parseCompanionRequest,
  classifyLocalAuthorization,
  isLocalPermitExpired,
} from "./companion-ipc.js";

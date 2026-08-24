export type {
  ObservationJsonValue,
  ObservationSchema,
  ObservationTarget,
  ObservationRelationType,
  ObservationRelationV1,
  ObservationNodeSource,
  ObservationBounds,
  ObservationSensitivity,
  VersionedExtension,
  WebViewportV1,
  WebExtensionV1Payload,
  WebExtensionV1,
  ObservationNodeV1,
  ObservationGraphV1,
  PreV1AssetMetadata,
} from "./core.js";

export {
  OBSERVATION_GRAPH_V1_VERSION,
  OBSERVATION_GRAPH_V1_SCHEMA,
  CANONICAL_NODE_FIELDS,
  CANONICAL_GRAPH_FIELDS,
} from "./core.js";

export {
  ObservationError,
  OBSERVATION_GRAPH_V1_CAPABILITY,
  WEB_EXTENSION_V1_TYPE,
  WEB_EXTENSION_V1_REDACTION_MARKER,
  observationError,
  parseExtensionKey,
  requireExtensionMajor,
  requireGraphExtensionMajor,
  findExtensionMajor,
  findGraphExtensionMajor,
} from "./extensions.js";

export type {
  ObservationErrorCode,
  ParsedExtensionKey,
} from "./extensions.js";

export {
  canonicalObservationJson,
  canonicalObservationGraphJson,
  canonicalizeObservationGraph,
  canonicalObservationHash,
  isObservationGraphV1,
} from "./canonical.js";

export {
  validateObservationGraphV1,
  observationGraphHash,
} from "./validator.js";

export type {
  EvidenceResolver,
  ValidateOptions,
} from "./validator.js";

export {
  PrdDocument,
  sha256Hex,
  uuidv7,
  verifySourceRef,
} from "./domain/prd-document.js";

export type {
  CreatePrdInput,
  PrdSourceRef,
} from "./domain/prd-document.js";

export { PrdIntakeService } from "./application/prd-intake-service.js";

export type {
  IngestPrdInput,
  PrdIntakeError,
  PrdIntakeErrorCode,
} from "./application/prd-intake-service.js";

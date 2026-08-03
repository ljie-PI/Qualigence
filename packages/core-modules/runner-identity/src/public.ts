export { RunnerIdentityError, isRunnerIdentityError } from "./domain/errors.js";
export type { RunnerIdentityErrorCode, RunnerIdentityErrorOptions } from "./domain/errors.js";
export type { RunnerEnrollment, IssuedRunnerCertificate } from "./domain/runner-enrollment.js";
export {
  ENROLLMENT_TOKEN_BYTES,
  generateEnrollmentToken,
  hashEnrollmentToken,
  tokenMatchesHash,
} from "./domain/runner-enrollment.js";
export type {
  RunnerPrincipal,
  RunnerStatus,
  RunnerUriScope,
  RunnerOperationScope,
} from "./domain/runner-principal.js";
export {
  RUNNER_TRUST_DOMAIN,
  runnerUriSan,
  parseRunnerUriSan,
  authorizeRunnerScope,
} from "./domain/runner-principal.js";
export type {
  RunnerCertificateIssuer,
  IssueRunnerCertificateInput,
  RunnerEnrollmentStore,
  RunnerPrincipalStore,
} from "./ports/runner-certificate-issuer.js";
export {
  RunnerEnrollmentService,
  InMemoryRunnerEnrollmentStore,
  InMemoryRunnerPrincipalStore,
} from "./application/runner-enrollment-service.js";
export type {
  CreateRunnerEnrollmentInput,
  CreateRunnerEnrollmentResult,
  RunnerEnrollmentServiceDependencies,
} from "./application/runner-enrollment-service.js";

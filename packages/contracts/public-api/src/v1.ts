/**
 * Public API v1 contract: the DTO-only surface exposed by the Self-hosted
 * Server. These types intentionally never import a Core aggregate or domain
 * package — a Server mapper converts published domain values into these shapes,
 * so a method, private field or unstable domain detail can never leak over the
 * wire. Larger Trace/Plan/Skill payloads are carried through a `payload` field
 * tagged with a `schemaVersion`, never a serialized domain class.
 */

/** The four human roles carried by an authenticated request principal. */
export type PublicApiRole = "admin" | "tester" | "reviewer" | "viewer";

/**
 * The authenticated caller of a human-facing route. Derived exclusively from an
 * OIDC token whose tenant/role claims were mapped through the deployment's
 * allowlist — never from a Runner certificate.
 */
export interface RequestPrincipal {
  readonly subject: string;
  readonly tenantId: string;
  readonly roles: readonly PublicApiRole[];
}

// ---- Resource DTOs (frozen minimal shapes) ---------------------------------

export interface ProjectDto {
  readonly projectId: string;
  readonly name: string;
  readonly version: number;
}

export interface TargetDto {
  readonly targetId: string;
  readonly projectId: string;
  readonly kind: "web" | "desktop";
  readonly displayName: string;
  readonly runnerId: string;
  readonly version: number;
  readonly snapshotHash: string;
  readonly configuration: TargetConfigurationDto;
}

export type TargetConfigurationDto =
  | { readonly kind: "web"; readonly startUrl: string; readonly allowedOrigins: readonly string[]; readonly browser: "chromium"; readonly authenticationProfileId?: string }
  | { readonly kind: "desktop"; readonly app: DesktopAppTargetDto };

export interface DesktopAppTargetDto {
  readonly targetId: string;
  readonly platform: "windows";
  readonly launch: { readonly executable: string; readonly args: readonly string[]; readonly workingDirectory?: string };
  readonly process: { readonly expectedImageName: string; readonly allowedChildImageNames: readonly string[] };
  readonly window: { readonly titlePattern?: string; readonly automationId?: string };
  readonly reset: { readonly command: string; readonly args: readonly string[]; readonly timeoutMs: number };
  readonly shutdown: { readonly gracefulTimeoutMs: number; readonly forceAfterTimeout: boolean };
}

export interface PrdRevisionDto {
  readonly prdId: string;
  readonly projectId: string;
  readonly revision: number;
  readonly title: string;
  readonly contentSha256: string;
  readonly ingestedAt: string;
}

export type IntentStepDto =
  | { readonly kind: "navigate"; readonly path: string }
  | {
      readonly kind: "click";
      readonly target: { readonly role?: string; readonly name?: string; readonly purpose: string };
    }
  | {
      readonly kind: "input";
      readonly target: { readonly role?: string; readonly name?: string; readonly purpose: string };
      readonly valueRef: string;
    }
  | { readonly kind: "verify"; readonly claimIds: readonly string[] };

export interface TestCaseDto {
  readonly testCaseId: string;
  readonly title: string;
  readonly objective: string;
  readonly preconditions: readonly string[];
  readonly steps: readonly IntentStepDto[];
  readonly expectedClaimIds: readonly string[];
  readonly priority: "low" | "medium" | "high";
}

export interface TestPlanDto {
  readonly planId: string;
  readonly projectId: string;
  readonly prdId: string;
  readonly prdRevision: number;
  readonly status: "draft" | "approved";
  readonly version: number;
  readonly payload: {
    readonly schemaVersion: "test-plan/v1";
    readonly testCases: readonly TestCaseDto[];
  };
}

export interface MissionDto {
  readonly missionId: string;
  readonly projectId: string;
  readonly revision: number;
  readonly targetId: string;
  readonly targetVersion: number;
  readonly targetSnapshotHash: string;
  readonly runnerId: string;
  readonly planId: string;
  readonly planVersion: number;
  readonly status: "draft" | "approved" | "running" | "completed" | "blocked";
  readonly version: number;
}

export interface RunDto {
  readonly runId: string;
  readonly missionId?: string;
  readonly status: "running" | "passed" | "finding" | "blocked" | "error";
  readonly findingIds: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly createdAt: string;
  readonly completedAt?: string;
}

export interface StartMissionResultDto {
  readonly missionId: string;
  readonly missionRevision: number;
  readonly missionVersion: number;
  readonly status: "running";
  readonly runs: readonly {
    readonly logicalJobId: string;
    readonly attemptId: string;
    readonly runnerJobId: string;
    readonly runId: string;
  }[];
}

export interface SkillVersionDto {
  readonly skillId: string;
  readonly version: number;
  readonly state: "draft" | "candidate" | "verified" | "promoted" | "deprecated";
  readonly contentSha256: string;
  readonly signatureStatus: "valid" | "invalid" | "revoked";
  readonly evaluationStatus: "pending" | "passed" | "failed";
}

export interface InvestigationDto {
  readonly caseId: string;
  readonly findingId: string;
  readonly status:
    | "candidate"
    | "investigating"
    | "reproducing"
    | "confirmed"
    | "refuted"
    | "flaky"
    | "needs_human"
    | "resolved"
    | "regression_verified";
  readonly attemptIds: readonly string[];
  readonly evidenceCompleteness: "complete" | "limited" | "unavailable";
  readonly version: number;
}

export interface ReviewTaskDto {
  readonly taskId: string;
  readonly caseId: string;
  readonly status: "open" | "claimed" | "resolved";
  readonly priority: "low" | "medium" | "high" | "urgent";
  readonly assigneeId?: string;
  readonly version: number;
}

export interface ArtifactMetadataDto {
  readonly artifactId: string;
  readonly runId: string;
  readonly kind: string;
  readonly mediaType: string;
  readonly size: number;
  readonly sha256: string;
  readonly downloadAllowed: boolean;
}

export interface TraceEventDto {
  readonly runId: string;
  readonly sequenceNumber: number;
  readonly stage: string;
  readonly occurredAt: string;
  readonly payloadHash: string;
}

export interface RunnerEnrollmentDto {
  readonly enrollmentId: string;
  readonly runnerId: string;
  readonly tenantId: string;
  readonly projectIds: readonly string[];
  readonly expiresAt: string;
  /** Present only on the create response — never in query DTOs, logs or storage. */
  readonly enrollmentToken: string;
}

export interface RunnerCertificateDto {
  readonly runnerId: string;
  readonly certificatePem: string;
  readonly caCertificatePem: string;
  readonly certificateFingerprintSha256: string;
  readonly certificateNotAfter: string;
}

export interface RunnerIdentityDto {
  readonly runnerId: string;
  readonly tenantId: string;
  readonly projectIds: readonly string[];
  readonly status: "active" | "suspended" | "revoked";
  readonly certificateFingerprintSha256: string;
  readonly certificateNotAfter: string;
}

// ---- Envelopes -------------------------------------------------------------

/** Unified list-response envelope. */
export interface ListEnvelope<TItem> {
  readonly items: readonly TItem[];
  readonly nextCursor?: string;
  readonly asOfEvent: number;
  readonly asOfTime: string;
  readonly lagMs: number;
}

/** Unified command-response envelope. */
export interface CommandEnvelope<TResource> {
  readonly resource: TResource;
  readonly version: number;
  readonly correlationId: string;
}

/** Unified error envelope. Conflict `details` only carries safe fields. */
export interface ErrorEnvelope {
  readonly code: PublicApiErrorCode;
  readonly safeMessage: string;
  readonly correlationId: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export type PublicApiErrorCode =
  | "Unauthorized"
  | "Forbidden"
  | "NotFound"
  | "VersionConflict"
  | "IdempotencyKeyRequired"
  | "ValidationFailed"
  | "EnrollmentTokenInvalid"
  | "RunnerIdentityUnauthenticated"
  | "Internal";

// ---- Request bodies --------------------------------------------------------

export interface CreateProjectBody {
  readonly name: string;
}

export interface CreateTargetBody {
  readonly targetId: string;
  readonly displayName: string;
  readonly runnerId: string;
  readonly expectedVersion: number;
  readonly configuration: TargetConfigurationDto;
}

export interface CreateTestPlanBody {
  readonly projectId: string;
  readonly prdId: string;
  readonly prdRevision: number;
  readonly sourceContentSha256: string;
  readonly expectedClaims: readonly {
    readonly semanticKey: string;
    readonly statement: string;
    readonly sourceRefs: readonly { readonly prdId: string; readonly revision: number; readonly startOffset: number; readonly endOffset: number; readonly quotedTextSha256: string }[];
    readonly confidence: number;
  }[];
  readonly testCases: readonly {
    readonly title: string;
    readonly objective: string;
    readonly preconditions: readonly string[];
    readonly steps: readonly (
      | { readonly kind: "navigate"; readonly path: string }
      | { readonly kind: "click"; readonly target: { readonly role?: string; readonly name?: string; readonly purpose: string } }
      | { readonly kind: "input"; readonly target: { readonly role?: string; readonly name?: string; readonly purpose: string }; readonly valueRef: string }
      | { readonly kind: "verify"; readonly claimSemanticKeys: readonly string[] }
    )[];
    readonly expectedClaimSemanticKeys: readonly string[];
    readonly sourceRefs: readonly { readonly prdId: string; readonly revision: number; readonly startOffset: number; readonly endOffset: number; readonly quotedTextSha256: string }[];
    readonly priority: "low" | "medium" | "high";
  }[];
}

export interface IngestPrdBody {
  readonly title: string;
  readonly content: string;
}

export interface CreateMissionBody {
  readonly projectId: string;
  readonly targetId: string;
  readonly targetVersion: number;
  readonly targetSnapshotHash: string;
  readonly planId: string;
  readonly planVersion: number;
}

export interface StartMissionBody {
  readonly expectedVersion: number;
}

export interface ApproveTestPlanBody {
  readonly expectedVersion: number;
}

export interface ClaimReviewTaskBody {
  readonly expectedVersion: number;
  readonly reviewerId: string;
}

export interface ResolveReviewTaskBody {
  readonly expectedVersion: number;
  readonly reviewerId: string;
  readonly disposition: string;
  readonly evidenceRefs: readonly string[];
}

export interface PromoteSkillBody {
  readonly expectedVersion: number;
}

export interface DeprecateSkillBody {
  readonly expectedVersion: number;
  readonly reason: string;
}

export interface CreateRunnerEnrollmentBody {
  readonly runnerId: string;
  readonly projectIds: readonly string[];
  readonly ttlMs: number;
}

export interface IssueRunnerCertificateBody {
  readonly enrollmentToken: string;
  readonly csrPem: string;
}

/** The HTTP header carrying the mutation idempotency key. */
export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";

/** The HTTP header a TLS-terminating proxy uses to forward a Runner client certificate PEM. */
export const CLIENT_CERTIFICATE_HEADER = "x-client-cert";

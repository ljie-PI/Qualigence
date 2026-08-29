import type {
  ApproveTestPlanBody,
  ArtifactMetadataDto,
  ClaimReviewTaskBody,
  CommandEnvelope,
  CreateMissionBody,
  CreateProjectBody,
  CreateTargetBody,
  CreateTestPlanBody,
  DeprecateSkillBody,
  ErrorEnvelope,
  IngestPrdBody,
  InvestigationDto,
  ListEnvelope,
  MissionDto,
  PrdRevisionDto,
  ProjectDto,
  PromoteSkillBody,
  ResolveReviewTaskBody,
  ReviewTaskDto,
  RunDto,
  SkillVersionDto,
  TraceEventDto,
  StartMissionBody,
  StartMissionResultDto,
  TargetDto,
  TestPlanDto,
} from "@qualigence/public-api";
import { IDEMPOTENCY_KEY_HEADER } from "@qualigence/public-api";
import { ApiClientError } from "./errors.js";

/** Supplies the current in-memory access token, or `undefined` when logged out. */
export type AccessTokenProvider = () => string | undefined;

export interface PublicApiClientOptions {
  /** Absolute base URL of the Public API (e.g. `https://host/api`). */
  readonly baseUrl: string;
  /** Reads the current access token from the in-memory session — never storage. */
  readonly accessToken: AccessTokenProvider;
  /** Injectable fetch (defaults to the global) so tests can drive a real server. */
  readonly fetch?: typeof fetch;
}

/** Fields every mutation must carry: the idempotency key and expected version. */
export interface MutationOptions {
  readonly idempotencyKey: string;
}

interface RequestOptions {
  readonly method?: "GET" | "POST";
  readonly body?: unknown;
  readonly idempotencyKey?: string;
}

/**
 * The Web Console's single, strictly-typed door to the backend. Every method is
 * typed against a `@qualigence/public-api` DTO — the Console never sees a Core
 * aggregate. The client injects the in-memory bearer token, attaches the
 * `Idempotency-Key` header on mutations, and maps any non-2xx body to a typed
 * {@link ApiClientError}. Base URL is configurable so the same bundle serves
 * Local and every Self-hosted deployment.
 */
export class PublicApiClient {
  private readonly baseUrl: string;
  private readonly accessToken: AccessTokenProvider;
  private readonly fetchImpl: typeof fetch;

  constructor(options: PublicApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.accessToken = options.accessToken;
    // Browser `fetch` is a Window member: keep that receiver for the default
    // dependency while leaving an explicitly injected fetch untouched.
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  // ---- Projects & targets --------------------------------------------------

  async listProjects(): Promise<ListEnvelope<ProjectDto>> {
    return this.request<ListEnvelope<ProjectDto>>("/v1/projects");
  }

  async createProject(
    body: CreateProjectBody,
    options: MutationOptions,
  ): Promise<CommandEnvelope<ProjectDto>> {
    return this.request<CommandEnvelope<ProjectDto>>("/v1/projects", {
      method: "POST",
      body,
      idempotencyKey: options.idempotencyKey,
    });
  }

  async listTargets(projectId: string): Promise<ListEnvelope<TargetDto>> {
    return this.request<ListEnvelope<TargetDto>>(
      `/v1/projects/${encodeURIComponent(projectId)}/targets`,
    );
  }

  async createTarget(
    projectId: string,
    body: CreateTargetBody,
    options: MutationOptions,
  ): Promise<CommandEnvelope<TargetDto>> {
    return this.request<CommandEnvelope<TargetDto>>(
      `/v1/projects/${encodeURIComponent(projectId)}/targets`,
      { method: "POST", body, idempotencyKey: options.idempotencyKey },
    );
  }

  async getTarget(targetId: string, projectId: string): Promise<TargetDto | undefined> {
    return (await this.listTargets(projectId)).items.find((target) => target.targetId === targetId);
  }

  // ---- PRD revisions -------------------------------------------------------

  async listPrdRevisions(projectId: string): Promise<ListEnvelope<PrdRevisionDto>> {
    return this.request<ListEnvelope<PrdRevisionDto>>(
      `/v1/projects/${encodeURIComponent(projectId)}/prd-revisions`,
    );
  }

  async ingestPrd(
    projectId: string,
    body: IngestPrdBody,
    options: MutationOptions,
  ): Promise<CommandEnvelope<PrdRevisionDto>> {
    return this.request<CommandEnvelope<PrdRevisionDto>>(
      `/v1/projects/${encodeURIComponent(projectId)}/prd-revisions`,
      { method: "POST", body, idempotencyKey: options.idempotencyKey },
    );
  }

  // ---- Test plans (Draft Plan approval) ------------------------------------

  async createTestPlan(body: CreateTestPlanBody, options: MutationOptions): Promise<CommandEnvelope<TestPlanDto>> {
    return this.request<CommandEnvelope<TestPlanDto>>("/v1/test-plans", { method: "POST", body, idempotencyKey: options.idempotencyKey });
  }

  async getTestPlan(planId: string): Promise<TestPlanDto> {
    return this.request<TestPlanDto>(`/v1/test-plans/${encodeURIComponent(planId)}`);
  }

  async approveTestPlan(
    planId: string,
    body: ApproveTestPlanBody,
    options: MutationOptions,
  ): Promise<CommandEnvelope<TestPlanDto>> {
    return this.request<CommandEnvelope<TestPlanDto>>(
      `/v1/test-plans/${encodeURIComponent(planId)}/approve`,
      { method: "POST", body, idempotencyKey: options.idempotencyKey },
    );
  }

  // ---- Missions & runs -----------------------------------------------------

  async listMissions(): Promise<ListEnvelope<MissionDto>> {
    return this.request<ListEnvelope<MissionDto>>("/v1/missions");
  }

  async getMission(missionId: string): Promise<MissionDto> {
    return this.request<MissionDto>(`/v1/missions/${encodeURIComponent(missionId)}`);
  }

  async createMission(
    body: CreateMissionBody,
    options: MutationOptions,
  ): Promise<CommandEnvelope<MissionDto>> {
    return this.request<CommandEnvelope<MissionDto>>("/v1/missions", {
      method: "POST",
      body,
      idempotencyKey: options.idempotencyKey,
    });
  }

  async startMission(
    missionId: string,
    body: StartMissionBody,
    options: MutationOptions,
  ): Promise<CommandEnvelope<StartMissionResultDto>> {
    return this.request<CommandEnvelope<StartMissionResultDto>>(
      `/v1/missions/${encodeURIComponent(missionId)}/start`,
      { method: "POST", body, idempotencyKey: options.idempotencyKey },
    );
  }

  async listRuns(): Promise<ListEnvelope<RunDto>> {
    return this.request<ListEnvelope<RunDto>>("/v1/runs");
  }

  async getRun(runId: string): Promise<RunDto> {
    return this.request<RunDto>(`/v1/runs/${encodeURIComponent(runId)}`);
  }

  async listRunTrace(runId: string): Promise<ListEnvelope<TraceEventDto>> {
    return this.request<ListEnvelope<TraceEventDto>>(
      `/v1/runs/${encodeURIComponent(runId)}/trace`,
    );
  }

  // ---- Evidence artifacts --------------------------------------------------

  /**
   * Reads authorized Artifact metadata through the public Evidence route. The
   * caller supplies the immutable project/run/artifact identity explicitly;
   * RunDto deliberately does not carry project identity.
   */
  async getArtifactMetadata(
    projectId: string,
    runId: string,
    artifactId: string,
  ): Promise<ArtifactMetadataDto> {
    return this.request<ArtifactMetadataDto>(this.artifactPath(projectId, runId, artifactId));
  }

  /** Downloads only bytes authorized by the existing Evidence route. */
  async downloadArtifact(
    projectId: string,
    runId: string,
    artifactId: string,
  ): Promise<Blob> {
    const response = await this.requestResponse(this.artifactPath(projectId, runId, artifactId, "/bytes"));
    return response.blob();
  }

  private artifactPath(
    projectId: string,
    runId: string,
    artifactId: string,
    suffix = "",
  ): string {
    return `/v1/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}${suffix}?purpose=investigation`;
  }

  // ---- Skills --------------------------------------------------------------

  async listSkills(): Promise<ListEnvelope<SkillVersionDto>> {
    return this.request<ListEnvelope<SkillVersionDto>>("/v1/skills");
  }

  async getSkill(skillId: string): Promise<SkillVersionDto> {
    return this.request<SkillVersionDto>(`/v1/skills/${encodeURIComponent(skillId)}`);
  }

  async listSkillVersions(skillId: string): Promise<ListEnvelope<SkillVersionDto>> {
    return this.request<ListEnvelope<SkillVersionDto>>(`/v1/skills/${encodeURIComponent(skillId)}/versions`);
  }

  async promoteSkill(
    skillId: string,
    body: PromoteSkillBody,
    options: MutationOptions,
  ): Promise<CommandEnvelope<SkillVersionDto>> {
    return this.request<CommandEnvelope<SkillVersionDto>>(
      `/v1/skills/${encodeURIComponent(skillId)}/promote`,
      { method: "POST", body, idempotencyKey: options.idempotencyKey },
    );
  }

  async deprecateSkill(
    skillId: string,
    body: DeprecateSkillBody,
    options: MutationOptions,
  ): Promise<CommandEnvelope<SkillVersionDto>> {
    return this.request<CommandEnvelope<SkillVersionDto>>(
      `/v1/skills/${encodeURIComponent(skillId)}/deprecate`,
      { method: "POST", body, idempotencyKey: options.idempotencyKey },
    );
  }

  // ---- Investigations ------------------------------------------------------

  async listInvestigations(): Promise<ListEnvelope<InvestigationDto>> {
    return this.request<ListEnvelope<InvestigationDto>>("/v1/investigations");
  }

  /** Note: the Server returns the bare DTO here, not a list/command envelope. */
  async getInvestigation(caseId: string): Promise<InvestigationDto> {
    return this.request<InvestigationDto>(
      `/v1/investigations/${encodeURIComponent(caseId)}`,
    );
  }

  // ---- Review queue --------------------------------------------------------

  async listReviewTasks(): Promise<ListEnvelope<ReviewTaskDto>> {
    return this.request<ListEnvelope<ReviewTaskDto>>("/v1/review-tasks");
  }

  async claimReviewTask(
    taskId: string,
    body: ClaimReviewTaskBody,
    options: MutationOptions,
  ): Promise<CommandEnvelope<ReviewTaskDto>> {
    return this.request<CommandEnvelope<ReviewTaskDto>>(
      `/v1/review-tasks/${encodeURIComponent(taskId)}/claim`,
      { method: "POST", body, idempotencyKey: options.idempotencyKey },
    );
  }

  async resolveReviewTask(
    taskId: string,
    body: ResolveReviewTaskBody,
    options: MutationOptions,
  ): Promise<CommandEnvelope<ReviewTaskDto>> {
    return this.request<CommandEnvelope<ReviewTaskDto>>(
      `/v1/review-tasks/${encodeURIComponent(taskId)}/resolve`,
      { method: "POST", body, idempotencyKey: options.idempotencyKey },
    );
  }

  // ---- Transport -----------------------------------------------------------

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.requestResponse(path, options);
    return (await response.json()) as T;
  }

  private async requestResponse(path: string, options: RequestOptions = {}): Promise<Response> {
    const headers: Record<string, string> = { accept: "application/json" };
    const token = this.accessToken();
    if (token !== undefined) {
      headers.authorization = `Bearer ${token}`;
    }
    const init: RequestInit = { method: options.method ?? "GET", headers };
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }
    if (options.idempotencyKey !== undefined) {
      headers[IDEMPOTENCY_KEY_HEADER] = options.idempotencyKey;
    }

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    if (!response.ok) {
      throw new ApiClientError(response.status, await this.readError(response));
    }
    return response;
  }

  private async readError(response: Response): Promise<ErrorEnvelope> {
    try {
      return (await response.json()) as ErrorEnvelope;
    } catch {
      return {
        code: "Internal",
        safeMessage: "an unparseable error response was received",
        correlationId: "",
      };
    }
  }
}

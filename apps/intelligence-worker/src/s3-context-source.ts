import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { IntelligenceJob } from "@qualigence/intelligence";
import type {
  BugAnalysisContext,
  ReproductionPlanningContext,
} from "@qualigence/investigation";
import { JobProcessingError, throwIfJobProcessingAborted } from "./job-processor.js";
import type { IntelligenceContextSource } from "./investigation-job-processor.js";

export interface S3ContextSourceConfig {
  readonly region: string;
  readonly endpoint?: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly forcePathStyle: boolean;
}

/**
 * Loads a Job's deterministically pre-assembled context from S3. The Server
 * serialises the context JSON as an artifact when it enqueues the Job and
 * records the object key in the Job's first `inputRef`; the Worker — which is
 * denied direct access to aggregate tables — reads only that artifact.
 */
export class S3ContextSource implements IntelligenceContextSource {
  private readonly client: S3Client;

  constructor(private readonly config: S3ContextSourceConfig) {
    this.client = new S3Client({
      region: config.region,
      ...(config.endpoint !== undefined ? { endpoint: config.endpoint } : {}),
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  loadReproductionPlanning(job: IntelligenceJob, signal?: AbortSignal): Promise<ReproductionPlanningContext> {
    return this.load<ReproductionPlanningContext>(job, signal);
  }

  loadBugAnalysis(job: IntelligenceJob, signal?: AbortSignal): Promise<BugAnalysisContext> {
    return this.load<BugAnalysisContext>(job, signal);
  }

  async verifyReadiness(signal?: AbortSignal): Promise<void> {
    throwIfJobProcessingAborted(signal);
    const key = `.qualigence-readiness/worker-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const expected = Buffer.from("qualigence-worker-object-storage-readiness", "utf8");
    let wrote = false;
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
          Body: expected,
          ContentType: "text/plain; charset=utf-8",
          Metadata: { owner: "qualigence-intelligence-worker-readiness" },
        }),
        signal === undefined ? undefined : { abortSignal: signal },
      );
      wrote = true;
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
        signal === undefined ? undefined : { abortSignal: signal },
      );
      const actual = await response.Body?.transformToByteArray();
      if (actual === undefined || !Buffer.from(actual).equals(expected)) {
        throw new Error("object storage readiness probe read different bytes");
      }
    } finally {
      if (wrote) {
        await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }));
      }
    }
  }

  private async load<T>(job: IntelligenceJob, signal?: AbortSignal): Promise<T> {
    throwIfJobProcessingAborted(signal);
    const key = job.inputRefs[0];
    if (key === undefined) {
      throw new JobProcessingError("ContextUnavailable", `job ${job.jobId} has no context inputRef`);
    }
    try {
      const command = new GetObjectCommand({ Bucket: this.config.bucket, Key: key });
      const response = await this.client.send(
        command,
        signal === undefined ? undefined : { abortSignal: signal },
      );
      throwIfJobProcessingAborted(signal);
      const body = await response.Body?.transformToString();
      if (body === undefined) {
        throw new JobProcessingError("ContextUnavailable", `context artifact ${key} is empty`);
      }
      return JSON.parse(body) as T;
    } catch (error) {
      if (error instanceof JobProcessingError) {
        throw error;
      }
      throw new JobProcessingError(
        "ContextUnavailable",
        `failed to load context artifact ${key} for job ${job.jobId}`,
        { cause: error },
      );
    }
  }
}

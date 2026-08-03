import type { IntelligenceJob, IntelligenceResult } from "@qualigence/intelligence";

/**
 * The Worker-side dispatch seam. A processor turns a leased {@link IntelligenceJob}
 * into an {@link IntelligenceResult} envelope — typically by loading the Job's
 * deterministically pre-assembled context (via its `inputRefs`) and invoking the
 * Model Gateway. A processor is powerless: it produces a proposal envelope only
 * and NEVER mutates an aggregate. The Server alone applies the Result.
 */
export interface JobProcessor {
  process(job: IntelligenceJob): Promise<IntelligenceResult>;
}

export type JobProcessingErrorCode = "UnsupportedJobType" | "ContextUnavailable" | "ModelFailed";

export class JobProcessingError extends Error {
  readonly code: JobProcessingErrorCode;

  constructor(code: JobProcessingErrorCode, message: string, options?: { cause?: unknown }) {
    super(`${code}: ${message}`, options);
    this.name = "JobProcessingError";
    this.code = code;
  }
}

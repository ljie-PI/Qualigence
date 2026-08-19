import { z } from "zod";

export const localSessionResponseSchema = z.object({
  sessionToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  expiresAt: z.string().datetime({ offset: false }),
}).strict();

export const localRunRequestSchema = z.object({
  targetUrl: z.string().min(1),
  objective: z.string().trim().min(1),
}).strict();

export type LocalPublicRunStatus =
  | "pending_runner"
  | "offer_outcome_unknown"
  | "running"
  | "passed"
  | "finding"
  | "blocked"
  | "error";

export interface LocalSessionResponse {
  readonly sessionToken: string;
  readonly expiresAt: string;
}

export interface LocalRunAccepted {
  readonly runId: string;
  readonly status: "pending_runner";
}

export interface LocalEvidenceReference {
  readonly id: string;
  readonly kind: string;
  readonly createdAt: string;
}

export interface LocalRunStatusResponse {
  readonly runId: string;
  readonly status: LocalPublicRunStatus;
  readonly errorCode?: string;
  readonly evidenceReferences?: readonly LocalEvidenceReference[];
}

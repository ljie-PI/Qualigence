/**
 * Layered local-operations health contract shared by the Launcher and its
 * diagnostics. A {@link HealthReport} aggregates independent {@link HealthCheck}
 * layers (process/port/database/artifact/runner/spool/model/disk) into a single
 * stable status. Every message is a `safeMessage`: it must never carry a secret,
 * a credential value or a base64 payload.
 */
import { z } from "zod";

export const healthCheckNameSchema = z.enum([
  "database",
  "artifact_store",
  "runner",
  "spool",
  "model_provider",
  "disk",
]);

export const healthCheckStatusSchema = z.enum(["pass", "warn", "fail"]);

export const healthStatusSchema = z.enum(["healthy", "degraded", "unhealthy"]);

export const healthCheckSchema = z
  .object({
    name: healthCheckNameSchema,
    status: healthCheckStatusSchema,
    code: z.string().min(1).optional(),
    safeMessage: z.string(),
  })
  .strict();

export const healthReportSchema = z
  .object({
    status: healthStatusSchema,
    version: z.string(),
    checks: z.array(healthCheckSchema),
  })
  .strict();

export type HealthCheckName = z.infer<typeof healthCheckNameSchema>;
export type HealthCheckStatus = z.infer<typeof healthCheckStatusSchema>;
export type HealthStatus = z.infer<typeof healthStatusSchema>;

export interface HealthCheck {
  readonly name: HealthCheckName;
  readonly status: HealthCheckStatus;
  readonly code?: string;
  readonly safeMessage: string;
}

export interface HealthReport {
  readonly status: HealthStatus;
  readonly version: string;
  readonly checks: readonly HealthCheck[];
}

/**
 * Fold check statuses into an overall status: any `fail` makes the report
 * `unhealthy`, otherwise any `warn` makes it `degraded`, otherwise `healthy`.
 */
export function aggregateHealthStatus(
  checks: readonly HealthCheck[],
): HealthStatus {
  if (checks.some((check) => check.status === "fail")) {
    return "unhealthy";
  }
  if (checks.some((check) => check.status === "warn")) {
    return "degraded";
  }
  return "healthy";
}

/** Build a validated {@link HealthReport} with a folded overall status. */
export function makeHealthReport(
  version: string,
  checks: readonly HealthCheck[],
): HealthReport {
  return healthReportSchema.parse({
    status: aggregateHealthStatus(checks),
    version,
    checks,
  }) as HealthReport;
}

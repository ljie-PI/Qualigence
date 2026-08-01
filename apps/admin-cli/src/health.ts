/** The severity of a single diagnostic finding. */
export type CheckStatus = "pass" | "warn" | "fail";

/** One operator-safe diagnostic finding. */
export interface DoctorCheck {
  readonly name: string;
  readonly status: CheckStatus;
  readonly safeMessage: string;
  readonly code?: string;
}

/** Overall health for a Self-hosted deployment. */
export type ReportStatus = "healthy" | "degraded" | "unhealthy";

export interface DoctorReport {
  readonly status: ReportStatus;
  readonly checks: readonly DoctorCheck[];
}

/** Any `fail` → unhealthy; any `warn` → degraded; otherwise healthy. */
export function aggregateStatus(checks: readonly DoctorCheck[]): ReportStatus {
  if (checks.some((check) => check.status === "fail")) {
    return "unhealthy";
  }
  if (checks.some((check) => check.status === "warn")) {
    return "degraded";
  }
  return "healthy";
}

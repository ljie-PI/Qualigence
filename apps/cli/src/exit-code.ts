import type { RunExecutionResult } from "@qualigence/execution-application";

/**
 * Maps a terminal outcome to a process exit code: passed=0, finding=1,
 * blocked=2, error/configuration-failure=3.
 */
export function exitCodeFor(result: RunExecutionResult): 0 | 1 | 2 | 3 {
  switch (result.status) {
    case "passed":
      return 0;
    case "finding":
      return 1;
    case "blocked":
      return 2;
    case "error":
      return 3;
  }
}

import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReviewTaskDto } from "@qualigence/public-api";
import { ApiClientError } from "../../api/errors.js";
import { useServices, useSession } from "../../auth/session-context.js";
import { queryKeys } from "../../routes/query-keys.js";
import { DataState, DefinitionList, StatusBadge } from "../../ui/components.js";

/**
 * Review task detail: claim + resolve with expected-version optimistic
 * concurrency (route `/reviews/:taskId`). On a `VersionConflict` the handler
 * refetches the queue so the UI replaces its stale assignee/version with the
 * real state and shows a conflict banner — the design's concurrent-claim rule.
 */
export function ReviewTaskPage(props: { readonly taskId: string }): ReactNode {
  const { api } = useServices();
  const session = useSession();
  const tenantId = session?.tenantId ?? "";
  const queryClient = useQueryClient();
  const { taskId } = props;
  const [conflict, setConflict] = useState<string | undefined>();
  const [disposition, setDisposition] = useState("confirmed");

  const tasks = useQuery({
    queryKey: queryKeys.reviewTasks(tenantId),
    queryFn: () => api.listReviewTasks(),
    enabled: session !== undefined,
  });
  const task: ReviewTaskDto | undefined = tasks.data?.items.find((item) => item.taskId === taskId);

  function handleConflict(error: unknown): void {
    if (error instanceof ApiClientError && error.code === "VersionConflict") {
      const actual = (error.details?.actualVersion as number | undefined) ?? undefined;
      setConflict(
        actual !== undefined
          ? `Already changed by another reviewer (now version ${actual}).`
          : "This task was changed by another reviewer.",
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.reviewTasks(tenantId) });
    } else if (error instanceof Error) {
      setConflict(error.message);
    }
  }

  const claim = useMutation({
    mutationFn: () =>
      api.claimReviewTask(
        taskId,
        { expectedVersion: task?.version ?? 0, reviewerId: session?.subject ?? "" },
        { idempotencyKey: crypto.randomUUID() },
      ),
    onSuccess: () => {
      setConflict(undefined);
      void queryClient.invalidateQueries({ queryKey: queryKeys.reviewTasks(tenantId) });
    },
    onError: handleConflict,
  });

  const resolve = useMutation({
    mutationFn: () =>
      api.resolveReviewTask(
        taskId,
        {
          expectedVersion: task?.version ?? 0,
          reviewerId: session?.subject ?? "",
          disposition,
          evidenceRefs: [],
        },
        { idempotencyKey: crypto.randomUUID() },
      ),
    onSuccess: () => {
      setConflict(undefined);
      void queryClient.invalidateQueries({ queryKey: queryKeys.reviewTasks(tenantId) });
    },
    onError: handleConflict,
  });

  const isReviewer = session?.roles.some((r) => r === "admin" || r === "reviewer") ?? false;

  return (
    <section>
      <p>
        <Link to="/reviews">← Review queue</Link>
      </p>
      <h1>Review task {taskId}</h1>
      <DataState isLoading={tasks.isLoading} error={tasks.error} isEmpty={task === undefined}>
        {task !== undefined ? (
          <>
            <DefinitionList
              items={[
                ["Status", <StatusBadge key="s" value={task.status} />],
                ["Priority", task.priority],
                ["Case", task.caseId],
                ["Assignee", task.assigneeId ?? "—"],
                ["Version", String(task.version)],
              ]}
            />
            {conflict !== undefined ? (
              <p className="state state--error" role="alert">
                {conflict}
              </p>
            ) : null}
            {isReviewer ? (
              <div className="actions">
                {task.status === "open" ? (
                  <button type="button" onClick={() => claim.mutate()} disabled={claim.isPending}>
                    Claim
                  </button>
                ) : null}
                {task.status === "claimed" ? (
                  <form
                    className="inline-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      resolve.mutate();
                    }}
                  >
                    <label>
                      Disposition{" "}
                      <select
                        value={disposition}
                        onChange={(event) => setDisposition(event.target.value)}
                      >
                        <option value="confirmed">confirmed</option>
                        <option value="refuted">refuted</option>
                        <option value="flaky">flaky</option>
                      </select>
                    </label>
                    <button type="submit" disabled={resolve.isPending}>
                      Resolve
                    </button>
                  </form>
                ) : null}
              </div>
            ) : null}
          </>
        ) : null}
      </DataState>
    </section>
  );
}

import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useServices, useSession } from "../../auth/session-context.js";
import { queryKeys } from "../../routes/query-keys.js";
import { DataState, StatusBadge } from "../../ui/components.js";

/** Review Queue: open/claim/resolve entry point (route `/reviews`). */
export function ReviewQueuePage(): ReactNode {
  const { api } = useServices();
  const session = useSession();
  const tenantId = session?.tenantId ?? "";
  const tasks = useQuery({
    queryKey: queryKeys.reviewTasks(tenantId),
    queryFn: () => api.listReviewTasks(),
    enabled: session !== undefined,
  });
  return (
    <section>
      <h1>Review queue</h1>
      <DataState
        isLoading={tasks.isLoading}
        error={tasks.error}
        isEmpty={tasks.data?.items.length === 0}
        emptyLabel="No review tasks."
      >
        <table className="review-table">
          <thead>
            <tr>
              <th>Task</th>
              <th>Status</th>
              <th>Priority</th>
              <th>Assignee</th>
              <th>Version</th>
            </tr>
          </thead>
          <tbody>
            {tasks.data?.items.map((task) => (
              <tr key={task.taskId}>
                <td>
                  <Link to="/reviews/$taskId" params={{ taskId: task.taskId }}>
                    {task.taskId}
                  </Link>
                </td>
                <td>
                  <StatusBadge value={task.status} />
                </td>
                <td>{task.priority}</td>
                <td>{task.assigneeId ?? "—"}</td>
                <td>{task.version}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </DataState>
    </section>
  );
}

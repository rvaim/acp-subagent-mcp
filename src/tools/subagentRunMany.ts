import type { SubagentRunManyInput, SubagentRunManyOutput } from "../task/types.js";
import type { SubagentTaskRunnerDependencies } from "../runtime/taskRunner.js";
import { forceCancelActiveTask } from "../runtime/taskRunner.js";
import { handleSubagentStartMany } from "./subagentStartMany.js";
import { handleSubagentWait } from "./subagentWait.js";
import { subagentRunManyInputSchema } from "./schemas.js";
import { SubagentRuntimeError } from "../runtime/errors.js";
import { isFinishedTaskState } from "../runtime/taskRegistry.js";

/**
 * 同步批量运行多个子代理任务。
 *
 * 该工具把 start_many 和 wait 放在同一个 MCP tool call 中：先批量启动，
 * 再立即等待。这样用户手动停止当前 tool call 时，request cancellation
 * 会覆盖本次启动的所有 task，适合“多子代理 fan-out/fan-in 且需要一起取消”的场景。
 */
export async function handleSubagentRunMany(rawInput: unknown, deps: SubagentTaskRunnerDependencies): Promise<SubagentRunManyOutput> {
  const input = subagentRunManyInputSchema.parse(rawInput) as SubagentRunManyInput;
  const startedAt = Date.now();
  const start = await handleSubagentStartMany({
    tasks: input.tasks,
    conflict_policy: input.conflict_policy,
    on_task_failure: input.on_task_failure
  }, deps);
  const taskIds = start.started.map((item) => item.task_id);

  if (taskIds.length === 0) {
    return {
      schema_version: 1,
      status: "failed",
      started: start.started,
      rejected: start.rejected,
      completed: [],
      failed: [],
      pending_task_ids: [],
      cancelled_task_ids: [],
      elapsed_ms: Date.now() - startedAt,
      summary: `没有任务成功启动；拒绝 ${start.rejected.length} 个。`
    };
  }

  const detachAbort = bindRequestAbortToTaskIds(taskIds, deps, "MCP run_many call 已取消");
  try {
    await throwIfRunManyAborted(taskIds, deps);
    const wait = await handleSubagentWait({
      task_ids: taskIds,
      return_when: input.return_when ?? "all_completed",
      timeout_secs: input.wait_timeout_secs,
      on_timeout: input.on_timeout ?? "cancel_pending"
    }, deps);

    return {
      schema_version: 1,
      status: wait.status,
      started: start.started,
      rejected: start.rejected,
      completed: wait.completed,
      failed: wait.failed,
      pending_task_ids: wait.pending_task_ids,
      cancelled_task_ids: wait.cancelled_task_ids,
      elapsed_ms: Date.now() - startedAt,
      summary: `已启动 ${start.started.length} 个，拒绝 ${start.rejected.length} 个；${wait.summary}`
    };
  } finally {
    detachAbort();
  }
}

/**
 * 让 run_many 在 start_many 返回后、wait 真正进入等待前也受同一个 request cancellation 保护。
 */
function bindRequestAbortToTaskIds(taskIds: string[], deps: SubagentTaskRunnerDependencies, reason: string): () => void {
  const signal = deps.requestSignal;
  if (!signal) return () => undefined;

  const onAbort = () => {
    void forceCancelTasksById(taskIds, deps, reason);
  };

  if (signal.aborted) {
    onAbort();
    return () => undefined;
  }

  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

/**
 * 若 run_many 请求已经取消，先强制清理本批任务再抛出取消错误。
 */
async function throwIfRunManyAborted(taskIds: string[], deps: SubagentTaskRunnerDependencies): Promise<void> {
  if (!deps.requestSignal?.aborted) return;
  await forceCancelTasksById(taskIds, deps, "MCP run_many call 已取消");
  throw new SubagentRuntimeError("cancelled", "MCP run_many call 已取消", { recoverable: true });
}

/**
 * 强制取消指定任务集合。
 */
async function forceCancelTasksById(taskIds: string[], deps: SubagentTaskRunnerDependencies, reason: string): Promise<void> {
  await Promise.allSettled(taskIds.map(async (taskId) => {
    const task = deps.registry.get(taskId);
    if (task && !isFinishedTaskState(task.status)) await forceCancelActiveTask(task, deps, reason).catch(() => undefined);
  }));
}

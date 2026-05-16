import type { SubagentWaitInput, SubagentWaitOutput } from "../task/types.js";
import type { SubagentTaskRunnerDependencies } from "../runtime/taskRunner.js";
import { cancelActiveTask } from "../runtime/taskRunner.js";
import { SubagentRuntimeError } from "../runtime/errors.js";
import { isFinishedTaskState } from "../runtime/taskRegistry.js";
import { subagentWaitInputSchema } from "./schemas.js";

/**
 * 处理 subagent_wait：按策略等待任务进入指定条件。
 */
export async function handleSubagentWait(rawInput: unknown, deps: SubagentTaskRunnerDependencies): Promise<SubagentWaitOutput> {
  const input = subagentWaitInputSchema.parse(rawInput) as SubagentWaitInput;
  const startedAt = Date.now();
  const timeoutMs = (input.timeout_secs ?? 30) * 1000;
  const initialSeq = new Map(input.task_ids.map((taskId) => [taskId, deps.registry.get(taskId)?.updateSeq ?? -1]));

  for (const taskId of input.task_ids) {
    if (!deps.registry.get(taskId)) throw new SubagentRuntimeError("invalid_input", `任务不存在：${taskId}`);
  }

  while (true) {
    const snapshot = input.task_ids.map((taskId) => deps.registry.get(taskId)!);
    const conditionMet = isWaitConditionMet(input.return_when, snapshot, initialSeq);
    const elapsed = Date.now() - startedAt;
    if (conditionMet || elapsed >= timeoutMs) {
      if (!conditionMet && input.on_timeout === "cancel_pending") {
        for (const task of snapshot) {
          if (!isFinishedTaskState(task.status)) await cancelActiveTask(task, "subagent_wait timeout").catch(() => undefined);
        }
      }
      return buildWaitOutput(input, deps, Date.now() - startedAt, !conditionMet && elapsed >= timeoutMs);
    }

    await deps.registry.waitForChange(Math.min(1000, timeoutMs - elapsed));
  }
}

/**
 * 判断等待条件是否满足。
 */
function isWaitConditionMet(returnWhen: SubagentWaitInput["return_when"], tasks: ReturnType<SubagentTaskRunnerDependencies["registry"]["list"]>, initialSeq: Map<string, number>): boolean {
  const finished = tasks.filter((task) => isFinishedTaskState(task.status));
  const success = tasks.filter((task) => task.status === "completed" || task.status === "partial");
  const failure = tasks.filter((task) => task.status === "failed" || task.status === "timeout" || task.status === "cancelled");

  if (returnWhen === "all_completed") return finished.length === tasks.length;
  if (returnWhen === "first_completed") return finished.length > 0;
  if (returnWhen === "first_success") return success.length > 0;
  if (returnWhen === "first_failure") return failure.length > 0;
  if (returnWhen === "timeout_partial") return finished.length === tasks.length;
  if (returnWhen === "any_update") {
    return tasks.some((task) => task.updateSeq !== (initialSeq.get(task.taskId) ?? -1));
  }

  return false;
}

/**
 * 构造 wait 输出。
 */
function buildWaitOutput(input: SubagentWaitInput, deps: SubagentTaskRunnerDependencies, elapsedMs: number, timedOut: boolean): SubagentWaitOutput {
  const tasks = input.task_ids.map((taskId) => deps.registry.get(taskId)!).filter(Boolean);
  const completed = tasks
    .filter((task) => (task.status === "completed" || task.status === "partial") && task.result)
    .map((task) => ({ ...task.result!, task_id: task.taskId }));
  const failed = tasks
    .filter((task) => ["failed", "timeout", "cancelled"].includes(task.status) && task.result)
    .map((task) => ({ ...task.result!, task_id: task.taskId }));
  const pending_task_ids = tasks.filter((task) => !isFinishedTaskState(task.status)).map((task) => task.taskId);
  const cancelled_task_ids = tasks.filter((task) => task.status === "cancelled").map((task) => task.taskId);
  const status = pending_task_ids.length === 0 ? "completed" : timedOut ? "timeout" : "partial";

  return {
    schema_version: 1,
    status,
    completed,
    failed,
    pending_task_ids,
    cancelled_task_ids,
    elapsed_ms: elapsedMs,
    summary: `完成 ${completed.length} 个，失败 ${failed.length} 个，仍在运行 ${pending_task_ids.length} 个。`
  };
}

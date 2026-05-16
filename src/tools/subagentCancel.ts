import type { SubagentCancelInput, SubagentCancelOutput } from "../task/types.js";
import type { SubagentTaskRunnerDependencies } from "../runtime/taskRunner.js";
import { cancelActiveTask } from "../runtime/taskRunner.js";
import { makeSubagentError, toSubagentError } from "../runtime/errors.js";
import { subagentCancelInputSchema } from "./schemas.js";

/**
 * 处理 subagent_cancel：取消一个或多个任务。
 */
export async function handleSubagentCancel(rawInput: unknown, deps: SubagentTaskRunnerDependencies): Promise<SubagentCancelOutput> {
  const input = subagentCancelInputSchema.parse(rawInput) as SubagentCancelInput;
  const cancelled_task_ids: string[] = [];
  const already_terminal_task_ids: string[] = [];
  const failed: SubagentCancelOutput["failed"] = [];

  for (const taskId of input.task_ids) {
    const task = deps.registry.get(taskId);
    if (!task) {
      failed.push(makeSubagentError("invalid_input", `任务不存在：${taskId}`));
      continue;
    }
    try {
      const result = await cancelActiveTask(task, input.reason);
      if (result === "already_terminal") already_terminal_task_ids.push(taskId);
      else cancelled_task_ids.push(taskId);
      deps.registry.notify(taskId);
    } catch (error) {
      failed.push(toSubagentError(error));
    }
  }

  return {
    schema_version: 1,
    status: failed.length === 0 ? "cancelled" : cancelled_task_ids.length ? "partial" : "failed",
    cancelled_task_ids,
    already_terminal_task_ids,
    failed,
    summary: `已请求取消 ${cancelled_task_ids.length} 个任务，失败 ${failed.length} 个。`
  };
}

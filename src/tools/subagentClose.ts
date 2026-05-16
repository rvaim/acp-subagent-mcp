import type { SubagentCloseInput, SubagentCloseOutput } from "../task/types.js";
import type { SubagentTaskRunnerDependencies } from "../runtime/taskRunner.js";
import { closeActiveTask } from "../runtime/taskRunner.js";
import { SubagentRuntimeError } from "../runtime/errors.js";
import { subagentCloseInputSchema } from "./schemas.js";

/**
 * 处理 subagent_close：关闭任务和保留的 session。
 */
export async function handleSubagentClose(rawInput: unknown, deps: SubagentTaskRunnerDependencies): Promise<SubagentCloseOutput> {
  const input = subagentCloseInputSchema.parse(rawInput) as SubagentCloseInput;
  const task = deps.registry.get(input.task_id);
  if (!task) throw new SubagentRuntimeError("invalid_input", `任务不存在：${input.task_id}`);
  await closeActiveTask(task, deps, input.force ?? false);
  return {
    schema_version: 1,
    status: "closed",
    task_id: input.task_id,
    closed_at: new Date().toISOString(),
    summary: `已关闭子代理任务：${input.task_id}`
  };
}

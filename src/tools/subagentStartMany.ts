import type { SubagentStartManyInput, SubagentStartManyOutput, SubagentStartOutput } from "../task/types.js";
import type { SubagentTaskRunnerDependencies } from "../runtime/taskRunner.js";
import { cancelActiveTask, startSubagentTask } from "../runtime/taskRunner.js";
import { SubagentRuntimeError } from "../runtime/errors.js";
import { toSubagentError } from "../runtime/errors.js";
import { rejectDynamicMcpServers } from "../runtime/security.js";
import { subagentStartManyInputSchema } from "./schemas.js";

/**
 * 处理 subagent_start_many：并行启动多个任务。
 */
export async function handleSubagentStartMany(rawInput: unknown, deps: SubagentTaskRunnerDependencies): Promise<SubagentStartManyOutput> {
  rejectDynamicMcpServers(rawInput);
  const input = subagentStartManyInputSchema.parse(rawInput) as SubagentStartManyInput;
  const started: SubagentStartOutput[] = [];
  const startedTaskIds: string[] = [];
  const rejected: SubagentStartManyOutput["rejected"] = [];

  for (const [index, item] of input.tasks.entries()) {
    if (deps.requestSignal?.aborted) {
      await cancelStartedTasks(startedTaskIds, deps, "MCP start_many call 已取消");
      throw new SubagentRuntimeError("cancelled", "MCP start_many call 已取消", { recoverable: true });
    }

    try {
      const active = await startSubagentTask({ input: item, keepAlive: item.keep_alive ?? false, conflictPolicy: input.conflict_policy }, deps);
      startedTaskIds.push(active.taskId);
      started.push({
        schema_version: 1,
        status: "started",
        task_id: active.taskId,
        agent_type: active.agentType,
        session_id: active.sessionId,
        created_at: active.createdAt.toISOString(),
        task_status: active.status,
        summary: `已启动子代理任务：${active.taskId}`
      });
    } catch (error) {
      const normalized = toSubagentError(error);
      rejected.push({ index, agent_type: item.agent_type, reason: normalized.user_message, error_code: normalized.code });
      if (input.on_task_failure === "cancel_all") {
        for (const taskId of startedTaskIds) {
          const task = deps.registry.get(taskId);
          if (task) await cancelActiveTask(task, "start_many 中有任务启动失败，按策略取消全部").catch(() => undefined);
        }
        break;
      }
    }
  }

  return {
    schema_version: 1,
    status: rejected.length ? "partial" : "started",
    started,
    rejected,
    summary: `已启动 ${started.length} 个子代理任务，拒绝 ${rejected.length} 个。`
  };
}


/**
 * 取消 start_many 已经启动成功的任务。
 */
async function cancelStartedTasks(taskIds: string[], deps: SubagentTaskRunnerDependencies, reason: string): Promise<void> {
  await Promise.allSettled(taskIds.map(async (taskId) => {
    const task = deps.registry.get(taskId);
    if (task) await cancelActiveTask(task, reason).catch(() => undefined);
  }));
}

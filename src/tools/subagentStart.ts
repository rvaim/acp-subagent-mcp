import type { SubagentStartInput, SubagentStartOutput } from "../task/types.js";
import type { SubagentTaskRunnerDependencies } from "../runtime/taskRunner.js";
import { startSubagentTask } from "../runtime/taskRunner.js";
import { rejectDynamicMcpServers } from "../runtime/security.js";
import { subagentStartInputSchema } from "./schemas.js";

/**
 * 处理 subagent_start：启动任务后立即返回 task_id。
 */
export async function handleSubagentStart(rawInput: unknown, deps: SubagentTaskRunnerDependencies): Promise<SubagentStartOutput> {
  rejectDynamicMcpServers(rawInput);
  const input = subagentStartInputSchema.parse(rawInput) as SubagentStartInput;
  const active = await startSubagentTask({ input, keepAlive: input.keep_alive ?? false, conflictPolicy: input.conflict_policy }, deps);
  return {
    schema_version: 1,
    status: "started",
    task_id: active.taskId,
    agent_type: active.agentType,
    session_id: active.sessionId,
    created_at: active.createdAt.toISOString(),
    task_status: active.status,
    summary: `已启动子代理任务：${active.taskId}`
  };
}

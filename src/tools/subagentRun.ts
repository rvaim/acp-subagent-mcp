import type { SubagentRunInput, SubagentRunOutput } from "../task/types.js";
import type { SubagentTaskRunnerDependencies } from "../runtime/taskRunner.js";
import { runSubagentTask } from "../runtime/taskRunner.js";
import { rejectDynamicMcpServers } from "../runtime/security.js";
import { subagentRunInputSchema } from "./schemas.js";

/**
 * 处理 subagent_run：同步运行一个子代理，完成后才返回。
 */
export async function handleSubagentRun(rawInput: unknown, deps: SubagentTaskRunnerDependencies): Promise<SubagentRunOutput> {
  rejectDynamicMcpServers(rawInput);
  const input = subagentRunInputSchema.parse(rawInput) as SubagentRunInput;
  return runSubagentTask(input, deps);
}

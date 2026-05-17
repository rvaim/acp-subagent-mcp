import type { SubagentReviseInput, SubagentRunOutput } from "../task/types.js";
import type { SubagentTaskRunnerDependencies } from "../runtime/taskRunner.js";
import { reviseSubagentTask } from "../runtime/taskRunner.js";
import { rejectDynamicMcpServers } from "../runtime/security.js";
import { subagentReviseInputSchema } from "./schemas.js";

/**
 * 处理 subagent_revise：同步打回重写。
 */
export async function handleSubagentRevise(rawInput: unknown, deps: SubagentTaskRunnerDependencies): Promise<SubagentRunOutput> {
  rejectDynamicMcpServers(rawInput);
  const input = subagentReviseInputSchema.parse(rawInput) as SubagentReviseInput;
  return reviseSubagentTask(input, deps);
}

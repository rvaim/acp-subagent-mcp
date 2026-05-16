import type { SubagentRunOutput, SubagentStartInput } from "../task/types.js";
import type { SubagentTaskRunnerDependencies } from "../runtime/taskRunner.js";
import { runSubagentTask } from "../runtime/taskRunner.js";
import { rejectDynamicMcpServers } from "../runtime/security.js";
import { subagentRunInputSchema } from "./schemas.js";

/**
 * 处理 subagent_run。
 */
export async function handleSubagentRun(rawInput: unknown, deps: SubagentTaskRunnerDependencies): Promise<SubagentRunOutput> {
  rejectDynamicMcpServers(rawInput);
  const input = subagentRunInputSchema.parse(rawInput) as SubagentStartInput;
  return runSubagentTask({ ...input, keep_alive: false }, deps);
}

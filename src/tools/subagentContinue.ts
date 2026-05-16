import type { SubagentContinueInput, SubagentContinueOutput } from "../task/types.js";
import type { SubagentTaskRunnerDependencies } from "../runtime/taskRunner.js";
import { continueSubagentTask } from "../runtime/taskRunner.js";
import { subagentContinueInputSchema } from "./schemas.js";

/**
 * 处理 subagent_continue：复用同一个 ACP session 发起下一轮 prompt。
 */
export async function handleSubagentContinue(rawInput: unknown, deps: SubagentTaskRunnerDependencies): Promise<SubagentContinueOutput> {
  const input = subagentContinueInputSchema.parse(rawInput) as SubagentContinueInput;
  return continueSubagentTask(input, deps);
}

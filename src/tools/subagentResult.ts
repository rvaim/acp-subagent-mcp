import { readFile } from "node:fs/promises";
import type { SubagentResultInput, SubagentResultOutput } from "../task/types.js";
import type { SubagentTaskRunnerDependencies } from "../runtime/taskRunner.js";
import { SubagentRuntimeError } from "../runtime/errors.js";
import { isFinishedTaskState } from "../runtime/taskRegistry.js";
import { toDisplayRelativePath } from "../runtime/security.js";
import { subagentResultInputSchema } from "./schemas.js";

/**
 * 处理 subagent_result：查询任务当前状态和结果。
 */
export async function handleSubagentResult(rawInput: unknown, deps: SubagentTaskRunnerDependencies): Promise<SubagentResultOutput> {
  const input = subagentResultInputSchema.parse(rawInput) as SubagentResultInput;
  const task = deps.registry.get(input.task_id);
  if (!task) throw new SubagentRuntimeError("invalid_input", `任务不存在：${input.task_id}`);

  const maxChars = input.max_chars ?? 4000;
  const partial = task.client?.getPartialText() || task.partialOutput;
  const eventsTail = input.include_events && task.logger
    ? await readTailText(task.logger.paths.eventsJsonl, maxChars).catch(() => undefined)
    : undefined;
  const result = isFinishedTaskState(task.status) ? cloneResult(task.result, input.include_raw_output) : undefined;

  return {
    schema_version: 1,
    task_id: task.taskId,
    agent_type: task.agentType,
    status: task.status,
    latest_summary: task.result?.summary,
    result,
    partial_output: !result && partial ? truncate(partial, maxChars) : undefined,
    raw_event_log_path: task.logger ? toDisplayRelativePath(task.cwd, task.logger.paths.eventsJsonl) : undefined,
    events_tail: eventsTail,
    summary: task.result?.summary ?? `任务 ${task.taskId} 当前状态：${task.status}`
  };
}

/**
 * 根据 include_raw_output 决定是否保留 structured.raw_output。
 */
function cloneResult(result: SubagentResultOutput["result"], includeRaw: boolean | undefined): SubagentResultOutput["result"] {
  if (!result) return undefined;
  if (includeRaw) return result;
  if (!result.structured?.raw_output) return result;
  return {
    ...result,
    structured: {
      ...result.structured,
      raw_output: undefined
    }
  };
}

/**
 * 读取文件尾部近似文本。
 */
async function readTailText(filePath: string, maxChars: number): Promise<string> {
  const content = await readFile(filePath, "utf8");
  return truncate(content.length > maxChars ? content.slice(-maxChars) : content, maxChars);
}

/**
 * 截断文本。
 */
function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n[TRUNCATED]` : text;
}

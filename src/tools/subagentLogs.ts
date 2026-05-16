import { readFile } from "node:fs/promises";
import type { SubagentLogsInput, SubagentLogsOutput } from "../task/types.js";
import type { SubagentTaskRunnerDependencies } from "../runtime/taskRunner.js";
import { SubagentRuntimeError } from "../runtime/errors.js";
import { redactText } from "../runtime/redact.js";
import { subagentLogsInputSchema } from "./schemas.js";

/**
 * 处理 subagent_logs：读取脱敏且截断后的本地日志。
 */
export async function handleSubagentLogs(rawInput: unknown, deps: SubagentTaskRunnerDependencies): Promise<SubagentLogsOutput> {
  const input = subagentLogsInputSchema.parse(rawInput) as SubagentLogsInput;
  const task = deps.registry.get(input.task_id);
  if (!task?.logger) throw new SubagentRuntimeError("invalid_input", `任务不存在或没有日志：${input.task_id}`);

  const logType = input.log_type ?? "events";
  const filePath = selectLogPath(task.logger.paths, logType);
  const raw = await readFile(filePath, "utf8").catch((error) => {
    throw new SubagentRuntimeError("invalid_input", `日志不可读取：${logType}`, { cause: error });
  });
  const maxBytes = input.max_bytes ?? 20000;
  const redacted = input.redacted ?? true;
  const content = redacted ? redactText(raw) : raw;
  const truncated = Buffer.byteLength(content, "utf8") > maxBytes;
  const finalContent = truncated ? content.slice(0, maxBytes) + "\n[TRUNCATED]" : content;

  return {
    schema_version: 1,
    task_id: input.task_id,
    log_type: logType,
    content: finalContent,
    truncated,
    summary: `已返回 ${logType} 日志片段。`
  };
}

/**
 * 根据日志类型选择实际路径。
 */
function selectLogPath(paths: { taskJson: string; renderedPrompt: string; eventsJsonl: string; stderrLog: string; resultJson: string }, logType: SubagentLogsInput["log_type"]): string {
  if (logType === "stderr") return paths.stderrLog;
  if (logType === "result") return paths.resultJson;
  if (logType === "prompt") return paths.renderedPrompt;
  if (logType === "task") return paths.taskJson;
  return paths.eventsJsonl;
}

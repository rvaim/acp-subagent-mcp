import type { InteractionDetailLevel, SubagentRunOutput } from "../task/types.js";

/**
 * 根据 detail_level 压缩工具输出。
 *
 * @param output 原始运行结果。
 * @param detailLevel 输出详情级别。
 * @param maxChars 最大文本字符数。
 * @returns 压缩后的运行结果。
 */
export function compactRunOutput(output: SubagentRunOutput, detailLevel: InteractionDetailLevel, maxChars: number): SubagentRunOutput {
  const compacted: SubagentRunOutput = { ...output };

  if (compacted.result.length > maxChars) {
    compacted.result = `${compacted.result.slice(0, maxChars)}\n\n[结果已截断，完整内容请查看 raw_event_log_path 或 result.json]`;
  }

  if (detailLevel === "summary") {
    delete compacted.tool_calls;
    if (compacted.files_touched && compacted.files_touched.length > 20) {
      compacted.files_touched = compacted.files_touched.slice(0, 20);
    }
  }

  if (detailLevel === "normal") {
    if (compacted.tool_calls && compacted.tool_calls.length > 20) {
      compacted.tool_calls = compacted.tool_calls.slice(0, 20);
    }
  }

  return compacted;
}

import type { SubagentStructuredResult } from "./types.js";

/**
 * 解析子代理输出结果。
 *
 * 解析策略：优先提取 JSON code block；如果没有 JSON code block，则尝试完整输出 JSON.parse；
 * 如果 parse 失败，则降级为 raw text，不因为非严格 JSON 直接判定工具失败。
 *
 * @param rawOutput 子代理原始文本输出。
 * @returns 结构化结果。
 */
export function parseSubagentResult(rawOutput: string): SubagentStructuredResult {
  const trimmed = rawOutput.trim();
  const jsonCandidate = extractJsonCodeBlock(trimmed) ?? trimmed;

  try {
    const parsed = JSON.parse(jsonCandidate) as Partial<SubagentStructuredResult>;
    return normalizeParsedResult(parsed, rawOutput);
  } catch {
    return fallbackTextResult(rawOutput);
  }
}

/**
 * 从 Markdown 文本中提取 JSON code block。
 *
 * @param text 原始文本。
 * @returns JSON 文本；未找到时返回 undefined。
 */
function extractJsonCodeBlock(text: string): string | undefined {
  const jsonBlock = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  return jsonBlock?.[1]?.trim();
}

/**
 * 将已解析 JSON 归一化成 SubagentStructuredResult。
 *
 * @param parsed 已解析对象。
 * @param rawOutput 原始输出。
 * @returns 归一化结构化结果。
 */
function normalizeParsedResult(parsed: Partial<SubagentStructuredResult>, rawOutput: string): SubagentStructuredResult {
  const status = parsed.status === "failed" || parsed.status === "partial" || parsed.status === "completed" ? parsed.status : "completed";
  const summary = typeof parsed.summary === "string" && parsed.summary.trim() ? parsed.summary : summarize(rawOutput);
  const result = typeof parsed.result === "string" && parsed.result.trim() ? parsed.result : rawOutput.trim();

  return {
    status,
    summary,
    result,
    findings: Array.isArray(parsed.findings) ? parsed.findings : undefined,
    files_changed: Array.isArray(parsed.files_changed) ? parsed.files_changed : undefined,
    risks: Array.isArray(parsed.risks) ? parsed.risks : undefined,
    next_steps: Array.isArray(parsed.next_steps) ? parsed.next_steps : undefined,
    errors: Array.isArray(parsed.errors) ? parsed.errors : undefined,
    raw_output: rawOutput,
  };
}

/**
 * 降级为文本结果。
 *
 * @param rawOutput 原始输出。
 * @returns 文本型结构化结果。
 */
function fallbackTextResult(rawOutput: string): SubagentStructuredResult {
  return {
    status: "completed",
    summary: summarize(rawOutput),
    result: rawOutput.trim(),
    raw_output: rawOutput,
  };
}

/**
 * 从原始输出中生成简短摘要。
 *
 * @param rawOutput 原始输出。
 * @returns 摘要文本。
 */
function summarize(rawOutput: string): string {
  const lines = rawOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const firstLine = lines[0] ?? "子代理未返回可见文本";
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
}

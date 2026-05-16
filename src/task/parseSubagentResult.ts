import type {
  FileChange,
  Finding,
  SubagentError,
  SubagentOutputOptions,
  SubagentRunOutput,
  SubagentRunStatus,
  SubagentStructuredResult,
  ToolCallSummary
} from "./types.js";
import { makeSubagentError } from "../runtime/errors.js";
import type { SkillPromptContext } from "../skills/skillBridge.js";

/**
 * 解析子代理输出。
 */
export function parseSubagentResult(rawText: string): SubagentStructuredResult {
  const trimmed = rawText.trim();
  const candidate = extractJsonCandidate(trimmed);

  if (candidate) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      return normalizeStructuredResult(parsed, rawText);
    } catch {
      // 降级到纯文本解析。
    }
  }

  return {
    status: "completed",
    summary: firstNonEmptyLine(trimmed) || "子代理已返回结果，但不是严格 JSON。",
    result: trimmed || "子代理没有返回可见文本。",
    raw_output: rawText,
    errors: [makeSubagentError("result_parse_failed", "子代理输出不是严格 JSON，已降级为文本结果", { recoverable: true })]
  };
}

/**
 * 根据 stopReason 和结构化结果推导最终状态。
 */
export function deriveRunStatus(stopReason: string | undefined, structured: SubagentStructuredResult, forcedStatus?: SubagentRunStatus): SubagentRunStatus {
  if (forcedStatus) return forcedStatus;
  if (stopReason === "cancelled") return "cancelled";
  if (stopReason === "max_tokens" || stopReason === "max_turn_requests") return "partial";
  if (stopReason === "refusal") return "failed";
  if (structured.status === "failed") return "failed";
  if (structured.status === "partial") return "partial";
  return "completed";
}

/**
 * 构造面向 MCP 的紧凑输出。
 */
export function buildRunOutput(options: {
  status: SubagentRunStatus;
  agentType: string;
  sessionId?: string;
  stopReason?: string;
  structured: SubagentStructuredResult;
  elapsedMs: number;
  artifacts?: SubagentRunOutput["artifacts"];
  toolCalls: ToolCallSummary[];
  filesTouched: string[];
  outputOptions: Required<SubagentOutputOptions>;
  skillContext?: SkillPromptContext;
  extraErrors?: SubagentError[];
}): SubagentRunOutput {
  const maxResultChars = options.outputOptions.max_result_chars;
  const rawResult = options.structured.result ?? options.structured.raw_output ?? "";
  const truncatedResult = rawResult.length > maxResultChars ? `${rawResult.slice(0, maxResultChars)}\n[TRUNCATED]` : rawResult;
  const maxFindings = options.outputOptions.max_findings;
  const findings = (options.structured.findings ?? []).slice(0, maxFindings);
  const errors = [...(options.structured.errors ?? []), ...(options.extraErrors ?? [])];
  const includeStructured = options.outputOptions.include_structured || options.outputOptions.mode === "full";
  const includeDiagnostics = options.outputOptions.include_diagnostics || options.outputOptions.mode === "full";

  return {
    schema_version: 1,
    status: options.status,
    agent_type: options.agentType,
    session_id: options.sessionId,
    summary: options.structured.summary,
    result: truncatedResult,
    findings: findings.length ? findings : undefined,
    files_changed: options.structured.files_changed,
    risks: options.structured.risks,
    next_steps: options.structured.next_steps,
    structured: includeStructured ? options.structured : undefined,
    stop_reason: options.stopReason,
    metrics: {
      elapsed_ms: options.elapsedMs,
      returned_result_chars: truncatedResult.length,
      original_result_chars: rawResult.length
    },
    artifacts: options.artifacts,
    skills: options.skillContext && options.skillContext.mode !== "off"
      ? {
          mode: options.skillContext.mode,
          names: Array.from(new Set([...options.skillContext.listed.map((skill) => skill.name), ...options.skillContext.inlined.map((skill) => skill.name)])),
          truncated: options.skillContext.truncated || undefined
        }
      : undefined,
    diagnostics: includeDiagnostics
      ? {
          tool_calls: options.toolCalls,
          files_touched: options.filesTouched
        }
      : undefined,
    truncated: rawResult.length > maxResultChars || (options.structured.findings ?? []).length > maxFindings,
    errors
  };
}

/**
 * 从文本中提取 JSON 候选。
 */
function extractJsonCandidate(text: string): string | undefined {
  if (!text) return undefined;

  const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (codeBlock?.[1]) return codeBlock[1].trim();

  if (text.startsWith("{") && text.endsWith("}")) return text;

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return text.slice(firstBrace, lastBrace + 1);
  }

  return undefined;
}

/**
 * 规范化结构化结果。
 */
function normalizeStructuredResult(parsed: Record<string, unknown>, rawText: string): SubagentStructuredResult {
  const status = parsed.status === "failed" || parsed.status === "partial" || parsed.status === "completed" ? parsed.status : "completed";
  const result = asString(parsed.result) ?? asString(parsed.details) ?? rawText.trim();
  const summary = asString(parsed.summary) ?? firstNonEmptyLine(result) ?? "子代理已完成任务。";

  return {
    status,
    summary,
    result,
    findings: normalizeFindings(parsed.findings),
    files_changed: normalizeFileChanges(parsed.files_changed),
    risks: normalizeStringArray(parsed.risks),
    next_steps: normalizeStringArray(parsed.next_steps),
    errors: normalizeErrors(parsed.errors),
    raw_output: rawText
  };
}

/**
 * 规范化 findings。
 */
function normalizeFindings(value: unknown): Finding[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, 100).map((item) => {
    if (typeof item === "string") return { detail: item };
    if (item && typeof item === "object") return item as Finding;
    return { detail: String(item) };
  });
}

/**
 * 规范化文件变更。
 */
function normalizeFileChanges(value: unknown): FileChange[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, 100).flatMap((item) => {
    if (typeof item === "string") return [{ path: item, action: "unknown" as const }];
    if (item && typeof item === "object" && "path" in item) return [item as FileChange];
    return [];
  });
}

/**
 * 规范化字符串数组。
 */
function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => String(item)).filter(Boolean);
}

/**
 * 规范化错误数组。
 */
function normalizeErrors(value: unknown): SubagentError[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((item) => {
    if (typeof item === "string") return [makeSubagentError("internal_error", item)];
    if (item && typeof item === "object" && "code" in item && "user_message" in item) return [item as SubagentError];
    return [];
  });
}

/**
 * 转字符串。
 */
function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * 取第一行非空文本。
 */
function firstNonEmptyLine(text: string): string | undefined {
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}

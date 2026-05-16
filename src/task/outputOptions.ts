import type { SubagentOutputOptions } from "./types.js";

/**
 * 规范化输出选项。
 *
 * compact 是默认值，用于减少主 agent token 消耗；full 才返回更多诊断信息。
 */
export function normalizeOutputOptions(options?: SubagentOutputOptions): Required<SubagentOutputOptions> {
  const mode = options?.mode ?? "compact";
  return {
    mode,
    max_result_chars: options?.max_result_chars ?? (mode === "compact" ? 4000 : mode === "standard" ? 8000 : 20000),
    max_findings: options?.max_findings ?? (mode === "compact" ? 8 : 30),
    include_diagnostics: options?.include_diagnostics ?? mode === "full",
    include_structured: options?.include_structured ?? mode === "full"
  };
}

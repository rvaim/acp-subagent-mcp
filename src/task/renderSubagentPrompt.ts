import type { EffectivePermissions } from "../runtime/permissions.js";
import type { SkillPromptContext } from "../skills/skillBridge.js";
import type { ResolvedTaskFile, SubagentMode, SubagentOutputOptions, SubagentTask } from "./types.js";

/**
 * 渲染后的子代理 prompt。
 */
export interface RenderedSubagentPrompt {
  /** 发送给 ACP agent 的主文本。 */
  text: string;
}

/**
 * 将结构化子代理任务渲染成稳定且相对紧凑的中文 prompt。
 */
export function renderSubagentPrompt(input: {
  /** 任务模式。 */
  mode: SubagentMode;
  /** 子代理任务。 */
  task: SubagentTask;
  /** 已校验文件。 */
  files: ResolvedTaskFile[];
  /** agent 配置中的系统提示词。 */
  systemPrompt?: string;
  /** 有效权限。 */
  permissions: EffectivePermissions;
  /** 输出压缩选项。 */
  output: Required<Pick<SubagentOutputOptions, "mode" | "max_result_chars" | "max_findings">>;
  /** 父代理 Skill 桥接上下文。 */
  skills?: SkillPromptContext;
}): RenderedSubagentPrompt {
  const lines: string[] = [];

  lines.push("# 子代理任务");
  lines.push("");
  if (input.systemPrompt?.trim()) {
    lines.push("## 系统约束");
    lines.push(input.systemPrompt.trim());
    lines.push("");
  }

  lines.push("## 工作模式");
  lines.push(`模式：${input.mode}`);
  lines.push(`权限：read=${input.permissions.canReadFiles ? "allow" : "deny"}, write=${input.permissions.canWriteFiles ? "allow" : "deny"}, execute=${input.permissions.canExecuteCommands ? "allow" : "deny"}, network=${input.permissions.canUseNetwork ? "allow" : "deny"}`);
  lines.push("");

  lines.push("## 任务");
  lines.push(`标题：${input.task.title}`);
  lines.push(`目标：${input.task.goal}`);
  appendOptionalBlock(lines, "背景", input.task.background);
  appendList(lines, "指令", input.task.instructions);
  appendList(lines, "约束", input.task.constraints);
  appendList(lines, "成功标准", input.task.success_criteria);

  if (input.task.parent_context) {
    lines.push("## 父代理上下文摘要");
    if (input.task.parent_context.parent_agent) lines.push(`父代理：${input.task.parent_context.parent_agent}`);
    if (input.task.parent_context.conversation_summary) lines.push(input.task.parent_context.conversation_summary);
    appendList(lines, "前序发现", input.task.parent_context.previous_findings);
    lines.push("");
  }

  appendFiles(lines, input.files);
  appendSkillContext(lines, input.skills);
  appendOutputContract(lines, input.output);

  return { text: lines.join("\n") };
}

/**
 * 添加可选文本块。
 */
function appendOptionalBlock(lines: string[], title: string, content?: string): void {
  if (!content?.trim()) return;
  lines.push(`## ${title}`);
  lines.push(content.trim());
  lines.push("");
}

/**
 * 添加列表块。
 */
function appendList(lines: string[], title: string, items?: string[]): void {
  if (!items || items.length === 0) return;
  lines.push(`## ${title}`);
  for (const item of items) lines.push(`- ${item}`);
  lines.push("");
}

/**
 * 添加文件表和内联片段。
 */
function appendFiles(lines: string[], files: ResolvedTaskFile[]): void {
  if (files.length === 0) return;

  lines.push("## 文件");
  lines.push("| path | role | action | mode | note |");
  lines.push("|---|---|---|---|---|");
  for (const file of files) {
    lines.push(`| ${escapeTable(file.relativePath)} | ${file.role} | ${file.action} | ${file.content_mode ?? "path_only"} | ${escapeTable(file.description ?? "")} |`);
  }
  lines.push("");

  for (const file of files) {
    if ((file.content_mode === "inline" || file.content_mode === "snippet") && file.content) {
      lines.push(`### ${file.content_mode === "snippet" ? "文件片段" : "内联文件"}：${file.relativePath}`);
      if (file.content_mode === "snippet") {
        lines.push("注意：这里只是片段，不要假设你看到了完整文件。");
      }
      if (file.line_ranges?.length) {
        lines.push(`行号范围：${file.line_ranges.map((range) => `${range.start}-${range.end}`).join(", ")}`);
      }
      lines.push("```text");
      lines.push(file.content);
      lines.push("```");
      lines.push("");
    }
  }
}

/**
 * 添加父代理 Skill 桥接上下文。
 */
function appendSkillContext(lines: string[], skills?: SkillPromptContext): void {
  if (!skills || skills.mode === "off" || (skills.listed.length === 0 && skills.inlined.length === 0)) return;

  lines.push("## 可用父代理 Skills");
  lines.push("以下 Skills 来自父代理环境中的 Agent Skills / Claude Code Skills 目录。为减少 token，默认只提供清单；只有明确要求 inline 时才内联完整 SKILL.md。");
  lines.push(`模式：${skills.mode}；已发现：${skills.discoveredCount}；已列出：${skills.listed.length}；已内联：${skills.inlined.length}${skills.truncated ? "；已截断" : ""}`);
  lines.push("");

  if (skills.listed.length > 0) {
    lines.push("| skill | source | description |");
    lines.push("|---|---|---|");
    for (const skill of skills.listed) {
      lines.push(`| /${escapeTable(skill.name)} | ${skill.source} | ${escapeTable(skill.description)} |`);
    }
    lines.push("");
  }

  for (const skill of skills.inlined) {
    lines.push(`### 内联 Skill：/${skill.name}`);
    lines.push(`来源：${skill.filePath}`);
    if (skill.truncated) lines.push("注意：该 SKILL.md 内容已按字符预算截断。");
    lines.push("```markdown");
    lines.push(skill.content);
    lines.push("```");
    lines.push("");
  }
}

/**
 * 添加输出契约。
 */
function appendOutputContract(lines: string[], output: Required<Pick<SubagentOutputOptions, "mode" | "max_result_chars" | "max_findings">>): void {
  lines.push("## 返回格式");
  lines.push("只返回一个 JSON 对象，不要包裹 markdown 代码块，不要输出隐藏推理。");
  lines.push(`输出模式：${output.mode}。summary 尽量不超过 160 字；result 尽量不超过 ${output.max_result_chars} 字；findings 最多 ${output.max_findings} 条。`);
  lines.push("JSON 结构：");
  lines.push('{"status":"completed|failed|partial","summary":"一句话总结","result":"主要结论或补丁说明","findings":[],"files_changed":[],"risks":[],"next_steps":[],"errors":[]}');
  lines.push("");
}

/**
 * 转义 markdown 表格单元格。
 */
function escapeTable(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/**
 * 将 continue 输入渲染为紧凑的后续 prompt。
 */
export function renderSubagentContinuePrompt(input: {
  /** 继续模式。 */
  mode: "revise" | "fix" | "clarify" | "continue" | "custom";
  /** 主代理的新消息。 */
  message: string;
  /** 可选纠正说明。 */
  correction?: {
    reason: string;
    rejected_result?: string;
    expected_change?: string;
  };
  /** 本轮新增文件。 */
  files: ResolvedTaskFile[];
  /** 输出压缩选项。 */
  output: Required<Pick<SubagentOutputOptions, "mode" | "max_result_chars" | "max_findings">>;
  /** 父代理 Skill 桥接上下文。 */
  skills?: SkillPromptContext;
}): RenderedSubagentPrompt {
  const lines: string[] = [];
  lines.push("# 子代理继续任务");
  lines.push("");
  lines.push(`模式：${input.mode}`);
  lines.push("请基于同一个 ACP session 的上下文继续，不要重复解释已完成内容；只返回最终 JSON。");
  lines.push("");
  lines.push("## 主代理消息");
  lines.push(input.message.trim());
  lines.push("");

  if (input.correction) {
    lines.push("## 纠正说明");
    lines.push(`原因：${input.correction.reason}`);
    if (input.correction.rejected_result) lines.push(`被拒绝的上一轮结果摘要：${input.correction.rejected_result}`);
    if (input.correction.expected_change) lines.push(`期望修正：${input.correction.expected_change}`);
    lines.push("");
  }

  appendFiles(lines, input.files);
  appendSkillContext(lines, input.skills);
  appendOutputContract(lines, input.output);
  return { text: lines.join("\n") };
}

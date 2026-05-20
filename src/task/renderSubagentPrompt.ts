import type { SubagentTask, TaskFile } from "./types.js";

/**
 * 渲染子代理 prompt 的输入参数。
 */
export interface RenderSubagentPromptInput {
  /** 任务模式。 */
  mode?: string;

  /** 子代理任务。 */
  task: SubagentTask;

  /** agent 配置中的系统提示词。 */
  systemPrompt?: string;

  /** 会话池里保存的历史摘要。 */
  conversationSummary?: string;
}

/**
 * 将结构化子代理任务渲染成稳定的中文 prompt。
 *
 * 该函数负责把任务目标、文件列表、约束、成功标准、返回格式等信息
 * 转换成子代理可以直接理解并执行的自然语言指令。
 *
 * @param input prompt 渲染输入。
 * @returns 渲染后的 prompt 文本。
 */
export function renderSubagentPrompt(input: RenderSubagentPromptInput): string {
  const lines: string[] = [];
  const task = input.task;

  if (input.systemPrompt?.trim()) {
    lines.push("# 子代理系统说明", "", input.systemPrompt.trim(), "");
  }

  lines.push(
    "# 子代理任务",
    "",
    "你是一个被父代理调用的子代理。你需要独立完成下面的任务。",
    "",
    "## 工作模式",
    "",
    `模式：${input.mode ?? "analyze"}`,
    "",
    "你必须遵守：",
    "",
    "- 只处理本任务明确要求的内容。",
    "- 优先使用给定的工作目录和文件列表。",
    "- 不要请求父代理重复提供已经给出的信息。",
    "- 不要输出隐藏推理过程。",
    "- 返回结果必须符合“返回格式约定”。",
    "- 如遇到权限不足、文件不存在、命令失败，必须在 errors 中说明。",
    "",
    "## 任务标题",
    "",
    task.title,
    "",
    "## 任务目标",
    "",
    task.goal,
    "",
  );

  if (task.background?.trim()) {
    lines.push("## 背景信息", "", task.background.trim(), "");
  }

  if (task.instructions?.length) {
    lines.push("## 具体执行指令", "");
    for (const instruction of task.instructions) {
      lines.push(`- ${instruction}`);
    }
    lines.push("");
  }

  renderParentContext(lines, task, input.conversationSummary);
  renderFiles(lines, task.files ?? []);
  renderConstraints(lines, task.constraints ?? []);
  renderSuccessCriteria(lines, task.success_criteria ?? []);
  renderExpectedOutput(lines, task);

  return lines.join("\n");
}

/**
 * 渲染父代理压缩上下文。
 *
 * @param lines 输出行数组。
 * @param task 子代理任务。
 * @param pooledSummary 会话池历史摘要。
 */
function renderParentContext(lines: string[], task: SubagentTask, pooledSummary?: string): void {
  const context = task.parent_context;
  if (!context && !pooledSummary) {
    return;
  }

  lines.push("## 父代理上下文摘要", "");
  if (context?.parent_agent) {
    lines.push(`父代理：${context.parent_agent}`);
  }
  if (context?.conversation_summary) {
    lines.push("", "当前任务相关对话摘要：", context.conversation_summary.trim());
  }
  if (pooledSummary) {
    lines.push("", "可复用会话历史摘要：", pooledSummary.trim());
  }
  if (context?.previous_findings?.length) {
    lines.push("", "前序发现：");
    for (const finding of context.previous_findings) {
      lines.push(`- ${finding}`);
    }
  }
  lines.push("");
}

/**
 * 渲染任务文件列表。
 *
 * @param lines 输出行数组。
 * @param files 文件列表。
 */
function renderFiles(lines: string[], files: TaskFile[]): void {
  lines.push("## 需要处理的文件", "");

  if (!files.length) {
    lines.push("本任务没有显式指定文件。", "");
  } else {
    lines.push("| path | role | action | content_mode | description |", "|---|---|---|---|---|");
    for (const file of files) {
      lines.push(
        `| ${escapeTable(file.path)} | ${file.role} | ${file.action} | ${file.content_mode ?? "path_only"} | ${escapeTable(file.description ?? "")} |`,
      );
    }
    lines.push("");
  }

  lines.push(
    "## 文件处理规则",
    "",
    "- action=read：只读取，不修改。",
    "- action=review：读取并审查，不修改。",
    "- action=edit：可以修改。",
    "- action=create：可以创建。",
    "- action=delete：只有明确要求时才可以删除。",
    "- content_mode=path_only：请在 cwd 下自行读取文件。",
    "- content_mode=inline：文件内容已内联在任务中。",
    "- content_mode=snippet：只提供了片段，不要假设看到完整文件。",
    "",
  );

  for (const file of files) {
    if (file.content_mode === "inline" && file.content) {
      lines.push(`### 内联文件：${file.path}`, "", "```", file.content, "```", "");
    }
    if (file.content_mode === "snippet" && file.content) {
      const ranges = (file.line_ranges ?? []).map((range) => `${range.start}-${range.end}`).join(", ") || "未指定行号";
      lines.push(`### 文件片段：${file.path}`, "", `行号范围：${ranges}`, "", "```", file.content, "```", "");
    }
  }
}

/**
 * 渲染任务约束。
 *
 * @param lines 输出行数组。
 * @param constraints 约束列表。
 */
function renderConstraints(lines: string[], constraints: string[]): void {
  if (!constraints.length) {
    return;
  }
  lines.push("## 任务约束", "");
  for (const constraint of constraints) {
    lines.push(`- ${constraint}`);
  }
  lines.push("");
}

/**
 * 渲染成功标准。
 *
 * @param lines 输出行数组。
 * @param successCriteria 成功标准列表。
 */
function renderSuccessCriteria(lines: string[], successCriteria: string[]): void {
  if (!successCriteria.length) {
    return;
  }
  lines.push("## 成功标准", "");
  for (const item of successCriteria) {
    lines.push(`- ${item}`);
  }
  lines.push("");
}

/**
 * 渲染期望输出和 JSON 返回契约。
 *
 * @param lines 输出行数组。
 * @param task 子代理任务。
 */
function renderExpectedOutput(lines: string[], task: SubagentTask): void {
  const expected = task.expected_output;
  lines.push("## 返回格式约定", "");
  lines.push("请只返回最终结果，优先使用 JSON。不要输出隐藏推理过程。", "");

  if (expected) {
    lines.push(`期望格式：${expected.format}`);
    if (expected.required_sections?.length) {
      lines.push(`必须包含章节：${expected.required_sections.join(", ")}`);
    }
    if (expected.include_files_changed) {
      lines.push("需要返回 files_changed。 ");
    }
    if (expected.include_risks) {
      lines.push("需要返回 risks。 ");
    }
    if (expected.include_next_steps) {
      lines.push("需要返回 next_steps。 ");
    }
    lines.push("");
  }

  lines.push(
    "```json",
    JSON.stringify(
      {
        status: "completed | failed | partial",
        summary: "一句话总结",
        result: "主要结论或最终答案",
        findings: [],
        files_changed: [],
        risks: [],
        next_steps: [],
        errors: [],
      },
      null,
      2,
    ),
    "```",
    "",
  );
}

/**
 * 转义 Markdown 表格单元格。
 *
 * @param value 原始单元格文本。
 * @returns 转义后的文本。
 */
function escapeTable(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

import type { ToolCallSummary } from "../task/types.js";

/**
 * ACP session/update 聚合器。
 */
export class AcpEventAggregator {
  /** agent 输出文本分片。 */
  private readonly textChunks: string[] = [];
  /** 工具调用记录。 */
  private readonly toolCalls = new Map<string, ToolCallSummary>();
  /** 触碰文件集合。 */
  private readonly filesTouched = new Set<string>();

  /**
   * 清空当前 prompt turn 的聚合内容。
   */
  reset(): void {
    this.textChunks.length = 0;
    this.toolCalls.clear();
    this.filesTouched.clear();
  }

  /**
   * 聚合一条 session/update。
   */
  handleSessionUpdate(params: unknown): void {
    if (!params || typeof params !== "object") return;
    const update = (params as { update?: unknown }).update;
    if (!update || typeof update !== "object") return;

    const record = update as Record<string, unknown>;
    const kind = String(record.sessionUpdate ?? "");

    if (kind === "agent_message_chunk" || kind === "assistant_message_chunk") {
      const text = extractContentText(record.content);
      if (text) this.textChunks.push(text);
      return;
    }

    if (kind === "tool_call") {
      const id = String(record.toolCallId ?? record.id ?? "");
      if (id) {
        this.toolCalls.set(id, {
          id,
          title: asOptionalString(record.title),
          kind: asOptionalString(record.kind),
          status: asOptionalString(record.status)
        });
      }
      return;
    }

    if (kind === "tool_call_update") {
      const id = String(record.toolCallId ?? record.id ?? "");
      if (id) {
        const previous = this.toolCalls.get(id) ?? { id };
        this.toolCalls.set(id, {
          ...previous,
          status: asOptionalString(record.status) ?? previous.status
        });
      }
      const text = extractToolUpdateText(record.content);
      if (text) this.textChunks.push(text);
      return;
    }

    // 某些 agent 可能在 update 中携带文件路径，尽量宽容记录。
    const filePath = asOptionalString(record.path ?? record.filePath ?? record.file);
    if (filePath) this.filesTouched.add(filePath);
  }

  /**
   * 主动记录文件触碰。
   */
  recordFileTouched(filePath: string): void {
    this.filesTouched.add(filePath);
  }

  /**
   * 获取聚合后的 agent 文本。
   */
  getText(): string {
    return this.textChunks.join("");
  }

  /**
   * 获取工具调用摘要。
   */
  getToolCalls(): ToolCallSummary[] {
    return Array.from(this.toolCalls.values());
  }

  /**
   * 获取触碰文件路径。
   */
  getFilesTouched(): string[] {
    return Array.from(this.filesTouched.values());
  }
}

/**
 * 提取 ACP ContentBlock 文本。
 */
function extractContentText(content: unknown): string | undefined {
  if (!content || typeof content !== "object") return undefined;
  const record = content as Record<string, unknown>;
  if (record.type === "text" && typeof record.text === "string") return record.text;
  return undefined;
}

/**
 * 提取 tool update 中的文本。
 */
function extractToolUpdateText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const chunks: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const inner = (item as { content?: unknown }).content;
    const text = extractContentText(inner);
    if (text) chunks.push(text);
  }
  return chunks.join("");
}

/**
 * 安全转换可选字符串。
 */
function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

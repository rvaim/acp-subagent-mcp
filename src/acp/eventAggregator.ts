import type { AcpSessionUpdateParams, JsonRpcNotification } from "./types.js";
import type { ToolCallSummary } from "../task/types.js";

/**
 * ACP 事件聚合结果。
 */
export interface AggregatedAcpEvents {
  /** 聚合后的 agent 文本输出。 */
  textOutput: string;

  /** 工具调用摘要列表。 */
  toolCalls: ToolCallSummary[];

  /** 触碰过的文件路径。 */
  filesTouched: string[];

  /** 最新一条可见摘要。 */
  latestSummary?: string;
}

/**
 * ACP session/update 事件聚合器。
 *
 * 该类把 agent 的流式 update 压缩成主代理真正需要的摘要：文本输出、工具调用摘要、
 * 文件列表和最新摘要；完整事件已经由传输层写入 events.jsonl。
 */
export class AcpEventAggregator {
  /** 文本输出片段。 */
  private readonly textChunks: string[] = [];

  /** 工具调用摘要，key 为 toolCallId。 */
  private readonly toolCallsById = new Map<string, ToolCallSummary>();

  /** 触碰过的文件路径集合。 */
  private readonly filesTouchedSet = new Set<string>();

  /** 最新一条可见摘要。 */
  private latestSummaryValue: string | undefined;

  /**
   * 处理一条 ACP 通知。
   *
   * @param notification ACP 通知。
   * @returns 当通知代表有意义进展时返回 true。
   */
  handleNotification(notification: JsonRpcNotification): boolean {
    if (notification.method !== "session/update") {
      return false;
    }

    const params = notification.params as AcpSessionUpdateParams;
    const update = params.update ?? {};
    const updateType = String(update.sessionUpdate ?? "");

    if (updateType === "agent_message_chunk") {
      const text = extractTextContent(update.content);
      if (text) {
        this.textChunks.push(text);
        this.latestSummaryValue = summarizeText(text);
        return true;
      }
    }

    if (updateType === "tool_call" || updateType === "tool_call_update") {
      this.mergeToolCall(update);
      return true;
    }

    if (updateType === "plan") {
      this.latestSummaryValue = "子代理更新了执行计划";
      return true;
    }

    this.collectFiles(update);
    return Object.keys(update).length > 0;
  }

  /**
   * 获取聚合结果。
   *
   * @returns 聚合后的事件摘要。
   */
  result(): AggregatedAcpEvents {
    return {
      textOutput: this.textChunks.join(""),
      toolCalls: Array.from(this.toolCallsById.values()),
      filesTouched: Array.from(this.filesTouchedSet.values()),
      latestSummary: this.latestSummaryValue,
    };
  }

  /**
   * 合并工具调用状态。
   *
   * @param update ACP update 对象。
   */
  private mergeToolCall(update: Record<string, unknown>): void {
    const id = String(update.toolCallId ?? update.id ?? `tool_${this.toolCallsById.size + 1}`);
    const existing = this.toolCallsById.get(id) ?? { tool_call_id: id };

    const next: ToolCallSummary = {
      ...existing,
      title: typeof update.title === "string" ? update.title : existing.title,
      kind: typeof update.kind === "string" ? update.kind : existing.kind,
      status: typeof update.status === "string" ? update.status : existing.status,
      summary: typeof update.summary === "string" ? update.summary : existing.summary,
    };

    this.toolCallsById.set(id, next);
    this.latestSummaryValue = next.title ? `工具调用：${next.title} (${next.status ?? "unknown"})` : "子代理更新了工具调用状态";
    this.collectFiles(update);
  }

  /**
   * 从任意 update 中收集文件路径字段。
   *
   * @param value 待扫描对象。
   */
  private collectFiles(value: unknown): void {
    if (Array.isArray(value)) {
      for (const item of value) {
        this.collectFiles(item);
      }
      return;
    }

    if (!value || typeof value !== "object") {
      return;
    }

    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      const normalizedKey = key.toLowerCase();
      if ((normalizedKey === "path" || normalizedKey.endsWith("path") || normalizedKey === "uri") && typeof nestedValue === "string") {
        const filePath = nestedValue.startsWith("file://") ? nestedValue.slice("file://".length) : nestedValue;
        this.filesTouchedSet.add(filePath);
      }
      this.collectFiles(nestedValue);
    }
  }
}

/**
 * 从 ACP content 对象中提取文本。
 *
 * @param content ACP content 字段。
 * @returns 文本内容。
 */
function extractTextContent(content: unknown): string {
  if (!content || typeof content !== "object") {
    return "";
  }

  const contentRecord = content as Record<string, unknown>;
  if (contentRecord.type === "text" && typeof contentRecord.text === "string") {
    return contentRecord.text;
  }

  if (typeof contentRecord.text === "string") {
    return contentRecord.text;
  }

  return "";
}

/**
 * 生成短摘要。
 *
 * @param text 原始文本。
 * @returns 截断后的摘要。
 */
function summarizeText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

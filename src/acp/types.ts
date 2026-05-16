import type { ContentBlock, InitializeResponse, NewSessionResponse } from "@agentclientprotocol/sdk";
import type { ToolCallSummary } from "../task/types.js";

/**
 * ACP 内容块。
 *
 * 该类型直接来自官方 `@agentclientprotocol/sdk`，避免在本项目中重复手写 ACP schema。
 */
export type AcpContentBlock = ContentBlock;

/**
 * ACP initialize 返回结果。
 *
 * 该类型直接复用官方 `@agentclientprotocol/sdk` 的 `InitializeResponse`。
 */
export type AcpInitializeResult = InitializeResponse;

/**
 * ACP session/new 返回结果。
 *
 * 该类型直接复用官方 `@agentclientprotocol/sdk` 的 `NewSessionResponse`。
 */
export type AcpNewSessionResult = NewSessionResponse;

/**
 * ACP prompt 聚合结果。
 *
 * ACP `session/prompt` 的协议响应只包含 stopReason 等元信息；
 * 真实文本、工具调用和文件触碰信息来自 `session/update`，因此本项目在 SDK 之上保留该内部聚合类型。
 */
export interface AcpPromptResult {
  /** ACP stop reason。 */
  stopReason: string;
  /** 从 session/update 聚合出的 agent 文本。 */
  text: string;
  /** 工具调用摘要。 */
  toolCalls: ToolCallSummary[];
  /** 子代理触碰过的文件。 */
  filesTouched: string[];
}

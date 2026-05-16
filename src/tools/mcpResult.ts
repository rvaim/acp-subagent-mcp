import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { SubagentRunOutput } from "../task/types.js";
import { toSubagentError } from "../runtime/errors.js";

/**
 * 转为 MCP tool result，同时提供 text 和 structuredContent。
 */
export function toMcpResult(output: Record<string, unknown> | SubagentRunOutput | object): CallToolResult {
  const record = output as Record<string, unknown>;
  const summary = typeof record.summary === "string" ? record.summary : JSON.stringify(output);
  const status = typeof record.status === "string" ? record.status : undefined;
  const isError = status === "failed" || status === "timeout" || status === "cancelled";
  return {
    content: [{ type: "text", text: summary }],
    structuredContent: output,
    isError: isError || undefined
  } as CallToolResult;
}

/**
 * 转为 MCP tool 错误结果。
 */
export function toMcpError(error: unknown): CallToolResult {
  const normalized = toSubagentError(error, "invalid_input");
  return {
    isError: true,
    content: [{ type: "text", text: normalized.user_message }],
    structuredContent: {
      schema_version: 1,
      status: "failed",
      summary: normalized.user_message,
      errors: [normalized]
    }
  } as CallToolResult;
}

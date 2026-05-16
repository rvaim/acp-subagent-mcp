import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { AppConfig } from "./config/types.js";
import { ConcurrencyManager } from "./runtime/concurrency.js";
import { TaskRegistry } from "./runtime/taskRegistry.js";
import { handleSubagentList } from "./tools/subagentList.js";
import { handleSubagentRun } from "./tools/subagentRun.js";
import { handleSubagentStart } from "./tools/subagentStart.js";
import { handleSubagentStartMany } from "./tools/subagentStartMany.js";
import { handleSubagentWait } from "./tools/subagentWait.js";
import { handleSubagentResult } from "./tools/subagentResult.js";
import { handleSubagentContinue } from "./tools/subagentContinue.js";
import { handleSubagentCancel } from "./tools/subagentCancel.js";
import { handleSubagentClose } from "./tools/subagentClose.js";
import { handleSubagentLogs } from "./tools/subagentLogs.js";
import { handleSubagentSkills, subagentSkillsInputJsonSchema, subagentSkillsOutputJsonSchema } from "./tools/subagentSkills.js";
import { toMcpError, toMcpResult } from "./tools/mcpResult.js";
import {
  genericToolOutputJsonSchema,
  subagentCancelInputJsonSchema,
  subagentCloseInputJsonSchema,
  subagentContinueInputJsonSchema,
  subagentListInputJsonSchema,
  subagentListOutputJsonSchema,
  subagentLogsInputJsonSchema,
  subagentResultInputJsonSchema,
  subagentRunInputJsonSchema,
  subagentRunOutputJsonSchema,
  subagentStartInputJsonSchema,
  subagentStartManyInputJsonSchema,
  subagentWaitInputJsonSchema
} from "./tools/schemas.js";

/**
 * 启动 MCP Server。
 */
export async function startMcpServer(config: AppConfig): Promise<void> {
  const concurrency = new ConcurrencyManager();
  const registry = new TaskRegistry();
  const deps = { config, concurrency, registry };
  const server = new Server(
    {
      name: "acp-subagent-mcp",
      version: "0.3.0"
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: buildToolDefinitions()
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      if (name === "subagent_list") return toMcpResult(handleSubagentList(config));
      if (name === "subagent_run") return toMcpResult(await handleSubagentRun(args ?? {}, deps));
      if (name === "subagent_skills") return toMcpResult(await handleSubagentSkills(args ?? {}, config));
      if (name === "subagent_start") return toMcpResult(await handleSubagentStart(args ?? {}, deps));
      if (name === "subagent_start_many") return toMcpResult(await handleSubagentStartMany(args ?? {}, deps));
      if (name === "subagent_wait") return toMcpResult(await handleSubagentWait(args ?? {}, deps));
      if (name === "subagent_result") return toMcpResult(await handleSubagentResult(args ?? {}, deps));
      if (name === "subagent_continue") return toMcpResult(await handleSubagentContinue(args ?? {}, deps));
      if (name === "subagent_cancel") return toMcpResult(await handleSubagentCancel(args ?? {}, deps));
      if (name === "subagent_close") return toMcpResult(await handleSubagentClose(args ?? {}, deps));
      if (name === "subagent_logs") return toMcpResult(await handleSubagentLogs(args ?? {}, deps));

      return toMcpError(new Error(`未知工具：${name}`));
    } catch (error) {
      return toMcpError(error);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/**
 * 构造工具定义。
 *
 * 描述保持短句，长说明放在 README 中，减少主 agent 的工具列表 token。
 */
function buildToolDefinitions(): Tool[] {
  return [
    {
      name: "subagent_list",
      description: "列出可用 ACP 子代理、默认 agent 和 Skill 桥接状态。",
      inputSchema: subagentListInputJsonSchema,
      outputSchema: subagentListOutputJsonSchema,
      annotations: { title: "List subagents", readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    } as unknown as Tool,
    {
      name: "subagent_run",
      description: "同步运行子代理任务；agent_type 可省略，默认 claude；默认紧凑输出。",
      inputSchema: subagentRunInputJsonSchema,
      outputSchema: subagentRunOutputJsonSchema,
      annotations: { title: "Run subagent", readOnlyHint: false, destructiveHint: true, idempotentHint: false }
    } as unknown as Tool,
    {
      name: "subagent_skills",
      description: "列出可桥接给子代理的父代理 Skills 短清单。",
      inputSchema: subagentSkillsInputJsonSchema,
      outputSchema: subagentSkillsOutputJsonSchema,
      annotations: { title: "List parent skills", readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    } as unknown as Tool,
    {
      name: "subagent_start",
      description: "异步启动子代理任务；agent_type 可省略，默认 claude。",
      inputSchema: subagentStartInputJsonSchema,
      outputSchema: genericToolOutputJsonSchema,
      annotations: { title: "Start subagent", readOnlyHint: false, destructiveHint: true, idempotentHint: false }
    } as unknown as Tool,
    {
      name: "subagent_start_many",
      description: "并行启动多个子代理任务。",
      inputSchema: subagentStartManyInputJsonSchema,
      outputSchema: genericToolOutputJsonSchema,
      annotations: { title: "Start many subagents", readOnlyHint: false, destructiveHint: true, idempotentHint: false }
    } as unknown as Tool,
    {
      name: "subagent_wait",
      description: "等待一个或多个任务完成或产生更新。",
      inputSchema: subagentWaitInputJsonSchema,
      outputSchema: genericToolOutputJsonSchema,
      annotations: { title: "Wait subagents", readOnlyHint: true, destructiveHint: false, idempotentHint: false }
    } as unknown as Tool,
    {
      name: "subagent_result",
      description: "查询任务状态、结果或部分输出。",
      inputSchema: subagentResultInputJsonSchema,
      outputSchema: genericToolOutputJsonSchema,
      annotations: { title: "Get subagent result", readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    } as unknown as Tool,
    {
      name: "subagent_continue",
      description: "复用 keep_alive session 继续一轮任务。",
      inputSchema: subagentContinueInputJsonSchema,
      outputSchema: genericToolOutputJsonSchema,
      annotations: { title: "Continue subagent", readOnlyHint: false, destructiveHint: true, idempotentHint: false }
    } as unknown as Tool,
    {
      name: "subagent_cancel",
      description: "取消一个或多个任务。",
      inputSchema: subagentCancelInputJsonSchema,
      outputSchema: genericToolOutputJsonSchema,
      annotations: { title: "Cancel subagents", readOnlyHint: false, destructiveHint: true, idempotentHint: false }
    } as unknown as Tool,
    {
      name: "subagent_close",
      description: "关闭任务和保留的 session。",
      inputSchema: subagentCloseInputJsonSchema,
      outputSchema: genericToolOutputJsonSchema,
      annotations: { title: "Close subagent", readOnlyHint: false, destructiveHint: false, idempotentHint: false }
    } as unknown as Tool,
    {
      name: "subagent_logs",
      description: "读取脱敏且截断后的任务日志。",
      inputSchema: subagentLogsInputJsonSchema,
      outputSchema: genericToolOutputJsonSchema,
      annotations: { title: "Read subagent logs", readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    } as unknown as Tool
  ];
}

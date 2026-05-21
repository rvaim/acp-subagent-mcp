import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ServerConfig } from "./config/types.js";
import { SubagentRuntime } from "./runtime/subagentRuntime.js";
import {
  subagentCancelSchema,
  subagentCloseSchema,
  subagentContinueSchema,
  subagentLogsSchema,
  subagentResultSchema,
  subagentRunSchema,
  subagentStartManySchema,
  subagentStartSchema,
  subagentWaitSchema,
} from "./tools/schemas.js";

/**
 * MCP Server 创建结果。
 */
export interface CreatedServer {
  /** MCP Server 实例。 */
  server: McpServer;

  /** 子代理运行时。 */
  runtime: SubagentRuntime;
}

/**
 * 创建并注册所有 MCP tools。
 *
 * @param config 已加载的服务器配置。
 * @returns MCP Server 与运行时对象。
 */
export function createServer(config: ServerConfig): CreatedServer {
  const runtime = new SubagentRuntime(config);
  const server = new McpServer(
    { name: "@rvaim/acp-subagent-mcp", version: "0.1.11" },
    {
      instructions:
        "这是一个通用 ACP 子代理编排 MCP Server。优先使用 subagent_list 查看可用子代理；短任务使用 subagent_run；需要并行、多轮或取消时使用 subagent_start/subagent_wait/subagent_continue/subagent_cancel/subagent_close。",
    },
  );

  server.registerTool(
    "subagent_list",
    {
      title: "列出可用子代理",
      description: "列出 agents.toml 中配置的子代理，只返回 name、description 和 capabilities，不暴露 command、env 或敏感路径。",
      inputSchema: {},
    },
    async () => toToolResult(runtime.listAgents()),
  );

  server.registerTool(
    "subagent_run",
    {
      title: "同步运行子代理任务",
      description: "拉起或复用一个 ACP 子代理 session，发送结构化任务，等待结果并返回压缩后的结构化输出。",
      inputSchema: subagentRunSchema,
    },
    async (input, extra) => toToolResult(await runtime.run(input, extra.signal)),
  );

  server.registerTool(
    "subagent_start",
    {
      title: "启动有状态子代理任务",
      description: "启动一个子代理任务并立即返回 task_id，适合异步等待、取消或后续 continue。",
      inputSchema: subagentStartSchema,
    },
    async (input, extra) => toToolResult(await runtime.start(input, extra.signal)),
  );

  server.registerTool(
    "subagent_start_many",
    {
      title: "并行启动多个子代理任务",
      description: "并行启动多个子代理任务，返回每个任务的 task_id。",
      inputSchema: subagentStartManySchema,
    },
    async (input, extra) => toToolResult(await runtime.startMany(input, extra.signal)),
  );

  server.registerTool(
    "subagent_wait",
    {
      title: "等待子代理任务",
      description: "等待一个或多个子代理任务，支持 all_completed、first_completed、first_success、first_failure、any_update、timeout_partial。",
      inputSchema: subagentWaitSchema,
    },
    async (input, extra) => toToolResult(await runtime.wait(input, extra.signal)),
  );

  server.registerTool(
    "subagent_result",
    {
      title: "查询子代理任务结果",
      description: "查询某个 task_id 的当前状态、部分输出或最终结果。",
      inputSchema: subagentResultSchema,
    },
    async (input) => toToolResult(runtime.result(input)),
  );

  server.registerTool(
    "subagent_continue",
    {
      title: "继续子代理会话",
      description: "对 subagent_start 创建且 keep_alive=true 的同一个 ACP session 继续发送消息。",
      inputSchema: subagentContinueSchema,
    },
    async (input, extra) => toToolResult(await runtime.continue(input, extra.signal)),
  );

  server.registerTool(
    "subagent_cancel",
    {
      title: "取消子代理任务",
      description: "取消一个或多个任务，优先发送 ACP session/cancel，然后清理子进程。",
      inputSchema: subagentCancelSchema,
    },
    async (input) => toToolResult(await runtime.cancel(input)),
  );

  server.registerTool(
    "subagent_close",
    {
      title: "关闭子代理任务",
      description: "关闭已完成或不再需要的有状态 session，并保留日志。",
      inputSchema: subagentCloseSchema,
    },
    async (input) => toToolResult(await runtime.close(input)),
  );

  server.registerTool(
    "subagent_logs",
    {
      title: "读取子代理日志",
      description: "读取任务日志文件尾部，默认只读取 events 日志，避免把完整日志塞回主代理上下文。",
      inputSchema: subagentLogsSchema,
    },
    async (input) => toToolResult(await runtime.logs(input)),
  );

  return { server, runtime };
}

/**
 * 通过 stdio 启动 MCP Server。
 *
 * @param config 已加载的服务器配置。
 */
export async function startStdioServer(config: ServerConfig): Promise<void> {
  const { server, runtime } = createServer(config);
  const transport = new StdioServerTransport();

  let shuttingDown = false;

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    await runtime.shutdown();
  };

  const shutdownAndExit = (): void => {
    void shutdown().finally(() => process.exit(0));
  };

  process.once("SIGINT", shutdownAndExit);
  process.once("SIGTERM", shutdownAndExit);

  // MCP Host 关闭 stdio 连接时，必须清理所有仍在运行或池化的子代理进程。
  process.stdin.once("end", shutdownAndExit);
  process.stdin.once("close", shutdownAndExit);

  transport.onclose = () => {
    void shutdown();
  };

  await server.connect(transport);
}

/**
 * 将普通对象包装成 MCP tool result。
 *
 * @param value 结构化输出。
 * @returns MCP tool 返回值。
 */
function toToolResult(value: unknown): CallToolResult {
  const text = JSON.stringify(value, null, 2);
  return {
    content: [{ type: "text", text }],
    structuredContent: isRecord(value) ? value : { value },
  };
}

/**
 * 判断 unknown 是否为普通对象。
 *
 * @param value 待检查值。
 * @returns 是普通对象时返回 true。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

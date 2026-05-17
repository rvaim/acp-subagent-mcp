import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type ServerNotification, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { AppConfig } from "./config/types.js";
import { ConcurrencyManager } from "./runtime/concurrency.js";
import { TaskRegistry } from "./runtime/taskRegistry.js";
import { shutdownAllActiveTasks, type SubagentTaskRunnerDependencies } from "./runtime/taskRunner.js";
import { handleSubagentList } from "./tools/subagentList.js";
import { handleSubagentRun } from "./tools/subagentRun.js";
import { handleSubagentStart } from "./tools/subagentStart.js";
import { handleSubagentStartMany } from "./tools/subagentStartMany.js";
import { handleSubagentRunMany } from "./tools/subagentRunMany.js";
import { handleSubagentWait } from "./tools/subagentWait.js";
import { handleSubagentResult } from "./tools/subagentResult.js";
import { handleSubagentContinue } from "./tools/subagentContinue.js";
import { handleSubagentCancel } from "./tools/subagentCancel.js";
import { handleSubagentClose } from "./tools/subagentClose.js";
import { handleSubagentLogs } from "./tools/subagentLogs.js";
import { handleSubagentSkills, subagentSkillsInputJsonSchema, subagentSkillsOutputJsonSchema } from "./tools/subagentSkills.js";
import { getPackageVersion } from "./version.js";
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
  subagentRunManyInputJsonSchema,
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
  const deps: SubagentTaskRunnerDependencies = { config, concurrency, registry };
  const server = new Server(
    {
      name: "acp-subagent-mcp",
      version: getPackageVersion()
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

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;
    const requestScope = createRequestScope({ config, toolName: name, signal: extra.signal, meta: extra._meta, sendNotification: extra.sendNotification });
    const requestDeps: SubagentTaskRunnerDependencies = { ...deps, requestSignal: requestScope.signal };

    try {
      if (name === "subagent_list") return toMcpResult(handleSubagentList(config));
      if (name === "subagent_run") return toMcpResult(await handleSubagentRun(args ?? {}, requestDeps));
      if (name === "subagent_run_many") return toMcpResult(await handleSubagentRunMany(args ?? {}, requestDeps));
      if (name === "subagent_skills") return toMcpResult(await handleSubagentSkills(args ?? {}, config));
      if (name === "subagent_start") return toMcpResult(await handleSubagentStart(args ?? {}, requestDeps));
      if (name === "subagent_start_many") return toMcpResult(await handleSubagentStartMany(args ?? {}, requestDeps));
      if (name === "subagent_wait") return toMcpResult(await handleSubagentWait(args ?? {}, requestDeps));
      if (name === "subagent_result") return toMcpResult(await handleSubagentResult(args ?? {}, requestDeps));
      if (name === "subagent_continue") return toMcpResult(await handleSubagentContinue(args ?? {}, requestDeps));
      if (name === "subagent_cancel") return toMcpResult(await handleSubagentCancel(args ?? {}, requestDeps));
      if (name === "subagent_close") return toMcpResult(await handleSubagentClose(args ?? {}, requestDeps));
      if (name === "subagent_logs") return toMcpResult(await handleSubagentLogs(args ?? {}, requestDeps));

      return toMcpError(new Error(`未知工具：${name}`));
    } catch (error) {
      return toMcpError(error);
    } finally {
      requestScope.dispose();
    }
  });

  installShutdownHooks(server, deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

interface RequestScopeOptions {
  config: AppConfig;
  toolName: string;
  signal: AbortSignal;
  meta?: { progressToken?: string | number };
  sendNotification: (notification: ServerNotification) => Promise<void>;
}

interface RequestScope {
  signal: AbortSignal;
  dispose: () => void;
}

/**
 * 为单次 MCP tool call 创建本地 request scope。
 *
 * 作用：
 * 1. 转发 MCP SDK 提供的 request AbortSignal；
 * 2. 如果 Host 在 request _meta 中提供 progressToken，则周期性发送 progress
 *    heartbeat。这样一方面让 Host 知道长任务仍在运行，另一方面在 transport
 *    已断开但 SDK onclose 尚未完成时，可以通过发送失败尽快触发本地 abort。
 *
 * 注意：heartbeat 不能凭空感知“Host UI 停止但没有发送 cancellation 且 transport
 * 仍保持打开”的情况；这种 Host 行为仍由 inactivity_timeout_secs 兜底。
 */
function createRequestScope(options: RequestScopeOptions): RequestScope {
  const controller = new AbortController();
  let disposed = false;
  let heartbeat: NodeJS.Timeout | undefined;

  const abort = (reason: unknown) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const relayAbort = () => abort(options.signal.reason ?? new Error("MCP request cancelled"));

  if (options.signal.aborted) {
    relayAbort();
  } else {
    options.signal.addEventListener("abort", relayAbort, { once: true });
  }

  const heartbeatMs = options.config.defaults.mcp_request_heartbeat_ms;
  const progressToken = options.meta?.progressToken;
  if (heartbeatMs > 0 && progressToken !== undefined) {
    let progress = 0;
    heartbeat = setInterval(() => {
      if (disposed || controller.signal.aborted) return;
      progress += 1;
      void options.sendNotification({
        method: "notifications/progress",
        params: {
          progressToken,
          progress,
          message: `${options.toolName} running`
        }
      }).catch((error) => {
        abort(error instanceof Error ? error : new Error(String(error)));
      });
    }, heartbeatMs);
    heartbeat.unref?.();
  }

  return {
    signal: controller.signal,
    dispose: () => {
      disposed = true;
      if (heartbeat) clearInterval(heartbeat);
      options.signal.removeEventListener("abort", relayAbort);
    }
  };
}

/**
 * 安装 MCP transport 和 Node 进程级清理钩子。
 *
 * Host 手动停止当前请求时会通过 request signal 取消；Host 关闭 MCP
 * stdio、重启服务或 Node 收到退出信号时，这里兜底关闭所有活跃子代理，
 * 避免 detached 子进程组在后台残留。
 */
function installShutdownHooks(server: Server, deps: SubagentTaskRunnerDependencies): void {
  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await shutdownAllActiveTasks(deps, reason).catch(() => undefined);
  };

  server.onclose = () => {
    void shutdown("MCP transport 已关闭");
  };

  // 某些 Host 在停止会话或关闭 MCP Server 时会先关闭 stdio，
  // 但不一定能让 Server.onclose 及时触发。直接监听 stdin 的 EOF/close，
  // 确保 transport 断开时活跃子代理尽快进入强制清理路径。
  const shutdownOnStdinClose = () => {
    void shutdown("MCP stdin 已关闭").finally(() => {
      process.exit(0);
    });
  };
  process.stdin.once("end", shutdownOnStdinClose);
  process.stdin.once("close", shutdownOnStdinClose);

  process.once("SIGINT", () => {
    void shutdown("收到 SIGINT，关闭所有子代理").finally(() => process.exit(130));
  });
  process.once("SIGTERM", () => {
    void shutdown("收到 SIGTERM，关闭所有子代理").finally(() => process.exit(143));
  });
  process.once("beforeExit", () => {
    void shutdown("Node 进程即将退出，关闭所有子代理");
  });
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
      name: "subagent_run_many",
      description: "同步批量运行多个任务；同一 tool call 内启动并等待，停止时一起取消。",
      inputSchema: subagentRunManyInputJsonSchema,
      outputSchema: genericToolOutputJsonSchema,
      annotations: { title: "Run many subagents", readOnlyHint: false, destructiveHint: true, idempotentHint: false }
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
      description: "批量启动多个任务；启动阶段逐个建会话，运行阶段并发执行。",
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

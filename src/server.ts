import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type ServerNotification, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { AppConfig } from "./config/types.js";
import { ConcurrencyManager } from "./runtime/concurrency.js";
import { TaskRegistry } from "./runtime/taskRegistry.js";
import { shutdownAllActiveTasks, type SubagentTaskRunnerDependencies } from "./runtime/taskRunner.js";
import { handleSubagentList } from "./tools/subagentList.js";
import { handleSubagentRun } from "./tools/subagentRun.js";
import { handleSubagentRunMany } from "./tools/subagentRunMany.js";
import { handleSubagentRevise } from "./tools/subagentRevise.js";
import { handleSubagentReviseMany } from "./tools/subagentReviseMany.js";
import { handleSubagentSkills, subagentSkillsInputJsonSchema, subagentSkillsOutputJsonSchema } from "./tools/subagentSkills.js";
import { getPackageVersion } from "./version.js";
import { toMcpError, toMcpResult } from "./tools/mcpResult.js";
import {
  genericToolOutputJsonSchema,
  subagentListInputJsonSchema,
  subagentListOutputJsonSchema,
  subagentReviseInputJsonSchema,
  subagentReviseManyInputJsonSchema,
  subagentRunInputJsonSchema,
  subagentRunManyInputJsonSchema,
  subagentRunManyOutputJsonSchema,
  subagentRunOutputJsonSchema
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
      name: "@rvaim/acp-subagent-mcp",
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
      if (name === "subagent_revise") return toMcpResult(await handleSubagentRevise(args ?? {}, requestDeps));
      if (name === "subagent_revise_many") return toMcpResult(await handleSubagentReviseMany(args ?? {}, requestDeps));
      if (name === "subagent_skills") return toMcpResult(await handleSubagentSkills(args ?? {}, config));

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
 * 所有子代理操作都是同步 tool call；Host 取消当前请求时，该 signal 会级联到
 * 正在运行的子代理进程树。heartbeat 只用于长同步请求期间向 Host 报告进度。
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
 */
function buildToolDefinitions(): Tool[] {
  return [
    {
      name: "subagent_list",
      description: "列出可用 ACP 子代理、默认 agent 和 Skill 桥接状态。",
      inputSchema: subagentListInputJsonSchema as unknown as Tool["inputSchema"],
      outputSchema: subagentListOutputJsonSchema as unknown as Tool["outputSchema"],
      annotations: { title: "List ACP subagents", readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    },
    {
      name: "subagent_run",
      description: "同步运行一个 ACP 子代理；主 agent 会等待子代理完成、失败、超时或取消后才收到结果。",
      inputSchema: subagentRunInputJsonSchema as unknown as Tool["inputSchema"],
      outputSchema: subagentRunOutputJsonSchema as unknown as Tool["outputSchema"],
      annotations: { title: "Run one subagent synchronously", readOnlyHint: false, destructiveHint: false, idempotentHint: false }
    },
    {
      name: "subagent_run_many",
      description: "同步并行运行多个 ACP 子代理；内部并发，全部子代理返回后才把结果交给主 agent；不会产生 pending task。",
      inputSchema: subagentRunManyInputJsonSchema as unknown as Tool["inputSchema"],
      outputSchema: subagentRunManyOutputJsonSchema as unknown as Tool["outputSchema"],
      annotations: { title: "Run many subagents synchronously", readOnlyHint: false, destructiveHint: false, idempotentHint: false }
    },
    {
      name: "subagent_revise",
      description: "同步打回重写一个子代理结果；不复用后台进程，只把上一轮结果和审核意见作为新同步任务上下文。",
      inputSchema: subagentReviseInputJsonSchema as unknown as Tool["inputSchema"],
      outputSchema: subagentRunOutputJsonSchema as unknown as Tool["outputSchema"],
      annotations: { title: "Revise one subagent result synchronously", readOnlyHint: false, destructiveHint: false, idempotentHint: false }
    },
    {
      name: "subagent_revise_many",
      description: "同步并行打回重写多个子代理结果；全部重写任务返回后才把结果交给主 agent。",
      inputSchema: subagentReviseManyInputJsonSchema as unknown as Tool["inputSchema"],
      outputSchema: subagentRunManyOutputJsonSchema as unknown as Tool["outputSchema"],
      annotations: { title: "Revise many subagent results synchronously", readOnlyHint: false, destructiveHint: false, idempotentHint: false }
    },
    {
      name: "subagent_skills",
      description: "查询父代理环境中可桥接给子代理的 Skills。",
      inputSchema: subagentSkillsInputJsonSchema as unknown as Tool["inputSchema"],
      outputSchema: subagentSkillsOutputJsonSchema as unknown as Tool["outputSchema"],
      annotations: { title: "List bridgeable skills", readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    }
  ];
}

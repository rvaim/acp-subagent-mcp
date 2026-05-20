import fs from "node:fs/promises";
import path from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { AgentConfig, ServerConfig } from "../config/types.js";
import type { RunLogPaths } from "../runtime/logs.js";
import { spawnAcpAgent, terminateThenKill } from "../runtime/processManager.js";
import { decidePermission } from "../runtime/permissions.js";
import { normalizeMcpServersForAcp } from "../runtime/security.js";
import { JsonRpcStdioTransport } from "./JsonRpcStdioTransport.js";
import { AcpEventAggregator } from "./eventAggregator.js";
import type { AcpPromptResult, JsonRpcNotification, JsonRpcRequest } from "./types.js";

/**
 * 创建 ACP client 的输入参数。
 */
export interface GenericAcpClientInput {
  /** 子代理类型。 */
  agentType: string;

  /** 子代理配置。 */
  agentConfig: AgentConfig;

  /** 服务器配置。 */
  serverConfig: ServerConfig;

  /** 工作目录。 */
  cwd: string;

  /** 本次运行日志路径。 */
  logs: RunLogPaths;

  /** 心跳回调。 */
  onHeartbeat: () => void;

  /** 有意义进展回调。 */
  onActivity: () => void;
}

/**
 * 创建新 ACP session 的输入参数。
 */
export interface NewSessionInput {
  /** 子代理工作目录。 */
  cwd: string;

  /** 传递给子代理的 MCP servers 配置。 */
  mcpServers?: Record<string, unknown> | unknown[];
}

/**
 * 发送 ACP prompt 的输入参数。
 */
export interface PromptInput {
  /** ACP session id。 */
  sessionId: string;

  /** 渲染后的 prompt。 */
  prompt: string;

  /** 本轮事件聚合器。 */
  aggregator: AcpEventAggregator;
}

/**
 * 通用 ACP Client。
 *
 * 该类不包含任何 Codex、Claude、Gemini 的专用逻辑，只负责通过 ACP 协议与子代理进程通信。
 */
export class GenericAcpClient {
  /** 子代理进程。 */
  readonly child: ChildProcessWithoutNullStreams;

  /** JSON-RPC stdio 传输层。 */
  private readonly transport: JsonRpcStdioTransport;

  /** 最近一次用于聚合 session/update 的聚合器。 */
  private currentAggregator: AcpEventAggregator | undefined;

  /** 当前心跳回调，复用池化 session 时会切换到新任务。 */
  private onHeartbeatCallback: () => void;

  /** 当前活动回调，复用池化 session 时会切换到新任务。 */
  private onActivityCallback: () => void;

  /** initialize 返回的 agent 能力。 */
  private initializeResult: Record<string, unknown> | undefined;

  /**
   * 正在执行的关闭流程。
   *
   * shutdown 可能被取消、超时、心跳和 MCP Server 退出同时调用，
   * 使用该 Promise 保证底层进程树只执行一套终止流程。
   */
  private shutdownPromise: Promise<void> | undefined;

  /**
   * 创建通用 ACP client。
   *
   * @param input ACP client 创建参数。
   */
  constructor(private readonly input: GenericAcpClientInput) {
    this.child = spawnAcpAgent({ agent: input.agentConfig, cwd: input.cwd });
    this.onHeartbeatCallback = input.onHeartbeat;
    this.onActivityCallback = input.onActivity;
    this.transport = new JsonRpcStdioTransport(
      this.child,
      input.logs.eventsPath,
      input.logs.stderrPath,
      (notification) => this.handleNotification(notification),
      (request) => this.handleClientRequest(request),
      () => this.onHeartbeatCallback(),
    );
    this.transport.start();
  }

  /**
   * 切换生命周期回调。
   *
   * 复用池化 session 时，同一个 ACP client 会服务新的任务，
   * 因此心跳和活动事件必须切换到当前任务对象。
   *
   * @param handlers 新的生命周期回调。
   */
  setLifecycleHandlers(handlers: { onHeartbeat: () => void; onActivity: () => void }): void {
    this.onHeartbeatCallback = handlers.onHeartbeat;
    this.onActivityCallback = handlers.onActivity;
  }

  /**
   * 初始化 ACP 连接。
   */
  async initialize(): Promise<void> {
    const result = await this.transport.sendRequest("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: {
          readTextFile: true,
          writeTextFile: true,
        },
        terminal: false,
      },
      clientInfo: {
        name: "@rvaim/acp-subagent-mcp",
        title: "通用 ACP 子代理 MCP Server",
        version: "0.1.9",
      },
    });
    this.initializeResult = isRecord(result) ? result : {};
  }

  /**
   * 创建新的 ACP session。
   *
   * @param options 创建 session 参数。
   * @returns ACP session id。
   */
  async newSession(options: NewSessionInput): Promise<{ sessionId: string }> {
    const result = await this.transport.sendRequest("session/new", {
      cwd: options.cwd,
      mcpServers: normalizeMcpServersForAcp(options.mcpServers),
    });

    if (!isRecord(result) || typeof result.sessionId !== "string") {
      throw new Error("ACP session/new 未返回 sessionId");
    }

    return { sessionId: result.sessionId };
  }

  /**
   * 向指定 session 发送一轮 prompt。
   *
   * @param options prompt 参数。
   * @returns ACP prompt 结果。
   */
  async prompt(options: PromptInput): Promise<AcpPromptResult> {
    this.currentAggregator = options.aggregator;
    try {
      const result = await this.transport.sendRequest("session/prompt", {
        sessionId: options.sessionId,
        prompt: [{ type: "text", text: options.prompt }],
      });
      return isRecord(result) ? (result as AcpPromptResult) : {};
    } finally {
      // prompt 因取消或进程退出而失败时，也必须释放聚合器，避免后续池化复用串事件。
      this.currentAggregator = undefined;
    }
  }

  /**
   * 取消指定 session 当前正在运行的 prompt turn。
   *
   * @param sessionId ACP session id。
   */
  async cancel(sessionId: string): Promise<void> {
    await this.transport.sendNotification("session/cancel", { sessionId });
  }

  /**
   * 关闭指定 session。
   *
   * @param sessionId ACP session id。
   */
  async close(sessionId: string): Promise<void> {
    const capabilities = this.initializeResult?.agentCapabilities;
    const supportsClose = isRecord(capabilities) && isRecord(capabilities.sessionCapabilities) && Boolean(capabilities.sessionCapabilities.close);
    if (!supportsClose) {
      return;
    }
    await this.transport.sendRequest("session/close", { sessionId });
  }

  /**
   * 关闭 ACP client，并清理底层子进程。
   */
  async shutdown(): Promise<void> {
    if (this.shutdownPromise) {
      await this.shutdownPromise;
      return;
    }

    this.shutdownPromise = (async (): Promise<void> => {
      try {
        this.transport.close();
      } catch {
        // transport 可能已经因为子进程退出而关闭，继续执行进程树兜底终止。
      }
      await terminateThenKill(this.child);
    })();

    await this.shutdownPromise;
  }

  /**
   * 处理 ACP agent 发来的通知。
   *
   * @param notification ACP 通知。
   */
  private async handleNotification(notification: JsonRpcNotification): Promise<void> {
    if (this.currentAggregator?.handleNotification(notification)) {
      this.onActivityCallback();
    }
  }

  /**
   * 处理 ACP agent 对 client 发来的反向请求。
   *
   * @param request JSON-RPC 请求。
   * @returns JSON-RPC result。
   */
  private async handleClientRequest(request: JsonRpcRequest): Promise<unknown> {
    this.onActivityCallback();

    if (request.method === "session/request_permission") {
      return decidePermission(this.input.agentType, isRecord(request.params) ? request.params : {}, this.input.serverConfig);
    }

    if (request.method === "fs/read_text_file") {
      return await this.handleReadTextFile(request.params);
    }

    if (request.method === "fs/write_text_file") {
      return await this.handleWriteTextFile(request.params);
    }

    throw new Error(`当前 MCP Server 未实现 ACP client 方法：${request.method}`);
  }

  /**
   * 处理 ACP fs/read_text_file 请求。
   *
   * @param params 请求参数。
   * @returns 文件内容响应。
   */
  private async handleReadTextFile(params: unknown): Promise<unknown> {
    const policy = this.input.serverConfig.permissions[this.input.agentType] ?? this.input.serverConfig.permissions.default ?? { read: "deny", search: "deny", edit: "deny", execute: "deny", network: "deny" };
    if (policy.read !== "allow") {
      throw new Error("权限策略拒绝读取文件");
    }

    const request = isRecord(params) ? params : {};
    const filePath = extractRequestedPath(request);
    const safePath = this.resolveClientFilePath(filePath);
    const text = await fs.readFile(safePath, "utf8");
    return { content: text, text };
  }

  /**
   * 处理 ACP fs/write_text_file 请求。
   *
   * @param params 请求参数。
   * @returns 写入响应。
   */
  private async handleWriteTextFile(params: unknown): Promise<unknown> {
    const policy = this.input.serverConfig.permissions[this.input.agentType] ?? this.input.serverConfig.permissions.default ?? { read: "deny", search: "deny", edit: "deny", execute: "deny", network: "deny" };
    if (policy.edit !== "allow") {
      throw new Error("权限策略拒绝写入文件");
    }

    const request = isRecord(params) ? params : {};
    const filePath = extractRequestedPath(request);
    const content = typeof request.content === "string" ? request.content : typeof request.text === "string" ? request.text : undefined;
    if (content === undefined) {
      throw new Error("fs/write_text_file 缺少 content 或 text 字段");
    }

    const safePath = this.resolveClientFilePath(filePath);
    await fs.mkdir(path.dirname(safePath), { recursive: true });
    await fs.writeFile(safePath, content, "utf8");
    return {};
  }

  /**
   * 解析并校验 ACP client 文件路径。
   *
   * @param requestedPath agent 请求的路径。
   * @returns 安全的绝对路径。
   */
  private resolveClientFilePath(requestedPath: string): string {
    const withoutFileScheme = requestedPath.startsWith("file://") ? requestedPath.slice("file://".length) : requestedPath;
    const absolutePath = path.isAbsolute(withoutFileScheme) ? path.resolve(withoutFileScheme) : path.resolve(this.input.cwd, withoutFileScheme);
    const cwd = path.resolve(this.input.cwd);
    if (absolutePath !== cwd && !absolutePath.startsWith(cwd + path.sep)) {
      throw new Error(`ACP client 文件请求逃逸 cwd：${requestedPath}`);
    }
    return absolutePath;
  }
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

/**
 * 从 ACP 文件系统请求中提取路径。
 *
 * @param request 请求对象。
 * @returns 文件路径。
 */
function extractRequestedPath(request: Record<string, unknown>): string {
  const candidates = [request.path, request.uri, request.filePath];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }
  throw new Error("ACP 文件系统请求缺少 path / uri / filePath 字段");
}

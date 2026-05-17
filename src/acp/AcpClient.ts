import { readFile, writeFile } from "node:fs/promises";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { EffectivePermissions } from "../runtime/permissions.js";
import type { ToolCallSummary } from "../task/types.js";
import { selectPermissionOption } from "../runtime/permissions.js";
import { resolveAcpAbsolutePathInsideCwd, toDisplayRelativePath } from "../runtime/security.js";
import { SubagentRuntimeError } from "../runtime/errors.js";
import type { RunLogger } from "../runtime/logs.js";
import { terminateProcessTree } from "../runtime/processManager.js";
import type { AcpContentBlock, AcpInitializeResult, AcpNewSessionResult, AcpPromptResult } from "./types.js";
import { AcpEventAggregator } from "./eventAggregator.js";
import { getPackageVersion } from "../version.js";

/**
 * ACP Client 配置。
 */
export interface GenericAcpClientOptions {
  /** ACP agent 子进程。 */
  child: ChildProcessWithoutNullStreams;
  /** 本次 session 的安全工作目录。 */
  cwd: string;
  /** 有效权限。 */
  permissions: EffectivePermissions;
  /** 日志写入器。 */
  logger: RunLogger;
  /** 有效活动回调，用于重置 inactivity timeout。 */
  onActivity: () => void;
  /** 单次 fs/read_text_file 最大读取字节数。 */
  maxReadFileBytes: number;
  /** ACP cancel grace period。 */
  acpCancelGraceMs: number;
  /** SIGKILL grace period。 */
  processKillGraceMs: number;
}

/**
 * ACP 客户端侧处理器。
 *
 * 该类实现官方 `@agentclientprotocol/sdk` 的 `Client` 接口，用于处理 ACP Agent
 * 反向请求给客户端的能力，例如 session/update、权限请求、文件读写请求。
 */
class SubagentAcpClientHandler implements acp.Client {
  /** 当前是否已经进入取消流程。 */
  private cancelled = false;

  /**
   * 创建 ACP 客户端侧处理器。
   */
  constructor(
    private readonly options: {
      /** 安全工作目录。 */
      cwd: string;
      /** 有效权限。 */
      permissions: EffectivePermissions;
      /** 日志写入器。 */
      logger: RunLogger;
      /** 有效活动回调。 */
      onActivity: () => void;
      /** 文件读取字节上限。 */
      maxReadFileBytes: number;
      /** 事件聚合器。 */
      aggregator: AcpEventAggregator;
    }
  ) {}

  /**
   * 标记当前 prompt turn 已经取消。
   */
  markCancelled(): void {
    this.cancelled = true;
  }

  /**
   * 重置当前 prompt turn 的取消状态。
   */
  resetCancelled(): void {
    this.cancelled = false;
  }

  /**
   * 处理 ACP Agent 推送的 session/update 通知。
   */
  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    this.options.onActivity();
    this.options.aggregator.handleSessionUpdate(params);
    await this.options.logger.appendEvent({ direction: "agent_to_client", kind: "notification", method: "session/update", params });
  }

  /**
   * 处理 ACP Agent 发起的权限请求。
   */
  async requestPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    this.options.onActivity();
    await this.options.logger.appendEvent({ direction: "agent_to_client", kind: "request", method: "session/request_permission", params });

    if (this.cancelled) {
      return { outcome: { outcome: "cancelled" } };
    }

    return selectPermissionOption(params, this.options.permissions) as acp.RequestPermissionResponse;
  }

  /**
   * 处理 ACP Agent 发起的文件读取请求。
   */
  async readTextFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
    this.options.onActivity();
    await this.options.logger.appendEvent({ direction: "agent_to_client", kind: "request", method: "fs/read_text_file", params });

    if (!this.options.permissions.canReadFiles) {
      throw new SubagentRuntimeError("permission_denied", "文件读取权限已禁用");
    }

    const safePath = await resolveAcpAbsolutePathInsideCwd(this.options.cwd, params.path);
    const contentBuffer = await readFile(safePath);
    if (contentBuffer.byteLength > this.options.maxReadFileBytes) {
      throw new SubagentRuntimeError("permission_denied", `文件过大，拒绝通过 ACP 读取：${toDisplayRelativePath(this.options.cwd, safePath)}`);
    }

    const rawContent = contentBuffer.toString("utf8");
    const line = typeof params.line === "number" ? Math.max(1, params.line) : undefined;
    const limit = typeof params.limit === "number" ? Math.max(1, params.limit) : undefined;
    const content = sliceLines(rawContent, line, limit);
    this.options.aggregator.recordFileTouched(toDisplayRelativePath(this.options.cwd, safePath));
    return { content };
  }

  /**
   * 处理 ACP Agent 发起的文件写入请求。
   */
  async writeTextFile(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
    this.options.onActivity();
    await this.options.logger.appendEvent({ direction: "agent_to_client", kind: "request", method: "fs/write_text_file", params });

    if (!this.options.permissions.canWriteFiles) {
      throw new SubagentRuntimeError("permission_denied", "文件写入权限已禁用");
    }

    const safePath = await resolveAcpAbsolutePathInsideCwd(this.options.cwd, params.path);
    await writeFile(safePath, params.content, "utf8");
    this.options.aggregator.recordFileTouched(toDisplayRelativePath(this.options.cwd, safePath));
    return {};
  }
}

/**
 * 通用 ACP Client。
 *
 * 该实现直接使用官方 `@agentclientprotocol/sdk`：
 * - `ndJsonStream` 负责 newline-delimited JSON stream 编解码。
 * - `ClientSideConnection` 负责 JSON-RPC 分发、请求关联和协议 schema 校验。
 *
 * 本类只保留本项目自己的运行时职责：权限策略、文件边界校验、日志聚合、
 * 子进程生命周期和面向 MCP tools 的结果聚合。
 */
export class GenericAcpClient {
  /** 子进程。 */
  private readonly child: ChildProcessWithoutNullStreams;
  /** 安全工作目录。 */
  private readonly cwd: string;
  /** 有效权限。 */
  private readonly permissions: EffectivePermissions;
  /** 日志写入器。 */
  private readonly logger: RunLogger;
  /** ACP cancel grace period。 */
  private readonly acpCancelGraceMs: number;
  /** SIGKILL grace period。 */
  private readonly processKillGraceMs: number;
  /** 事件聚合器。 */
  private readonly aggregator = new AcpEventAggregator();
  /** 官方 ACP SDK 连接对象。 */
  private readonly connection: acp.ClientSideConnection;
  /** ACP 客户端侧能力处理器。 */
  private readonly clientHandler: SubagentAcpClientHandler;
  /** initialize 返回结果。 */
  private initializeResult?: AcpInitializeResult;

  /**
   * 创建通用 ACP client。
   */
  constructor(options: GenericAcpClientOptions) {
    this.child = options.child;
    this.cwd = options.cwd;
    this.permissions = options.permissions;
    this.logger = options.logger;
    this.acpCancelGraceMs = options.acpCancelGraceMs;
    this.processKillGraceMs = options.processKillGraceMs;

    this.clientHandler = new SubagentAcpClientHandler({
      cwd: options.cwd,
      permissions: options.permissions,
      logger: options.logger,
      onActivity: options.onActivity,
      maxReadFileBytes: options.maxReadFileBytes,
      aggregator: this.aggregator
    });

    // ACP stdio 方向：写入子进程 stdin，读取子进程 stdout。
    const outputToAgent = Writable.toWeb(options.child.stdin) as WritableStream<Uint8Array>;
    const inputFromAgent = Readable.toWeb(options.child.stdout) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(outputToAgent, inputFromAgent);
    this.connection = new acp.ClientSideConnection(() => this.clientHandler, stream);

    this.attachProcessListeners();
  }

  /**
   * 初始化 ACP 连接。
   */
  async initialize(): Promise<AcpInitializeResult> {
    const result = await this.connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: {
          readTextFile: this.permissions.canReadFiles,
          writeTextFile: this.permissions.canWriteFiles
        },
        // 当前项目还没有实现 ACP terminal handler，因此即使配置里 execute=allow，也不对 Agent 声明 terminal 能力。
        terminal: false
      },
      clientInfo: {
        name: "@rvaim/acp-subagent-mcp",
        title: "ACP Subagent MCP Server",
        version: getPackageVersion()
      }
    }).catch((error) => {
      throw new SubagentRuntimeError("acp_initialize_failed", `ACP initialize 失败：${(error as Error).message}`, { cause: error });
    });

    if (result.protocolVersion !== acp.PROTOCOL_VERSION) {
      throw new SubagentRuntimeError("acp_initialize_failed", `不支持的 ACP protocolVersion：${result.protocolVersion}`);
    }

    if (Array.isArray(result.authMethods) && result.authMethods.length > 0) {
      throw new SubagentRuntimeError("acp_auth_required", "ACP agent 要求认证，但当前版本尚未配置认证流程");
    }

    this.initializeResult = result;
    return result;
  }

  /**
   * 创建新的 ACP session。
   */
  async newSession(options: { cwd: string; mcpServers: Array<Record<string, unknown>> }): Promise<AcpNewSessionResult> {
    const result = await this.connection.newSession({
      cwd: options.cwd,
      mcpServers: options.mcpServers as acp.McpServer[]
    }).catch((error) => {
      throw new SubagentRuntimeError("acp_session_new_failed", `ACP session/new 失败：${(error as Error).message}`, { cause: error });
    });

    if (!result.sessionId) {
      throw new SubagentRuntimeError("acp_session_new_failed", "ACP session/new 未返回 sessionId");
    }

    return result;
  }

  /**
   * 向指定 session 发送一轮 prompt。
   */
  async prompt(options: { sessionId: string; content: AcpContentBlock[]; signal?: AbortSignal }): Promise<AcpPromptResult> {
    this.clientHandler.resetCancelled();
    this.aggregator.reset();

    const promptPromise = this.connection.prompt({
      sessionId: options.sessionId,
      prompt: options.content as acp.ContentBlock[]
    });

    try {
      const result = await racePromptWithAbort(promptPromise, options.signal, async () => {
        await this.cancel(options.sessionId).catch(() => undefined);
      });

      return {
        stopReason: result.stopReason,
        text: this.aggregator.getText(),
        toolCalls: this.aggregator.getToolCalls(),
        filesTouched: this.aggregator.getFilesTouched()
      };
    } catch (error) {
      if (options.signal?.aborted) {
        throw error;
      }
      throw new SubagentRuntimeError("acp_prompt_failed", `ACP session/prompt 失败：${(error as Error).message}`, { cause: error });
    } finally {
      // 如果调用方因为超时提前返回，底层 prompt 仍可能稍后收到 cancelled 响应；这里吞掉迟到错误，避免 unhandled rejection。
      promptPromise.catch(() => undefined);
    }
  }

  /**
   * 获取当前 prompt turn 已聚合的部分文本。
   */
  getPartialText(): string {
    return this.aggregator.getText();
  }

  /**
   * 获取当前 prompt turn 的工具调用摘要。
   */
  getToolCalls(): ToolCallSummary[] {
    return this.aggregator.getToolCalls();
  }

  /**
   * 获取当前 prompt turn 触碰过的文件。
   */
  getFilesTouched(): string[] {
    return this.aggregator.getFilesTouched();
  }

  /**
   * 取消指定 session 当前正在运行的 prompt turn。
   */
  async cancel(sessionId: string): Promise<void> {
    this.clientHandler.markCancelled();
    await withTimeout(
      this.connection.cancel({ sessionId }),
      this.acpCancelGraceMs,
      `ACP session/cancel 超过 ${this.acpCancelGraceMs}ms，继续执行强制清理`
    ).catch((error) => {
      void this.logger.appendEvent({ type: "cancel_failed_or_timed_out", error: error instanceof Error ? error.message : String(error) });
    });
  }

  /**
   * 关闭指定 session。仅在 agent 声明 sessionCapabilities.close 时调用。
   */
  async close(sessionId: string): Promise<void> {
    if (this.initializeResult?.agentCapabilities?.sessionCapabilities?.close) {
      await this.connection.closeSession({ sessionId }).catch(() => undefined);
    } else {
      await this.cancel(sessionId);
    }
  }

  /**
   * 关闭 ACP client，并清理底层子进程。
   */
  async shutdown(): Promise<void> {
    await terminateProcessTree(this.child, {
      sigtermGraceMs: this.acpCancelGraceMs,
      sigkillGraceMs: this.processKillGraceMs
    });
  }

  /**
   * 绑定子进程和 SDK 连接监听。
   */
  private attachProcessListeners(): void {
    this.child.on("exit", (code, signal) => {
      void this.logger.appendEvent({ type: "process_exit", code, signal });
    });

    void this.connection.closed.catch((error) => {
      void this.logger.appendEvent({ type: "connection_closed", error: error instanceof Error ? error.message : String(error) });
    });
  }
}

/**
 * 将 prompt Promise 与 AbortSignal 竞争。
 *
 * 官方 ACP SDK 的 `prompt()` 本身负责协议请求/响应生命周期；本项目额外需要把
 * MCP 侧 timeout/cancel 转换成 ACP `session/cancel`，因此在这里包一层竞态处理。
 */
async function racePromptWithAbort(
  promptPromise: Promise<acp.PromptResponse>,
  signal: AbortSignal | undefined,
  onAbort: () => Promise<void>
): Promise<acp.PromptResponse> {
  if (!signal) return promptPromise;
  if (signal.aborted) {
    void onAbort().catch(() => undefined);
    throw signal.reason ?? new Error("request aborted");
  }

  return await new Promise<acp.PromptResponse>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", abort);
    const abort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      // ACP cancel 是 best-effort：不能为了等待 agent 响应 cancel 而阻塞本地清理。
      void onAbort().catch(() => undefined);
      reject(signal.reason ?? new Error("request aborted"));
    };

    signal.addEventListener("abort", abort, { once: true });
    promptPromise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      }
    );
  });
}

/**
 * 为 best-effort ACP 请求加上本地超时，避免取消流程被 agent 卡住。
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 截取指定行范围。
 */
function sliceLines(content: string, line?: number, limit?: number): string {
  if (!line && !limit) return content;
  const lines = content.split(/\r?\n/);
  const start = line ? Math.max(0, line - 1) : 0;
  const end = limit ? start + limit : lines.length;
  return lines.slice(start, end).join("\n");
}

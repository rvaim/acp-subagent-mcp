import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  AcpClientRequestHandler,
  AcpNotificationHandler,
  HeartbeatHandler,
  JsonRpcErrorResponse,
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcSuccessResponse,
} from "./types.js";
import { appendEventLog, appendStderrLog } from "../runtime/logs.js";

/**
 * 待完成 JSON-RPC 请求记录。
 */
interface PendingRequest {
  /** 请求成功回调。 */
  resolve: (value: unknown) => void;

  /** 请求失败回调。 */
  reject: (reason: Error) => void;

  /** 可选超时定时器。 */
  timer?: NodeJS.Timeout;
}

/**
 * JSON-RPC over stdio 传输层。
 *
 * 该类只负责 NDJSON 消息帧、请求响应关联、通知分发、stderr 采集和基础错误处理，
 * 不包含任何具体模型、Codex、Claude 或 Gemini 的专用逻辑。
 */
export class JsonRpcStdioTransport extends EventEmitter {
  /** 下一个 JSON-RPC 请求 ID。 */
  private nextRequestId = 1;

  /** 等待响应的请求表。 */
  private readonly pendingRequests = new Map<JsonRpcId, PendingRequest>();

  /** stdout 行读取器是否已经启动。 */
  private started = false;

  /** 传输层是否已经关闭。 */
  private closed = false;

  /**
   * 创建 stdio 传输层。
   *
   * @param child ACP agent 子进程。
   * @param eventsLogPath 原始事件日志路径。
   * @param stderrLogPath stderr 日志路径。
   * @param onNotification ACP 通知处理器。
   * @param onClientRequest ACP agent 反向请求处理器。
   * @param onHeartbeat 任意可证明子代理存活的消息回调。
   */
  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private eventsLogPath: string,
    private stderrLogPath: string,
    private readonly onNotification: AcpNotificationHandler,
    private readonly onClientRequest: AcpClientRequestHandler,
    private readonly onHeartbeat: HeartbeatHandler,
  ) {
    super();
  }

  /**
   * 启动 stdout/stderr 读取循环。
   */
  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;

    const lineReader = createInterface({ input: this.child.stdout });
    lineReader.on("line", (line) => {
      void this.handleStdoutLine(line);
    });

    this.child.stderr.on("data", (chunk: Buffer) => {
      this.onHeartbeat();
      void appendStderrLog(this.stderrLogPath, chunk.toString("utf8"));
    });

    this.child.once("exit", (code, signal) => {
      this.closed = true;
      const error = new Error(`ACP 子进程已退出，code=${code ?? "null"}, signal=${signal ?? "null"}`);
      for (const pending of this.pendingRequests.values()) {
        if (pending.timer) {
          clearTimeout(pending.timer);
        }
        pending.reject(error);
      }
      this.pendingRequests.clear();
      this.emit("close");
    });

    this.child.once("error", (error) => {
      this.closed = true;
      for (const pending of this.pendingRequests.values()) {
        if (pending.timer) {
          clearTimeout(pending.timer);
        }
        pending.reject(error);
      }
      this.pendingRequests.clear();
      this.emit("error", error);
    });
  }


  /**
   * 切换当前写入的日志路径。
   *
   * 池化复用同一个 ACP client 时，每个新任务仍应写入自己的 events/stderr 日志。
   *
   * @param eventsLogPath 新的 events 日志路径。
   * @param stderrLogPath 新的 stderr 日志路径。
   */
  setLogPaths(eventsLogPath: string, stderrLogPath: string): void {
    this.eventsLogPath = eventsLogPath;
    this.stderrLogPath = stderrLogPath;
  }

  /**
   * 发送 JSON-RPC 请求，并等待响应。
   *
   * @param method 方法名。
   * @param params 请求参数。
   * @param timeoutMs 可选请求超时时间。
   * @returns 响应 result。
   */
  async sendRequest(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.closed) {
      throw new Error("ACP transport 已关闭，无法发送请求");
    }

    const id = this.nextRequestId++;
    const request: JsonRpcRequest = params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params };

    const promise = new Promise<unknown>((resolve, reject) => {
      const pending: PendingRequest = { resolve, reject };
      if (timeoutMs && timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.pendingRequests.delete(id);
          reject(new Error(`ACP 请求超时：${method}`));
        }, timeoutMs);
      }
      this.pendingRequests.set(id, pending);
    });

    await this.writeMessage(request);
    return await promise;
  }

  /**
   * 发送 JSON-RPC 通知。
   *
   * @param method 方法名。
   * @param params 通知参数。
   */
  async sendNotification(method: string, params?: unknown): Promise<void> {
    const notification: JsonRpcNotification =
      params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params };
    await this.writeMessage(notification);
  }

  /**
   * 关闭传输层。
   */
  close(): void {
    this.closed = true;
    this.child.stdin.end();
  }

  /**
   * 处理 stdout 中的一行 JSON-RPC 消息。
   *
   * @param line stdout 行文本。
   */
  private async handleStdoutLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    this.onHeartbeat();

    let message: JsonRpcMessage;
    try {
      message = JSON.parse(trimmed) as JsonRpcMessage;
    } catch (error) {
      await appendEventLog(this.eventsLogPath, { direction: "in", invalidJson: trimmed, error: String(error) });
      return;
    }

    await appendEventLog(this.eventsLogPath, { direction: "in", message });

    if (isResponse(message)) {
      this.handleResponse(message);
      return;
    }

    if (isRequest(message)) {
      await this.handleClientRequest(message);
      return;
    }

    if (isNotification(message)) {
      await this.onNotification(message);
    }
  }

  /**
   * 处理 JSON-RPC response。
   *
   * @param response 响应消息。
   */
  private handleResponse(response: JsonRpcSuccessResponse | JsonRpcErrorResponse): void {
    const pending = this.pendingRequests.get(response.id);
    if (!pending) {
      return;
    }

    this.pendingRequests.delete(response.id);
    if (pending.timer) {
      clearTimeout(pending.timer);
    }

    if ("error" in response) {
      pending.reject(new Error(`${response.error.message} (${response.error.code})`));
    } else {
      pending.resolve(response.result);
    }
  }

  /**
   * 处理 ACP agent 反向请求。
   *
   * @param request 请求消息。
   */
  private async handleClientRequest(request: JsonRpcRequest): Promise<void> {
    try {
      const result = await this.onClientRequest(request);
      await this.writeMessage({ jsonrpc: "2.0", id: request.id, result });
    } catch (error) {
      await this.writeMessage({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  /**
   * 写出一条 JSON-RPC 消息。
   *
   * @param message 消息对象。
   */
  private async writeMessage(message: JsonRpcMessage): Promise<void> {
    await appendEventLog(this.eventsLogPath, { direction: "out", message });

    const line = `${JSON.stringify(message)}\n`;
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(line, "utf8", (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }
}

/**
 * 判断消息是否为 response。
 *
 * @param message JSON-RPC 消息。
 * @returns 是 response 时返回 true。
 */
function isResponse(message: JsonRpcMessage): message is JsonRpcSuccessResponse | JsonRpcErrorResponse {
  return "id" in message && ("result" in message || "error" in message) && !("method" in message);
}

/**
 * 判断消息是否为 request。
 *
 * @param message JSON-RPC 消息。
 * @returns 是 request 时返回 true。
 */
function isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return "id" in message && "method" in message;
}

/**
 * 判断消息是否为 notification。
 *
 * @param message JSON-RPC 消息。
 * @returns 是 notification 时返回 true。
 */
function isNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  return !("id" in message) && "method" in message;
}

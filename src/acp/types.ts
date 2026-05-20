/**
 * JSON-RPC 请求 ID。
 */
export type JsonRpcId = string | number;

/**
 * JSON-RPC 请求消息。
 */
export interface JsonRpcRequest {
  /** JSON-RPC 版本，固定为 2.0。 */
  jsonrpc: "2.0";

  /** 请求 ID，用于关联响应。 */
  id: JsonRpcId;

  /** 方法名。 */
  method: string;

  /** 请求参数。 */
  params?: unknown;
}

/**
 * JSON-RPC 通知消息。
 */
export interface JsonRpcNotification {
  /** JSON-RPC 版本，固定为 2.0。 */
  jsonrpc: "2.0";

  /** 方法名。 */
  method: string;

  /** 通知参数。 */
  params?: unknown;
}

/**
 * JSON-RPC 成功响应消息。
 */
export interface JsonRpcSuccessResponse {
  /** JSON-RPC 版本，固定为 2.0。 */
  jsonrpc: "2.0";

  /** 请求 ID。 */
  id: JsonRpcId;

  /** 响应结果。 */
  result: unknown;
}

/**
 * JSON-RPC 错误对象。
 */
export interface JsonRpcErrorObject {
  /** 标准或自定义错误码。 */
  code: number;

  /** 错误说明。 */
  message: string;

  /** 可选错误详情。 */
  data?: unknown;
}

/**
 * JSON-RPC 错误响应消息。
 */
export interface JsonRpcErrorResponse {
  /** JSON-RPC 版本，固定为 2.0。 */
  jsonrpc: "2.0";

  /** 请求 ID。 */
  id: JsonRpcId;

  /** 错误对象。 */
  error: JsonRpcErrorObject;
}

/**
 * 任意 JSON-RPC 消息。
 */
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcSuccessResponse | JsonRpcErrorResponse;

/**
 * ACP prompt 返回结果。
 */
export interface AcpPromptResult {
  /** 停止原因，例如 end_turn、cancelled、max_tokens。 */
  stopReason?: string;

  /** ACP agent 返回的其他字段。 */
  [key: string]: unknown;
}

/**
 * ACP session/update 通知参数。
 */
export interface AcpSessionUpdateParams {
  /** ACP session id。 */
  sessionId?: string;

  /** 更新体。 */
  update?: Record<string, unknown>;

  /** 其他协议字段。 */
  [key: string]: unknown;
}

/**
 * ACP client 请求处理器。
 */
export type AcpClientRequestHandler = (request: JsonRpcRequest) => Promise<unknown>;

/**
 * ACP 通知处理器。
 */
export type AcpNotificationHandler = (notification: JsonRpcNotification) => void | Promise<void>;

/**
 * 心跳更新回调。
 */
export type HeartbeatHandler = () => void;

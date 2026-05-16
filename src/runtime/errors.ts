import type { SubagentError, SubagentErrorCode } from "../task/types.js";

/**
 * 带错误码的运行时异常。
 */
export class SubagentRuntimeError extends Error {
  /** 机器可读错误码。 */
  readonly code: SubagentErrorCode;
  /** 是否建议重试。 */
  readonly recoverable: boolean;
  /** 给主 agent 和用户看的简短错误。 */
  readonly userMessage: string;

  /**
   * 创建子代理运行时异常。
   */
  constructor(code: SubagentErrorCode, userMessage: string, options?: { recoverable?: boolean; cause?: unknown }) {
    super(userMessage, { cause: options?.cause });
    this.name = "SubagentRuntimeError";
    this.code = code;
    this.recoverable = options?.recoverable ?? false;
    this.userMessage = userMessage;
  }
}

/**
 * 把未知异常转换为结构化错误。
 */
export function toSubagentError(error: unknown, fallbackCode: SubagentErrorCode = "internal_error"): SubagentError {
  if (error instanceof SubagentRuntimeError) {
    return {
      code: error.code,
      recoverable: error.recoverable,
      user_message: error.userMessage,
      debug_message: error.message
    };
  }

  if (error instanceof Error) {
    return {
      code: fallbackCode,
      recoverable: false,
      user_message: error.message || "子代理运行失败",
      debug_message: error.stack ?? error.message
    };
  }

  return {
    code: fallbackCode,
    recoverable: false,
    user_message: "子代理运行失败",
    debug_message: String(error)
  };
}

/**
 * 创建结构化错误对象。
 */
export function makeSubagentError(
  code: SubagentErrorCode,
  userMessage: string,
  options?: { recoverable?: boolean; debugMessage?: string }
): SubagentError {
  return {
    code,
    recoverable: options?.recoverable ?? false,
    user_message: userMessage,
    debug_message: options?.debugMessage
  };
}

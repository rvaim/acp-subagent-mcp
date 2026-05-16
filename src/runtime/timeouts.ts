/****
 * 子代理运行超时原因。
 */
export type TimeoutReason = "timeout" | "inactivity_timeout" | "cancelled";

/**
 * 同时管理 wall-clock timeout 和 inactivity timeout。
 */
export class RunTimeoutController {
  /** AbortController 暴露给 ACP prompt 请求。 */
  readonly controller = new AbortController();
  /** 触发取消的原因。 */
  reason?: TimeoutReason;
  /** wall-clock timer。 */
  private wallTimer?: NodeJS.Timeout;
  /** inactivity timer。 */
  private inactivityTimer?: NodeJS.Timeout;

  /**
   * 创建超时控制器。
   */
  constructor(options: { timeoutMs: number; inactivityTimeoutMs: number }) {
    this.wallTimer = setTimeout(() => this.abort("timeout"), options.timeoutMs);
    this.resetInactivity(options.inactivityTimeoutMs);
  }

  /**
   * 标记任务有有效活动，并重置 inactivity timeout。
   */
  markActivity(inactivityTimeoutMs: number): void {
    this.resetInactivity(inactivityTimeoutMs);
  }

  /**
   * 主动取消。
   */
  abort(reason: TimeoutReason): void {
    if (!this.reason) {
      this.reason = reason;
      this.controller.abort(new Error(reason));
    }
  }

  /**
   * 清理 timer。
   */
  dispose(): void {
    if (this.wallTimer) clearTimeout(this.wallTimer);
    if (this.inactivityTimer) clearTimeout(this.inactivityTimer);
  }

  /**
   * 重置 inactivity timer。
   */
  private resetInactivity(inactivityTimeoutMs: number): void {
    if (this.inactivityTimer) clearTimeout(this.inactivityTimer);
    this.inactivityTimer = setTimeout(() => this.abort("inactivity_timeout"), inactivityTimeoutMs);
  }
}

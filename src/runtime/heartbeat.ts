/**
 * 心跳监控输入参数。
 */
export interface HeartbeatWatchdogInput {
  /** 返回最近一次心跳时间戳，单位毫秒。 */
  getLastHeartbeatMs: () => number;

  /** 心跳超时时间，单位毫秒。 */
  heartbeatTimeoutMs: number;

  /** 触发心跳超时后的回调。 */
  onTimeout: () => void;
}

/**
 * 启动子代理心跳监控。
 *
 * 如果超过 heartbeatTimeoutMs 没有收到任何可证明子代理存活的信号，
 * 则触发 onTimeout。调用者负责取消 ACP turn 和终止进程。
 *
 * @param input 心跳监控参数。
 * @returns Node 定时器对象。
 */
export function startHeartbeatWatchdog(input: HeartbeatWatchdogInput): NodeJS.Timeout {
  const intervalMs = Math.max(250, Math.min(1000, input.heartbeatTimeoutMs));
  return setInterval(() => {
    const now = Date.now();
    const elapsed = now - input.getLastHeartbeatMs();
    if (elapsed > input.heartbeatTimeoutMs) {
      input.onTimeout();
    }
  }, intervalMs);
}

/**
 * 启动无有效进展监控。
 *
 * @param getLastActivityMs 返回最近一次有效进展时间戳。
 * @param inactivityTimeoutMs 无进展超时时间，单位毫秒。
 * @param onTimeout 超时回调。
 * @returns Node 定时器对象。
 */
export function startInactivityWatchdog(
  getLastActivityMs: () => number,
  inactivityTimeoutMs: number,
  onTimeout: () => void,
): NodeJS.Timeout {
  const intervalMs = Math.max(1000, Math.min(5000, inactivityTimeoutMs));
  return setInterval(() => {
    const now = Date.now();
    if (now - getLastActivityMs() > inactivityTimeoutMs) {
      onTimeout();
    }
  }, intervalMs);
}

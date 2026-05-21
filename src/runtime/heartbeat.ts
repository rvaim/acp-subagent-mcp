/**
 * 主代理发送给子代理包装器的 JSON-RPC 心跳方法名。
 *
 * 真实 ACP agent 不需要实现这个方法；由本项目启动的监督包装器会拦截该方法并立即响应。
 */
export const SUBAGENT_HEARTBEAT_METHOD = "$/subagent_mcp/heartbeat";

/**
 * 主代理心跳发送器输入参数。
 */
export interface ParentHeartbeatPingerInput {
  /** 子代理判定主代理失联的超时时间，单位毫秒。 */
  heartbeatTimeoutMs: number;

  /** 实际发送一次心跳并等待子代理回复。 */
  sendHeartbeat: () => Promise<void>;
}

/**
 * 启动主代理到子代理的主动心跳。
 *
 * MCP Server 会定期向子代理监督包装器发送 JSON-RPC 心跳请求；包装器收到后立即响应。
 * 成功收到响应表示子代理进程仍可通过 stdio 通信。若主代理停止发送心跳，包装器会在
 * heartbeatTimeoutMs 内主动关闭自身和真实 ACP agent。
 *
 * @param input 心跳发送参数。
 * @returns Node 定时器对象。
 */
export function startParentHeartbeatPinger(input: ParentHeartbeatPingerInput): NodeJS.Timeout {
  const intervalMs = heartbeatIntervalMs(input.heartbeatTimeoutMs);
  let inFlight = false;

  const ping = (): void => {
    if (inFlight) {
      return;
    }
    inFlight = true;
    void input
      .sendHeartbeat()
      .catch(() => undefined)
      .finally(() => {
        inFlight = false;
      });
  };

  ping();
  return setInterval(ping, intervalMs);
}

/**
 * 启动心跳回复监控。
 *
 * @param getLastHeartbeatMs 返回最近一次收到子代理心跳回复或协议消息的时间戳。
 * @param heartbeatTimeoutMs 心跳失联超时时间，单位毫秒。
 * @param onTimeout 超时回调。
 * @returns Node 定时器对象。
 */
export function startHeartbeatWatchdog(
  getLastHeartbeatMs: () => number,
  heartbeatTimeoutMs: number,
  onTimeout: () => void,
): NodeJS.Timeout {
  return setInterval(() => {
    const now = Date.now();
    if (now - getLastHeartbeatMs() > heartbeatTimeoutMs) {
      onTimeout();
    }
  }, heartbeatIntervalMs(heartbeatTimeoutMs));
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

/**
 * 根据心跳超时计算发送和检测间隔。
 *
 * @param heartbeatTimeoutMs 心跳超时时间。
 * @returns 定时器间隔。
 */
function heartbeatIntervalMs(heartbeatTimeoutMs: number): number {
  return Math.max(250, Math.min(1000, Math.floor(heartbeatTimeoutMs / 3)));
}

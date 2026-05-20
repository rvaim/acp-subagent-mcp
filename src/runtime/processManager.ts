import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { AgentConfig } from "../config/types.js";

/**
 * 子代理进程启动参数。
 */
export interface SpawnAgentInput {
  /** 子代理配置。 */
  agent: AgentConfig;

  /** 子代理运行工作目录。 */
  cwd: string;

  /** 追加环境变量。 */
  env?: Record<string, string>;
}

/**
 * 启动 ACP 子代理进程。
 *
 * @param input 子代理进程启动参数。
 * @returns 子进程对象。
 */
export function spawnAcpAgent(input: SpawnAgentInput): ChildProcessWithoutNullStreams {
  const mergedEnv = {
    ...process.env,
    ...input.agent.env,
    ...input.env,
    AGENT_DEPTH: String(Number.parseInt(process.env.AGENT_DEPTH ?? "0", 10) + 1),
  };

  return spawn(input.agent.command, input.agent.args, {
    cwd: input.cwd,
    env: mergedEnv,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
}

/**
 * 尝试温和终止子代理进程树。
 *
 * 在类 Unix 系统上，如果 child 是 detached 模式启动的，可以通过负 pid 杀掉整个进程组。
 * Windows 先使用 child.kill，后续可替换为 tree-kill 一类实现。
 *
 * @param child 子进程对象。
 */
export function terminateChildProcess(child: ChildProcessWithoutNullStreams): void {
  if (child.killed) {
    return;
  }

  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGTERM");
      return;
    } catch {
      // 进程组终止失败时降级为终止单个子进程。
    }
  }

  child.kill("SIGTERM");
}

/**
 * 强制终止子代理进程树。
 *
 * @param child 子进程对象。
 */
export function killChildProcess(child: ChildProcessWithoutNullStreams): void {
  if (child.killed) {
    return;
  }

  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // 进程组强杀失败时降级为强杀单个子进程。
    }
  }

  child.kill("SIGKILL");
}

/**
 * 等待子进程退出。
 *
 * @param child 子进程对象。
 * @param timeoutMs 最大等待时间，单位毫秒。
 * @returns true 表示进程已退出，false 表示等待超时。
 */
export async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true;
  }

  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);

    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };

    child.once("exit", onExit);
  });
}

/**
 * 先 SIGTERM 再 SIGKILL，确保子代理进程最终被清理。
 *
 * @param child 子进程对象。
 * @param graceMs SIGTERM 后的宽限时间，单位毫秒。
 */
export async function terminateThenKill(child: ChildProcessWithoutNullStreams, graceMs = 1500): Promise<void> {
  terminateChildProcess(child);
  const exited = await waitForExit(child, graceMs);
  if (!exited) {
    killChildProcess(child);
  }
}

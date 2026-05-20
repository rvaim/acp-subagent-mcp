import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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
 * detached=true 会在类 Unix 系统上创建新的进程组。这样取消任务时可以通过负 pid
 * 给整组进程发送信号，避免只杀掉 shell / npx 包装进程却留下真正的 agent 进程。
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
 * @param child 子进程对象。
 */
export async function terminateChildProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  await signalChildProcessTree(child, "SIGTERM", false);
}

/**
 * 强制终止子代理进程树。
 *
 * @param child 子进程对象。
 */
export async function killChildProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  await signalChildProcessTree(child, "SIGKILL", true);
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
  await terminateChildProcess(child);
  await waitForExit(child, graceMs);

  // 即使根进程已经退出，也继续补发 SIGKILL。某些 CLI 会留下忽略 SIGTERM 的孙进程；
  // 这些孙进程虽然已经被 init/systemd 接管，但通常仍处在最初的进程组里。
  await killChildProcess(child);
  await waitForExit(child, 500);
}

/**
 * 给子进程树发送信号。
 *
 * 取消 Claude/Codex/Gemini 这类 CLI 时，真实执行进程经常不是最初 spawn 的 pid，
 * 而是 shell、npx、node 或 pty 再拉起的孙进程。因此这里同时做三件事：
 *
 * 1. 类 Unix 系统优先杀进程组，也就是 process.kill(-pid, signal)。
 * 2. 再通过 ps 找出父子关系中的所有后代 pid，逐个补发信号。
 * 3. Windows 使用 taskkill /T 杀整棵进程树。
 *
 * @param child 子进程对象。
 * @param signal 要发送的信号。
 * @param force 是否强制终止，Windows 下会追加 /F。
 */
async function signalChildProcessTree(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
  force: boolean,
): Promise<void> {
  const pid = child.pid;
  if (!pid) {
    return;
  }

  if (process.platform === "win32") {
    await taskkillWindows(pid, force);
    return;
  }

  const descendantPids = await collectDescendantPids(pid);

  // detached 进程的 pgid 通常等于根 pid；杀进程组可以覆盖绝大多数 shell/npx/node 子进程。
  safeKill(-pid, signal);

  // 如果某些进程没有留在同一个进程组，则用父子关系结果做补杀。先杀深层后代，再杀根进程。
  for (const descendantPid of descendantPids.reverse()) {
    safeKill(descendantPid, signal);
  }
  safeKill(pid, signal);
}

/**
 * Windows 下使用 taskkill 结束进程树。
 *
 * @param pid 根进程 PID。
 * @param force 是否追加 /F 强制结束。
 */
async function taskkillWindows(pid: number, force: boolean): Promise<void> {
  const args = ["/PID", String(pid), "/T"];
  if (force) {
    args.push("/F");
  }

  await new Promise<void>((resolve) => {
    execFile("taskkill", args, () => resolve());
  });
}

/**
 * 收集指定 pid 的所有后代 pid。
 *
 * @param rootPid 根进程 PID。
 * @returns 后代 pid 列表，父进程会排在子进程之前。
 */
async function collectDescendantPids(rootPid: number): Promise<number[]> {
  const rows = await readProcessTable();
  const childrenByParent = new Map<number, number[]>();

  for (const row of rows) {
    const children = childrenByParent.get(row.ppid) ?? [];
    children.push(row.pid);
    childrenByParent.set(row.ppid, children);
  }

  const result: number[] = [];
  const queue = [...(childrenByParent.get(rootPid) ?? [])];
  while (queue.length > 0) {
    const currentPid = queue.shift();
    if (!currentPid || result.includes(currentPid)) {
      continue;
    }
    result.push(currentPid);
    queue.push(...(childrenByParent.get(currentPid) ?? []));
  }

  return result;
}

/**
 * 读取系统进程表中的 pid/ppid。
 *
 * @returns 进程表行列表。
 */
async function readProcessTable(): Promise<Array<{ pid: number; ppid: number }>> {
  const output = await new Promise<string>((resolve) => {
    execFile("ps", ["-eo", "pid=,ppid="], { encoding: "utf8" }, (error, stdout) => {
      if (error) {
        resolve("");
        return;
      }
      resolve(stdout);
    });
  });

  const rows: Array<{ pid: number; ppid: number }> = [];
  for (const line of output.split("\n")) {
    const [pidText, ppidText] = line.trim().split(/\s+/);
    const pid = Number.parseInt(pidText ?? "", 10);
    const ppid = Number.parseInt(ppidText ?? "", 10);
    if (Number.isFinite(pid) && Number.isFinite(ppid)) {
      rows.push({ pid, ppid });
    }
  }
  return rows;
}

/**
 * 忽略 ESRCH/EPERM 等信号发送错误，避免清理流程因竞态中断。
 *
 * @param pid 正数 pid 或负数进程组 id。
 * @param signal 要发送的信号。
 */
function safeKill(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // 进程可能已经退出，或者当前平台/权限不允许杀进程组；清理流程继续走后续兜底。
  }
}

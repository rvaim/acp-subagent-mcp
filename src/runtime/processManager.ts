import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentConfig, AgentEnvPolicy, AgentEnvValue, AppConfig } from "../config/types.js";
import { SubagentRuntimeError } from "./errors.js";

/**
 * 子进程启动结果。
 */
export interface SpawnedAgentProcess {
  /** Node child process。 */
  child: ChildProcessWithoutNullStreams;
  /** 子进程 pid。 */
  pid?: number;
}

/**
 * 用于识别本任务子进程家族的环境变量标记。
 * 某些 agent/adapter 会再启动脱离原 process group 的孙进程；只靠 PPID/PGID
 * 不一定能覆盖。给子进程注入唯一环境变量后，清理时可通过进程表兜底匹配。
 */
export interface ProcessEnvMarker {
  key: string;
  value: string;
}

/**
 * 根据 agent 配置构造子进程环境变量。
 *
 * 默认 env_policy=all：完整继承 MCP Server 进程可见的环境变量。这样 Claude、
 * Codex、Gemini 等子代理可以复用用户已经登录好的 CLI 配置、令牌、代理、证书
 * 和工具链路径。需要更严格控制时，可将 env_policy 改为 allowlist 或 none。
 */
export function buildAgentEnv(agent: AgentConfig, currentDepth: number, cwd: string): NodeJS.ProcessEnv {
  const policy = agent.env_policy ?? "all";
  const env = buildBaseEnv(policy, agent.env_allowlist ?? [], cwd);

  env.PATH = buildPathWithPackageBins(env.PATH ?? process.env.PATH ?? "");
  env.PWD = cwd;
  env.CLAUDE_PROJECT_DIR = nonEmpty(process.env.CLAUDE_PROJECT_DIR) ?? cwd;
  env.AGENT_DEPTH = String(currentDepth + 1);

  for (const [key, value] of Object.entries(agent.env ?? {})) {
    const resolved = resolveConfiguredEnvValue(value);
    if (resolved !== undefined) env[key] = resolved;
  }

  return removeUndefinedValues(env);
}

/**
 * 启动 ACP agent 子进程。
 */
export function spawnAgentProcess(options: {
  config: AppConfig;
  agent: AgentConfig;
  cwd: string;
  env: NodeJS.ProcessEnv;
  onStderr: (chunk: string) => void;
}): SpawnedAgentProcess {
  if (options.config.security.require_absolute_agent_command && !path.isAbsolute(options.agent.command)) {
    throw new SubagentRuntimeError("agent_spawn_failed", `agent command 必须是绝对路径：${options.agent.command}`);
  }

  const command = resolveExecutableOrThrow(options.agent.command, options.env, options.agent.args);
  const child = spawn(command, options.agent.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    shell: false
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => options.onStderr(chunk));

  child.on("error", () => {
    // 启动失败会导致 ACP initialize/prompt 超时或失败；这里不向 stdout 写任何内容。
  });

  return { child, pid: child.pid };
}

/**
 * 尝试终止子进程树。
 */
export async function terminateProcessTree(child: ChildProcessWithoutNullStreams, options: { sigtermGraceMs: number; sigkillGraceMs: number; envMarker?: ProcessEnvMarker }): Promise<void> {
  try {
    if (process.platform === "win32") {
      if (!hasChildExited(child)) child.kill("SIGTERM");
      await waitForChildExit(child, options.sigtermGraceMs);
      if (!hasChildExited(child)) {
        await taskkillProcessTree(child.pid);
        await waitForChildExit(child, options.sigkillGraceMs);
      }
      return;
    }

    const pid = child.pid;
    if (!pid) return;

    // macOS/Linux 下 adapter 可能再启动孙进程，且孙进程不一定保留在
    // adapter 的 process group 中。清理时同时覆盖：
    // 1. root pid；2. root pid 作为 PGID 的 detached group；
    // 3. ps 快照里能看到的所有后代 PID 和它们自己的 PGID。
    const targets = collectUnixKillTargets(pid, options.envMarker);
    signalUnixKillTargets(targets, "SIGTERM");
    await waitForChildExit(child, options.sigtermGraceMs);

    if (!hasChildExited(child) || isUnixKillTargetsAlive(targets) || isUnixProcessTreeAlive(pid, options.envMarker)) {
      signalUnixKillTargets(targets, "SIGKILL");
      signalUnixProcessTree(pid, "SIGKILL", options.envMarker);
      await waitForChildExit(child, options.sigkillGraceMs);
    }
  } finally {
    destroyChildStdio(child);
  }
}

/**
 * 构造基础环境变量。
 */
function buildBaseEnv(policy: AgentEnvPolicy, allowlist: string[], cwd: string): NodeJS.ProcessEnv {
  if (policy === "all") {
    return { ...process.env };
  }

  const env: NodeJS.ProcessEnv = minimalRuntimeEnv(cwd);

  if (policy === "allowlist") {
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && value !== "" && shouldInheritByAllowlist(key, allowlist)) {
        env[key] = value;
      }
    }
  }

  return removeUndefinedValues(env);
}

/**
 * 构造运行子进程所需的最小环境变量。
 *
 * 即使 env_policy=none，也保留 PATH/HOME/TMP 等基础变量，避免可执行文件
 * 无法解析或 CLI 无法找到用户配置目录。
 */
function minimalRuntimeEnv(cwd: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    USERPROFILE: process.env.USERPROFILE,
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    SHELL: process.env.SHELL,
    TERM: process.env.TERM,
    LANG: process.env.LANG,
    PWD: cwd
  };
}

/**
 * 判断某个宿主环境变量是否命中 allowlist。
 *
 * allowlist 支持两种写法：
 * - 精确变量名，例如 ANTHROPIC_API_KEY。
 * - 前缀通配，例如 ANTHROPIC_*，会匹配所有 ANTHROPIC_ 开头的变量。
 */
function shouldInheritByAllowlist(key: string, allowlist: string[]): boolean {
  return allowlist.some((pattern) => {
    if (!pattern) return false;
    if (pattern.endsWith("*")) return key.startsWith(pattern.slice(0, -1));
    return key === pattern;
  });
}

/**
 * 解析显式 env 配置。未设置的 from_env 不写入，避免空字符串覆盖已有登录配置。
 */
function resolveConfiguredEnvValue(value: AgentEnvValue): string | undefined {
  if (typeof value === "string") {
    if (value.startsWith("$")) return nonEmpty(process.env[value.slice(1)]);
    return value === "" ? undefined : value;
  }

  return nonEmpty(process.env[value.from_env]);
}

/**
 * 返回非空字符串。 */
function nonEmpty(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

/**
 * 删除值为 undefined 的环境变量条目。 */
function removeUndefinedValues(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  for (const key of Object.keys(env)) {
    if (env[key] === undefined) delete env[key];
  }
  return env;
}

/**
 * 向进程或进程组发送信号。
 */
function sendSignal(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (!child.pid) return;

  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // 如果杀进程组失败，则降级为杀单个进程。
    }
  }

  try {
    child.kill(signal);
  } catch {
    // 进程可能已经退出，忽略。
  }
}

/**
 * 判断 Unix process group 是否仍有成员。
 */
function isProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}


interface UnixProcessInfo {
  pid: number;
  ppid: number;
  pgid: number;
  command?: string;
}

interface UnixKillTargets {
  pids: Set<number>;
  pgids: Set<number>;
}

/**
 * 收集 Unix kill 目标。必须在第一次 SIGTERM 前完成，避免 root 退出后
 * detached 孙进程被 reparent 到 init，后续再按 PPID 就找不到。
 */
function collectUnixKillTargets(rootPid: number, envMarker?: ProcessEnvMarker): UnixKillTargets {
  const processes = collectUnixProcessTree(rootPid);
  const markerProcesses = envMarker ? collectUnixProcessesByEnvMarker(envMarker) : [];
  const combined = dedupeUnixProcesses([...processes, ...markerProcesses]);
  return {
    pids: new Set<number>([rootPid, ...combined.map((item) => item.pid)]),
    pgids: new Set<number>([rootPid, ...combined.map((item) => item.pgid).filter((pgid) => pgid > 1)])
  };
}

/**
 * 向 Unix 进程树和相关进程组发送信号。
 */
function signalUnixProcessTree(rootPid: number, signal: NodeJS.Signals, envMarker?: ProcessEnvMarker): void {
  signalUnixKillTargets(collectUnixKillTargets(rootPid, envMarker), signal);
}

/**
 * 向已收集的 Unix kill 目标发送信号。
 */
function signalUnixKillTargets(targets: UnixKillTargets, signal: NodeJS.Signals): void {
  const currentPgid = getProcessGroupId(process.pid);

  for (const pgid of targets.pgids) {
    if (pgid <= 1 || pgid === currentPgid) continue;
    try {
      process.kill(-pgid, signal);
    } catch {
      // 进程组可能已经消失，继续尝试单独 PID。
    }
  }

  // 先杀子孙，再杀 root，减少 adapter 继续向子进程写入的窗口。
  const orderedPids = [...targets.pids].sort((a, b) => b - a);
  for (const pid of orderedPids) {
    if (pid <= 1 || pid === process.pid) continue;
    try {
      process.kill(pid, signal);
    } catch {
      // 进程可能已经退出，忽略。
    }
  }
}

/**
 * 判断已收集的 Unix kill 目标是否仍有存活成员。
 */
function isUnixKillTargetsAlive(targets: UnixKillTargets): boolean {
  for (const pid of targets.pids) {
    if (isPidAlive(pid)) return true;
  }
  for (const pgid of targets.pgids) {
    if (isProcessGroupAlive(pgid)) return true;
  }
  return false;
}

/**
 * 判断 root pid、root process group 或其后代是否仍然存活。
 */
function isUnixProcessTreeAlive(rootPid: number, envMarker?: ProcessEnvMarker): boolean {
  if (isPidAlive(rootPid)) return true;
  if (isProcessGroupAlive(rootPid)) return true;
  const processes = envMarker
    ? dedupeUnixProcesses([...collectUnixProcessTree(rootPid), ...collectUnixProcessesByEnvMarker(envMarker)])
    : collectUnixProcessTree(rootPid);
  return processes.some((item) => isPidAlive(item.pid) || isProcessGroupAlive(item.pgid));
}

/**
 * 收集 root 进程和当前可见的所有后代进程。
 */
function collectUnixProcessTree(rootPid: number): UnixProcessInfo[] {
  const all = listUnixProcesses();
  const byPid = new Map(all.map((item) => [item.pid, item]));
  const byPpid = new Map<number, UnixProcessInfo[]>();
  for (const item of all) {
    const siblings = byPpid.get(item.ppid) ?? [];
    siblings.push(item);
    byPpid.set(item.ppid, siblings);
  }

  const result: UnixProcessInfo[] = [];
  const seen = new Set<number>();
  const root = byPid.get(rootPid);
  if (root) {
    result.push(root);
    seen.add(root.pid);
  }

  const queue = [rootPid];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const child of byPpid.get(parent) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      result.push(child);
      queue.push(child.pid);
    }
  }

  return result;
}

/**
 * 读取 Unix 进程表。失败时返回空数组，仍可依赖 root PID/PGID 兜底。
 */
function listUnixProcesses(): UnixProcessInfo[] {
  const output = spawnSync("ps", ["-axo", "pid=,ppid=,pgid="], { encoding: "utf8" });
  if (output.status !== 0 || !output.stdout) return [];

  return output.stdout
    .split(/\r?\n/)
    .map(parseUnixProcessLine)
    .filter((item): item is UnixProcessInfo => Boolean(item));
}

/**
 * 读取 Unix 进程表，尽量包含 command + environment。
 * Linux/procps 需要 `ps eww axo ...`，macOS/BSD 通常需要 `ps eww -axo ...`。
 */
function listUnixProcessesWithCommandAndEnv(): UnixProcessInfo[] {
  const attempts = [
    ["eww", "axo", "pid=,ppid=,pgid=,command="],
    ["eww", "-axo", "pid=,ppid=,pgid=,command="],
    ["-axo", "pid=,ppid=,pgid=,command="]
  ];

  for (const args of attempts) {
    const output = spawnSync("ps", args, { encoding: "utf8" });
    if (output.status !== 0 || !output.stdout) continue;
    const processes = output.stdout
      .split(/\r?\n/)
      .map(parseUnixProcessLine)
      .filter((item): item is UnixProcessInfo => Boolean(item));
    if (processes.length > 0) return processes;
  }

  return [];
}

/**
 * 解析 ps 输出行。前三列是 pid/ppid/pgid，剩余部分可作为 command/env。
 */
function parseUnixProcessLine(line: string): UnixProcessInfo | undefined {
  const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)(?:\s+(.*))?$/);
  if (!match) return undefined;
  const pid = Number(match[1]);
  const ppid = Number(match[2]);
  const pgid = Number(match[3]);
  if (![pid, ppid, pgid].every((value) => Number.isFinite(value))) return undefined;
  return { pid, ppid, pgid, command: match[4] };
}

/**
 * 通过唯一环境变量标记兜底查找已脱离原进程树的子进程。
 */
function collectUnixProcessesByEnvMarker(marker: ProcessEnvMarker): UnixProcessInfo[] {
  const needle = `${marker.key}=${marker.value}`;
  return listUnixProcessesWithCommandAndEnv().filter((item) => item.pid !== process.pid && item.command?.includes(needle));
}

/**
 * 按 PID 去重。
 */
function dedupeUnixProcesses(processes: UnixProcessInfo[]): UnixProcessInfo[] {
  const result: UnixProcessInfo[] = [];
  const seen = new Set<number>();
  for (const processInfo of processes) {
    if (seen.has(processInfo.pid)) continue;
    seen.add(processInfo.pid);
    result.push(processInfo);
  }
  return result;
}

/**
 * 获取指定 PID 的 process group id。
 */
function getProcessGroupId(pid: number): number | undefined {
  const output = spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" });
  if (output.status !== 0 || !output.stdout) return undefined;
  const pgid = Number(output.stdout.trim());
  return Number.isFinite(pgid) ? pgid : undefined;
}


/**
 * 判断 ChildProcess 是否已经发出退出状态。
 */
function hasChildExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/**
 * 等待 child exit，最多等待指定毫秒。
 */
function waitForChildExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (hasChildExited(child)) return Promise.resolve();
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout;
    const done = () => {
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve();
    };
    const onExit = () => done();
    timer = setTimeout(done, timeoutMs);
    child.once("exit", onExit);
  });
}

/**
 * 判断 PID 是否仍然存活。
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 延迟工具函数。
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Windows 下使用 taskkill 递归杀掉进程树。
 */
function taskkillProcessTree(pid: number | undefined): Promise<void> {
  if (!pid) return Promise.resolve();
  return new Promise((resolve) => {
    const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
    killer.once("exit", () => resolve());
    killer.once("error", () => resolve());
  });
}

/**
 * 销毁子进程 stdio，避免 MCP Server 因残留 pipe 句柄无法退出。
 */
function destroyChildStdio(child: ChildProcessWithoutNullStreams): void {
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
}

/**
 * 在 PATH 中追加当前包、上级包和当前项目的 node_modules/.bin。
 *
 * 这样用户把具体 ACP adapter 安装在项目依赖、全局依赖或 npx 临时环境中时，
 * MCP Server 都有机会找到对应可执行命令；本包本身不会捆绑这些 adapter。
 */
function buildPathWithPackageBins(existingPath: string): string {
  const bins = packageBinCandidates();
  return [...bins, existingPath].filter(Boolean).join(path.delimiter);
}

/**
 * 推断当前包附近可能存在的 node_modules/.bin 目录。
 */
function packageBinCandidates(): string[] {
  const currentFile = fileURLToPath(import.meta.url);
  const runtimeDir = path.dirname(currentFile);
  const candidates = [
    path.resolve(runtimeDir, "..", "..", "..", "node_modules", ".bin"),
    path.resolve(runtimeDir, "..", "..", "node_modules", ".bin"),
    path.resolve(process.cwd(), "node_modules", ".bin")
  ];
  return Array.from(new Set(candidates));
}

/**
 * 解析可执行文件路径，找不到时给出面向用户的安装提示。
 */
function resolveExecutableOrThrow(command: string, env: NodeJS.ProcessEnv, args: string[]): string {
  if (path.isAbsolute(command) || command.includes(path.sep) || (path.sep === "\\" && command.includes("/"))) {
    return command;
  }

  const pathEntries = (env.PATH ?? process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const candidates = executableCandidates(command);
  for (const dir of pathEntries) {
    for (const candidate of candidates) {
      const fullPath = path.join(dir, candidate);
      try {
        accessSync(fullPath, constants.X_OK);
        return fullPath;
      } catch {
        // 继续查找下一个 PATH 目录。
      }
    }
  }

  throw new SubagentRuntimeError(
    "agent_spawn_failed",
    buildMissingCommandMessage(command, args),
    { recoverable: true }
  );
}

/**
 * 根据平台生成可执行文件候选名。
 */
function executableCandidates(command: string): string[] {
  if (process.platform !== "win32") return [command];
  const extensions = ["", ".exe", ".cmd", ".bat", ".ps1"];
  return extensions.map((ext) => `${command}${ext}`);
}

/**
 * 构造缺少默认子代理时的提示。
 */
function buildMissingCommandMessage(command: string, args: string[]): string {
  const configured = [command, ...args].join(" ");
  if (command === "claude-agent-acp") {
    return [
      "未找到默认 默认 ACP 子代理命令：claude-agent-acp。",
      "请确认 claude-agent-acp 已位于 PATH 中。本 MCP 包不会自动安装或捆绑任何具体子代理 adapter。",
      "也可以设置环境变量 ACP_SUBAGENT_DEFAULT_AGENT_COMMAND=/absolute/path/to/claude-agent-acp，或创建 agents.toml 自定义默认 agent。",
      `当前配置命令：${configured}`
    ].join(" ");
  }
  return `未找到子代理命令：${configured}。请安装该子代理，或通过 agents.toml / 环境变量指定正确路径。`;
}

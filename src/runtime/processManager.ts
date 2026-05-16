import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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
export async function terminateProcessTree(child: ChildProcessWithoutNullStreams, options: { sigtermGraceMs: number; sigkillGraceMs: number }): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  sendSignal(child, "SIGTERM");
  await delay(options.sigtermGraceMs);
  if (child.exitCode !== null || child.signalCode !== null) return;

  sendSignal(child, "SIGKILL");
  await delay(options.sigkillGraceMs);
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
 * 延迟工具函数。
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

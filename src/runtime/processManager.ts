import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentConfig, AppConfig } from "../config/types.js";
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
 * 根据 agent 配置构造最小化环境变量。
 */
export function buildAgentEnv(agent: AgentConfig, currentDepth: number, cwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: buildPathWithPackageBins(),
    HOME: process.env.HOME ?? "",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    PWD: cwd,
    CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR ?? cwd,
    AGENT_DEPTH: String(currentDepth + 1)
  };

  for (const [key, value] of Object.entries(agent.env ?? {})) {
    if (typeof value === "string") {
      env[key] = value.startsWith("$") ? process.env[value.slice(1)] ?? "" : value;
    } else {
      env[key] = process.env[value.from_env] ?? "";
    }
  }

  return env;
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
 * MCP Server 都有机会找到对应可执行命令；本包本身不会捆绑这些 adapter。 */
function buildPathWithPackageBins(): string {
  const bins = packageBinCandidates();
  return [...bins, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter);
}

/**
 * 推断当前包附近可能存在的 node_modules/.bin 目录。 */
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
 * 解析可执行文件路径，找不到时给出面向用户的安装提示。 */
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
 * 根据平台生成可执行文件候选名。 */
function executableCandidates(command: string): string[] {
  if (process.platform !== "win32") return [command];
  const extensions = ["", ".exe", ".cmd", ".bat", ".ps1"];
  return extensions.map((ext) => `${command}${ext}`);
}

/**
 * 构造缺少默认子代理时的提示。 */
function buildMissingCommandMessage(command: string, args: string[]): string {
  const configured = [command, ...args].join(" ");
  if (command === "claude-agent-acp") {
    return [
      "未找到默认 Claude ACP 子代理命令：claude-agent-acp。",
      "请确认 claude-agent-acp 已位于 PATH 中。本 MCP 包不会自动安装或捆绑任何具体子代理 adapter。",
      "也可以设置环境变量 ACP_SUBAGENT_CLAUDE_COMMAND=/absolute/path/to/claude-agent-acp，或创建 agents.toml 自定义 [agents.claude]。",
      `当前配置命令：${configured}`
    ].join(" ");
  }
  return `未找到子代理命令：${configured}。请安装该子代理，或通过 agents.toml / 环境变量指定正确路径。`;
}

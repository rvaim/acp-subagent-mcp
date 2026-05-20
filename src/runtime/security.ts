import fs from "node:fs/promises";
import path from "node:path";
import type { ServerConfig } from "../config/types.js";
import type { SubagentTask, TaskFile } from "../task/types.js";

/**
 * 校验工作目录是否安全。
 *
 * @param cwd 用户传入的工作目录，必须是绝对路径。
 * @param allowedRoots 配置中允许访问的根目录列表。
 * @returns 返回解析后的安全工作目录。
 * @throws 当 cwd 不是绝对路径或不在允许目录下时抛出错误。
 */
export async function validateSafeCwd(cwd: string, allowedRoots: string[]): Promise<string> {
  if (!path.isAbsolute(cwd)) {
    throw new Error("工作目录 cwd 必须是绝对路径");
  }

  // 使用 realpath 解析符号链接，避免通过软链接逃逸 allowed_cwd_roots。
  const resolvedCwd = await safeRealpath(cwd);
  const resolvedRoots = await Promise.all(allowedRoots.map((root) => safeRealpath(root)));

  const isAllowed = resolvedRoots.some((root) => resolvedCwd === root || resolvedCwd.startsWith(root + path.sep));
  if (!isAllowed) {
    throw new Error(`工作目录不在 allowed_cwd_roots 内：${resolvedCwd}`);
  }

  return resolvedCwd;
}

/**
 * 校验任务中的文件路径、内联内容大小和路径穿越问题。
 *
 * @param task 子代理任务。
 * @param cwd 已校验的安全工作目录。
 * @param config 服务器配置。
 * @throws 当文件路径不安全或内容过大时抛出错误。
 */
export async function validateTaskFiles(task: SubagentTask, cwd: string, config: ServerConfig): Promise<void> {
  for (const file of task.files ?? []) {
    validateRelativeFilePath(file.path);

    const contentMode = file.content_mode ?? "path_only";
    if ((contentMode === "inline" || contentMode === "snippet") && (file.content?.length ?? 0) > config.defaults.max_inline_file_chars) {
      throw new Error(`文件 ${file.path} 的 inline/snippet 内容超过 max_inline_file_chars`);
    }

    const absoluteFilePath = path.resolve(cwd, file.path);
    const normalizedCwd = path.resolve(cwd);
    if (absoluteFilePath !== normalizedCwd && !absoluteFilePath.startsWith(normalizedCwd + path.sep)) {
      throw new Error(`文件路径逃逸工作目录：${file.path}`);
    }

    // 对已存在的路径做 realpath 检查；create 场景中目标文件可能还不存在，因此允许 ENOENT。
    try {
      const realFilePath = await fs.realpath(absoluteFilePath);
      if (realFilePath !== normalizedCwd && !realFilePath.startsWith(normalizedCwd + path.sep)) {
        throw new Error(`文件真实路径逃逸工作目录：${file.path}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
}

/**
 * 校验 agent_type 是否存在于配置文件。
 *
 * @param agentType 工具输入中的 agent_type。
 * @param config 服务器配置。
 * @throws 当 agent_type 未配置时抛出错误。
 */
export function validateAgentType(agentType: string, config: ServerConfig): void {
  if (!config.agents[agentType]) {
    throw new Error(`未知 agent_type：${agentType}`);
  }
}

/**
 * 校验递归代理深度。
 *
 * @param maxDepth 配置允许的最大深度。
 * @throws 当环境变量 AGENT_DEPTH 超限时抛出错误。
 */
export function validateAgentDepth(maxDepth: number): void {
  const depth = Number.parseInt(process.env.AGENT_DEPTH ?? "0", 10);
  if (Number.isFinite(depth) && depth >= maxDepth) {
    throw new Error(`AGENT_DEPTH=${depth} 已达到 max_depth=${maxDepth}，拒绝递归调用子代理`);
  }
}

/**
 * 判断任务是否可能写文件。
 *
 * @param task 子代理任务。
 * @param mode 子代理运行模式。
 * @returns 如果任务可能写文件则返回 true。
 */
export function isWriteTask(task: SubagentTask, mode?: string): boolean {
  if (mode === "edit" || mode === "implement" || mode === "debug") {
    return true;
  }
  return (task.files ?? []).some((file) => ["edit", "create", "delete"].includes(file.action));
}

/**
 * 校验相对文件路径，禁止绝对路径和路径穿越。
 *
 * @param filePath 任务中声明的文件路径。
 * @throws 当路径不安全时抛出错误。
 */
function validateRelativeFilePath(filePath: string): void {
  if (!filePath || path.isAbsolute(filePath)) {
    throw new Error(`文件路径必须是相对路径：${filePath}`);
  }
  const parts = filePath.split(/[\\/]+/);
  if (parts.includes("..")) {
    throw new Error(`文件路径不能包含路径穿越：${filePath}`);
  }
}

/**
 * 安全解析真实路径。
 *
 * @param inputPath 输入路径。
 * @returns realpath；当路径不存在时返回 path.resolve 结果。
 */
async function safeRealpath(inputPath: string): Promise<string> {
  try {
    return await fs.realpath(inputPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return path.resolve(inputPath);
    }
    throw error;
  }
}

/**
 * 将外部传入的 mcp_servers 归一化成 ACP session/new 需要的数组格式。
 *
 * @param mcpServers 工具输入中的 mcp_servers。
 * @returns 归一化后的 MCP servers 数组。
 */
export function normalizeMcpServersForAcp(mcpServers: Record<string, unknown> | unknown[] | undefined): unknown[] {
  if (!mcpServers) {
    return [];
  }
  if (Array.isArray(mcpServers)) {
    return mcpServers;
  }

  const output: unknown[] = [];
  for (const [name, value] of Object.entries(mcpServers)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      output.push({ name, ...(value as Record<string, unknown>) });
    } else {
      output.push({ name, value });
    }
  }
  return output;
}

import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../config/types.js";
import type { ResolvedTaskFile, SubagentRunInput, SubagentTask, TaskFile } from "../task/types.js";
import { SubagentRuntimeError } from "./errors.js";

/**
 * 校验 agent 类型是否存在。
 */
export function assertKnownAgent(config: AppConfig, agentType: string): void {
  if (!config.agents[agentType]) {
    throw new SubagentRuntimeError("unknown_agent_type", `未知子代理类型：${agentType}`);
  }
}

/**
 * 校验递归调用深度。
 */
export function assertDepthAllowed(maxDepth: number): number {
  const currentDepth = Number.parseInt(process.env.AGENT_DEPTH ?? "0", 10);
  const safeDepth = Number.isFinite(currentDepth) ? currentDepth : 0;
  if (safeDepth >= maxDepth) {
    throw new SubagentRuntimeError("permission_denied", `子代理递归深度超过限制：${maxDepth}`);
  }
  return safeDepth;
}

/**
 * 校验并解析安全工作目录。
 */
export async function resolveSafeCwd(cwd: string | undefined, allowedRoots: string[]): Promise<string> {
  const candidate = path.resolve(cwd ?? process.cwd());

  if (!path.isAbsolute(candidate)) {
    throw new SubagentRuntimeError("unsafe_cwd", "cwd 必须是绝对路径");
  }

  if (allowedRoots.length === 0) {
    throw new SubagentRuntimeError("unsafe_cwd", "未配置 allowed_cwd_roots，拒绝运行子代理");
  }

  const realCwd = await realpath(candidate).catch((error) => {
    throw new SubagentRuntimeError("unsafe_cwd", `cwd 不存在或不可访问：${candidate}`, { cause: error });
  });

  const realRoots = await Promise.all(
    allowedRoots.map(async (root) => realpath(path.resolve(root)).catch(() => path.resolve(root)))
  );

  const allowed = realRoots.some((root) => isInsideOrEqual(root, realCwd));
  if (!allowed) {
    throw new SubagentRuntimeError("unsafe_cwd", `cwd 不在 allowed_cwd_roots 内：${realCwd}`);
  }

  return realCwd;
}

/**
 * 校验任务文件路径，并转换为内部绝对路径。
 */
export async function resolveTaskFiles(options: {
  cwd: string;
  files?: TaskFile[];
  maxInlineChars: number;
}): Promise<ResolvedTaskFile[]> {
  const files = options.files ?? [];
  const resolved: ResolvedTaskFile[] = [];

  for (const file of files) {
    validateRelativeTaskPath(file.path);

    if ((file.content_mode === "inline" || file.content_mode === "snippet") && file.content) {
      if (file.content.length > options.maxInlineChars) {
        throw new SubagentRuntimeError("inline_file_too_large", `内联文件内容过大：${file.path}`);
      }
    }

    const absolutePath = path.resolve(options.cwd, file.path);
    const safeAbsolutePath = await resolveExistingOrParentPath(options.cwd, absolutePath);

    resolved.push({
      ...file,
      content_mode: file.content_mode ?? "path_only",
      relativePath: normalizeRelativePath(file.path),
      absolutePath: safeAbsolutePath
    });
  }

  return resolved;
}

/**
 * 校验 prompt 大小。
 */
export function assertPromptSize(prompt: string, maxPromptChars: number): void {
  if (prompt.length > maxPromptChars) {
    throw new SubagentRuntimeError("prompt_too_large", `渲染后的 prompt 过大：${prompt.length}/${maxPromptChars}`);
  }
}

/**
 * 判断任务是否可能写文件。
 */
export function taskRequiresWrite(input: Pick<SubagentRunInput, "mode" | "task">): boolean {
  if (input.mode === "edit" || input.mode === "implement" || input.mode === "debug") {
    return true;
  }

  return (input.task.files ?? []).some((file) => ["edit", "create", "delete"].includes(file.action));
}

/**
 * 校验 ACP 传入的绝对文件路径是否仍在 cwd 内。
 */
export async function resolveAcpAbsolutePathInsideCwd(cwd: string, absoluteFilePath: string): Promise<string> {
  if (!path.isAbsolute(absoluteFilePath)) {
    throw new SubagentRuntimeError("path_traversal", `ACP 文件路径必须是绝对路径：${absoluteFilePath}`);
  }

  const safeAbsolutePath = path.resolve(absoluteFilePath);
  return resolveExistingOrParentPath(cwd, safeAbsolutePath);
}

/**
 * 把绝对路径转换为相对 cwd 的展示路径。
 */
export function toDisplayRelativePath(cwd: string, absolutePath: string): string {
  const relative = path.relative(cwd, absolutePath);
  return relative && !relative.startsWith("..") ? normalizeRelativePath(relative) : absolutePath;
}

/**
 * 校验是否存在动态 mcp_servers 注入。
 */
export function rejectDynamicMcpServers(rawInput: unknown): void {
  if (rawInput && typeof rawInput === "object" && "mcp_servers" in rawInput) {
    throw new SubagentRuntimeError(
      "mcp_server_profile_not_allowed",
      "MVP 禁止通过 tool input 传动态 mcp_servers，请改用 mcp_server_profiles"
    );
  }
}

/**
 * 规范化任务文件路径为 POSIX 风格展示。
 */
function normalizeRelativePath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

/**
 * 校验任务文件路径是安全相对路径。
 */
function validateRelativeTaskPath(filePath: string): void {
  if (!filePath || filePath.includes("\0")) {
    throw new SubagentRuntimeError("path_traversal", "文件路径为空或包含非法字符");
  }

  if (path.isAbsolute(filePath) || path.win32.isAbsolute(filePath) || /^[A-Za-z]:/.test(filePath)) {
    throw new SubagentRuntimeError("path_traversal", `文件路径必须是相对路径：${filePath}`);
  }

  const normalized = path.normalize(filePath);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`) || normalized.includes(`${path.sep}..${path.sep}`)) {
    throw new SubagentRuntimeError("path_traversal", `文件路径不能路径穿越：${filePath}`);
  }
}

/**
 * 对已存在文件取 realpath；不存在时校验父目录 realpath。
 */
async function resolveExistingOrParentPath(cwd: string, absolutePath: string): Promise<string> {
  const realCwd = await realpath(cwd);
  const exists = await stat(absolutePath).then(() => true).catch(() => false);

  if (exists) {
    const realFile = await realpath(absolutePath);
    if (!isInsideOrEqual(realCwd, realFile)) {
      throw new SubagentRuntimeError("path_traversal", `文件真实路径逃出 cwd：${absolutePath}`);
    }
    return realFile;
  }

  const parent = path.dirname(absolutePath);
  const realParent = await realpath(parent).catch((error) => {
    throw new SubagentRuntimeError("path_traversal", `文件父目录不存在或不可访问：${parent}`, { cause: error });
  });

  if (!isInsideOrEqual(realCwd, realParent)) {
    throw new SubagentRuntimeError("path_traversal", `文件父目录逃出 cwd：${absolutePath}`);
  }

  return absolutePath;
}

/**
 * 判断 child 是否位于 parent 内或等于 parent。
 */
function isInsideOrEqual(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * 从任务中提取所有文件路径，供日志和 prompt 使用。
 */
export function listTaskFilePaths(task: SubagentTask): string[] {
  return (task.files ?? []).map((file) => file.path);
}

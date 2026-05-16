import { cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { execFile as execFileCb } from "node:child_process";
import type { AppConfig } from "../config/types.js";
import type { ConflictPolicy, SubagentRunStatus } from "../task/types.js";
import { SubagentRuntimeError } from "./errors.js";

/** promisify 后的 execFile，避免使用 shell。 */
const execFile = promisify(execFileCb);

/**
 * worktree 沙箱运行信息。
 */
export interface WorktreeRuntimeInfo {
  /** 原始 cwd。 */
  originalCwd: string;
  /** git 仓库根目录。 */
  repoRoot: string;
  /** worktree 根目录。 */
  worktreeRoot: string;
  /** 传给 ACP session 的执行 cwd。 */
  executionCwd: string;
  /** patch 文件路径。 */
  patchPath: string;
  /** patch 是否因为过大被截断。 */
  patchTruncated: boolean;
}

/**
 * 根据冲突策略准备实际执行目录。
 */
export async function prepareExecutionWorkspace(options: {
  /** 应用配置。 */
  config: AppConfig;
  /** 原始安全 cwd。 */
  cwd: string;
  /** 任务 ID。 */
  taskId: string;
  /** 是否为潜在写任务。 */
  isWriter: boolean;
  /** 冲突策略。 */
  conflictPolicy: ConflictPolicy;
}): Promise<{ executionCwd: string; worktree?: WorktreeRuntimeInfo }> {
  if (!options.isWriter || options.conflictPolicy !== "sandbox_worktree") {
    return { executionCwd: options.cwd };
  }

  if (!options.config.worktree.enabled) {
    throw new SubagentRuntimeError("concurrency_conflict", "配置未启用 worktree.enabled，不能使用 sandbox_worktree", { recoverable: true });
  }

  const repoRoot = await getGitRepoRoot(options.cwd);
  const relativeCwd = path.relative(repoRoot, options.cwd);
  const baseDir = path.isAbsolute(options.config.worktree.base_dir)
    ? options.config.worktree.base_dir
    : path.resolve(repoRoot, options.config.worktree.base_dir);
  const worktreeRoot = path.join(baseDir, options.taskId);
  const executionCwd = path.resolve(worktreeRoot, relativeCwd || ".");
  const patchPath = path.join(worktreeRoot, ".subagent.patch");

  await mkdir(baseDir, { recursive: true, mode: 0o700 });
  await execGit(["-C", repoRoot, "worktree", "add", "--detach", worktreeRoot, "HEAD"], options.config.worktree.max_patch_bytes);

  if (options.config.worktree.include_untracked) {
    await copyUntrackedFiles(repoRoot, worktreeRoot);
  }

  return {
    executionCwd,
    worktree: {
      originalCwd: options.cwd,
      repoRoot,
      worktreeRoot,
      executionCwd,
      patchPath,
      patchTruncated: false
    }
  };
}

/**
 * 完成 worktree 任务后提取 patch，并按配置决定是否清理 worktree。
 */
export async function finalizeWorktree(options: {
  /** 应用配置。 */
  config: AppConfig;
  /** worktree 运行信息。 */
  worktree?: WorktreeRuntimeInfo;
  /** 任务最终状态。 */
  status: SubagentRunStatus;
}): Promise<WorktreeRuntimeInfo | undefined> {
  if (!options.worktree) return undefined;
  const info = options.worktree;

  try {
    // 让 git diff 能显示新建未跟踪文件，但不真正提交内容。
    await execGit(["-C", info.worktreeRoot, "add", "-N", "."], options.config.worktree.max_patch_bytes).catch(() => undefined);
    const diff = await execGit(["-C", info.worktreeRoot, "diff", "--binary", "--no-ext-diff", "HEAD", "--"], options.config.worktree.max_patch_bytes + 1);
    const truncated = Buffer.byteLength(diff, "utf8") > options.config.worktree.max_patch_bytes;
    const patch = truncated ? diff.slice(0, options.config.worktree.max_patch_bytes) + "\n[TRUNCATED]\n" : diff;
    info.patchTruncated = truncated;
    await writeFile(info.patchPath, patch, { mode: 0o600 });
  } finally {
    const keep = options.status === "completed" || options.status === "partial"
      ? options.config.worktree.keep_on_success
      : options.config.worktree.keep_on_failure;
    if (!keep) {
      await execGit(["-C", info.repoRoot, "worktree", "remove", "--force", info.worktreeRoot], options.config.worktree.max_patch_bytes).catch(() => undefined);
    }
  }

  return info;
}

/**
 * 获取 cwd 所属 git 仓库根目录。
 */
async function getGitRepoRoot(cwd: string): Promise<string> {
  try {
    const output = await execGit(["-C", cwd, "rev-parse", "--show-toplevel"], 1024 * 1024);
    return output.trim();
  } catch (error) {
    throw new SubagentRuntimeError("concurrency_conflict", `sandbox_worktree 需要 cwd 位于 git 仓库中：${cwd}`, { cause: error, recoverable: true });
  }
}

/**
 * 复制未跟踪文件到 worktree。
 */
async function copyUntrackedFiles(repoRoot: string, worktreeRoot: string): Promise<void> {
  const output = await execGit(["-C", repoRoot, "ls-files", "--others", "--exclude-standard", "-z"], 10 * 1024 * 1024);
  const files = output.split("\0").filter(Boolean);
  for (const file of files) {
    const source = path.join(repoRoot, file);
    const target = path.join(worktreeRoot, file);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(source, target, { recursive: true, force: true, errorOnExist: false });
  }
}

/**
 * 运行 git 命令并返回 stdout。
 */
async function execGit(args: string[], maxBuffer: number): Promise<string> {
  const result = await execFile("git", args, { encoding: "utf8", maxBuffer });
  return result.stdout;
}

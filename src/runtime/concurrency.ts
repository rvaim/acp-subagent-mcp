import type { AppConfig } from "../config/types.js";
import type { ConflictPolicy } from "../task/types.js";
import { SubagentRuntimeError } from "./errors.js";

/**
 * 并发锁释放函数。
 */
export type ReleaseConcurrencyLock = () => void;

/**
 * 子代理任务并发控制器。
 */
export class ConcurrencyManager {
  /** 当前活跃任务数。 */
  private activeTasks = 0;
  /** 每个 cwd 当前写任务数量。 */
  private writersByCwd = new Map<string, number>();

  /**
   * 尝试获取并发锁。
   */
  acquire(options: { config: AppConfig; cwd: string; isWriter: boolean; conflictPolicy?: ConflictPolicy }): ReleaseConcurrencyLock {
    if (this.activeTasks >= options.config.concurrency.max_parallel_tasks) {
      throw new SubagentRuntimeError("concurrency_conflict", "活跃子代理任务数已达到上限", { recoverable: true });
    }

    const policy = options.conflictPolicy ?? options.config.concurrency.default_conflict_policy;
    const currentWriters = this.writersByCwd.get(options.cwd) ?? 0;

    // allow_readonly_parallel 和 single_writer_per_cwd 都不允许同 cwd 多写者；sandbox_worktree 通过独立 worktree 放开。
    if (options.isWriter && policy !== "sandbox_worktree" && currentWriters > 0) {
      throw new SubagentRuntimeError("concurrency_conflict", `当前 cwd 已有写任务运行：${options.cwd}`, { recoverable: true });
    }

    this.activeTasks += 1;
    if (options.isWriter && policy !== "sandbox_worktree") {
      this.writersByCwd.set(options.cwd, currentWriters + 1);
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeTasks = Math.max(0, this.activeTasks - 1);
      if (options.isWriter && policy !== "sandbox_worktree") {
        const current = this.writersByCwd.get(options.cwd) ?? 0;
        if (current <= 1) this.writersByCwd.delete(options.cwd);
        else this.writersByCwd.set(options.cwd, current - 1);
      }
    };
  }

  /**
   * 返回当前活跃任务数，主要用于测试和诊断。
   */
  getActiveTaskCount(): number {
    return this.activeTasks;
  }
}

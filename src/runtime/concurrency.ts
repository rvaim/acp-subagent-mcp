import type { SubagentTask } from "../task/types.js";
import { isWriteTask } from "./security.js";

/**
 * 并发占用记录。
 */
interface ConcurrencyLease {
  /** 占用 ID，通常是 task_id。 */
  id: string;

  /** 工作目录。 */
  cwd: string;

  /** 是否为写任务。 */
  write: boolean;
}

/**
 * 子代理并发与写冲突控制器。
 */
export class ConcurrencyGuard {
  /** 当前活跃任务占用表。 */
  private readonly leases = new Map<string, ConcurrencyLease>();

  /**
   * 创建并发控制器。
   *
   * @param maxParallelTasks 最大并行任务数。
   */
  constructor(private readonly maxParallelTasks: number) {}

  /**
   * 尝试占用一个并发槽位。
   *
   * @param id 占用 ID。
   * @param cwd 工作目录。
   * @param task 子代理任务。
   * @param mode 任务模式。
   * @param policy 冲突策略。
   * @throws 当超过最大并发数或写冲突时抛出错误。
   */
  acquire(
    id: string,
    cwd: string,
    task: SubagentTask,
    mode: string | undefined,
    policy: "allow_readonly_parallel" | "single_writer_per_cwd" | "sandbox_worktree",
  ): void {
    if (this.leases.size >= this.maxParallelTasks) {
      throw new Error(`当前活跃任务数已达到 max_parallel_tasks=${this.maxParallelTasks}`);
    }

    const write = isWriteTask(task, mode);
    if (policy !== "sandbox_worktree" && write) {
      for (const lease of this.leases.values()) {
        const sameCwd = lease.cwd === cwd;
        const conflict = policy === "single_writer_per_cwd" ? sameCwd && (lease.write || write) : sameCwd && lease.write;
        if (conflict) {
          throw new Error(`检测到同一 cwd 的并行写冲突：${cwd}`);
        }
      }
    }

    this.leases.set(id, { id, cwd, write });
  }

  /**
   * 释放一个并发槽位。
   *
   * @param id 占用 ID。
   */
  release(id: string): void {
    this.leases.delete(id);
  }

  /**
   * 获取当前活跃任务数。
   *
   * @returns 活跃任务数量。
   */
  activeCount(): number {
    return this.leases.size;
  }
}

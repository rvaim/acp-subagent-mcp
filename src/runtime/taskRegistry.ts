import { EventEmitter } from "node:events";
import type { GenericAcpClient } from "../acp/AcpClient.js";
import type { AgentConfig } from "../config/types.js";
import type { RunLogger } from "./logs.js";
import type { ReleaseConcurrencyLock } from "./concurrency.js";
import type { RunTimeoutController } from "./timeouts.js";
import type { WorktreeRuntimeInfo } from "./worktree.js";
import type {
  ConflictPolicy,
  SubagentError,
  SubagentMode,
  SubagentOutputOptions,
  SubagentRunOutput,
  SubagentTask,
  SubagentTaskState,
  ToolCallSummary
} from "../task/types.js";

/**
 * 单个 prompt turn 的运行记录。
 */
export interface SubagentTurnRecord {
  /** turn id。 */
  turnId: string;
  /** 创建时间。 */
  createdAt: Date;
  /** 本轮 prompt 摘要，避免内存中保存过大内容。 */
  promptPreview: string;
  /** 本轮状态。 */
  status: "running" | "completed" | "failed" | "timeout" | "cancelled";
  /** 本轮结果。 */
  result?: SubagentRunOutput;
}

/**
 * 正在运行或已完成、可用于同步打回重写的子代理任务元数据。
 *
 * 重要：完成后会清理 ACP client 和子进程，只保留 task/result/log 路径等轻量元数据。
 */
export interface ActiveSubagentTask {
  /** MCP Server 对外暴露的 task id。 */
  taskId: string;
  /** 子代理类型。 */
  agentType: string;
  /** agent 配置。 */
  agent: AgentConfig;
  /** 原始安全 cwd。 */
  cwd: string;
  /** 实际执行 cwd，sandbox_worktree 时会指向 worktree。 */
  executionCwd: string;
  /** 任务模式。 */
  mode: SubagentMode;
  /** 当前任务状态。 */
  status: SubagentTaskState;
  /** 是否为潜在写任务。 */
  isWriter: boolean;
  /** 当前冲突策略。 */
  conflictPolicy: ConflictPolicy;
  /** 创建时间。 */
  createdAt: Date;
  /** 启动时间。 */
  startedAt?: Date;
  /** 完成时间。 */
  completedAt?: Date;
  /** 最近一次有效活动时间。 */
  lastActivityAt?: Date;
  /** ACP session id。 */
  sessionId?: string;
  /** ACP client。完成后会清空。 */
  client?: GenericAcpClient;
  /** 运行日志。 */
  logger?: RunLogger;
  /** worktree 运行信息。 */
  worktree?: WorktreeRuntimeInfo;
  /** 当前 prompt turn id。 */
  currentTurnId?: string;
  /** 所有 turn 记录。 */
  turns: SubagentTurnRecord[];
  /** 当前 turn promise。 */
  currentTurnPromise?: Promise<void>;
  /** 当前超时控制器。 */
  timeoutController?: RunTimeoutController;
  /** 当前 turn 使用的 inactivity timeout 毫秒数，用于收到 agent update 时重置计时器。 */
  currentInactivityTimeoutMs?: number;
  /** 任务原始结构。 */
  task: SubagentTask;
  /** 输出压缩选项。 */
  outputOptions: Required<SubagentOutputOptions>;
  /** 最终或最近一轮结果。 */
  result?: SubagentRunOutput;
  /** 部分输出。 */
  partialOutput: string;
  /** 工具调用摘要。 */
  toolCalls: ToolCallSummary[];
  /** 触碰文件。 */
  filesTouched: string[];
  /** 错误列表。 */
  errors: SubagentError[];
  /** 并发锁释放函数。 */
  releaseConcurrency?: ReleaseConcurrencyLock;
  /** 是否已经清理进程和锁。 */
  cleanedUp: boolean;
  /** 正在进行的清理 promise，避免并发清理时提前返回。 */
  cleanupPromise?: Promise<void>;
  /** 更新序号，用于内部等待和测试。 */
  updateSeq: number;
}

/**
 * 子代理任务注册表。
 */
export class TaskRegistry {
  /** 任务映射。 */
  private readonly tasks = new Map<string, ActiveSubagentTask>();
  /** 任务变化事件。 */
  private readonly events = new EventEmitter();

  /**
   * 添加任务。
   */
  add(task: ActiveSubagentTask): void {
    this.tasks.set(task.taskId, task);
    this.notify(task.taskId);
  }

  /**
   * 根据 ID 获取任务。
   */
  get(taskId: string): ActiveSubagentTask | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * 删除任务记录。日志文件不会被删除。
   */
  remove(taskId: string): void {
    this.tasks.delete(taskId);
    this.notify(taskId);
  }

  /**
   * 列出所有任务。当前主要用于 shutdown 清理和测试。
   */
  list(): ActiveSubagentTask[] {
    return Array.from(this.tasks.values());
  }

  /**
   * 标记任务有变化，并唤醒内部等待。
   */
  notify(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task) task.updateSeq += 1;
    this.events.emit("change", taskId);
  }

  /**
   * 等待任意任务变化或超时。
   */
  waitForChange(timeoutMs: number): Promise<string | undefined> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.events.off("change", onChange);
        resolve(undefined);
      }, timeoutMs);
      const onChange = (taskId: string) => {
        clearTimeout(timer);
        this.events.off("change", onChange);
        resolve(taskId);
      };
      this.events.on("change", onChange);
    });
  }
}

/**
 * 判断任务是否处于终态。
 */
export function isTerminalTaskState(status: SubagentTaskState): boolean {
  return ["completed", "failed", "partial", "timeout", "cancelled", "closed"].includes(status);
}

/**
 * 判断任务是否已经完成但尚未关闭。
 */
export function isFinishedTaskState(status: SubagentTaskState): boolean {
  return ["completed", "failed", "partial", "timeout", "cancelled"].includes(status);
}

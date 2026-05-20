import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { GenericAcpClient } from "../acp/AcpClient.js";
import type { RunLogPaths } from "./logs.js";
import type {
  InteractionDetailLevel,
  SubagentRunOutput,
  SubagentTaskState,
  ToolCallSummary,
} from "../task/types.js";

/**
 * 正在运行或保留中的子代理任务。
 */
export interface ActiveSubagentRun {
  /** MCP Server 生成的任务 ID。 */
  taskId: string;

  /** 子代理类型。 */
  agentType: string;

  /** ACP session id。 */
  sessionId?: string;

  /** 子代理进程 ID。 */
  processId?: number;

  /** 当前任务状态。 */
  status: SubagentTaskState;

  /** 任务创建时间。 */
  createdAt: Date;

  /** 任务开始时间。 */
  startedAt?: Date;

  /** 任务完成时间。 */
  completedAt?: Date;

  /** 最近一次有效活动时间。 */
  lastActivityAt?: Date;

  /** 最近一次心跳或协议响应时间。 */
  lastHeartbeatAt?: Date;

  /** 是否复用了会话池中的已有 session。 */
  reusedSession?: boolean;

  /** 估算的上下文使用比例，范围 0 到 1。 */
  contextUsageRatio?: number;

  /** 工作目录。 */
  cwd?: string;

  /** 任务模式。 */
  mode?: string;

  /** 父代理 ID。 */
  parentAgentId: string;

  /** 当前正在运行的 turn id。 */
  currentTurnId?: string;

  /** 该 session 的所有 prompt turn。 */
  turns: Array<{
    /** prompt turn id。 */
    turnId: string;

    /** 本轮发送给子代理的 prompt。 */
    prompt: string;

    /** 本轮状态。 */
    status: "running" | "completed" | "failed" | "cancelled";

    /** 本轮结果。 */
    result?: SubagentRunOutput;
  }>;

  /** 最终结果。 */
  result?: SubagentRunOutput;

  /** 当前部分输出。 */
  partialOutput: string;

  /** 工具调用摘要。 */
  toolCalls: ToolCallSummary[];

  /** 触碰过的文件。 */
  filesTouched: string[];

  /** 错误列表。 */
  errors: Array<{ code: string; message: string; details?: unknown }>;

  /** 本次运行日志路径。 */
  logs: RunLogPaths;

  /** 原始事件日志路径。 */
  rawEventLogPath: string;

  /** 用于取消任务的控制器。 */
  cancelController: AbortController;

  /** 当前 ACP client。 */
  client?: GenericAcpClient;

  /** 任务完成事件。 */
  completion?: Promise<SubagentRunOutput>;

  /** 当前输出详情级别。 */
  detailLevel: InteractionDetailLevel;

  /** 是否在任务完成后保留 session。 */
  keepAlive: boolean;

  /** 是否允许完成后进入会话池。 */
  allowPoolRelease: boolean;
}

/**
 * 子代理任务注册表。
 *
 * 该注册表维护 task_id 到 ActiveSubagentRun 的映射，并通过事件通知 wait/result 工具。
 */
export class TaskRegistry extends EventEmitter {
  /** 活跃或保留任务表。 */
  private readonly runs = new Map<string, ActiveSubagentRun>();

  /**
   * 创建一个新的任务对象。
   *
   * @param input 创建任务所需字段。
   * @returns 新任务对象。
   */
  create(input: {
    agentType: string;
    cwd?: string;
    mode?: string;
    parentAgentId: string;
    logs: RunLogPaths;
    detailLevel: InteractionDetailLevel;
    keepAlive: boolean;
    allowPoolRelease: boolean;
  }): ActiveSubagentRun {
    const taskId = `task_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const run: ActiveSubagentRun = {
      taskId,
      agentType: input.agentType,
      status: "created",
      createdAt: new Date(),
      lastActivityAt: new Date(),
      lastHeartbeatAt: new Date(),
      cwd: input.cwd,
      mode: input.mode,
      parentAgentId: input.parentAgentId,
      turns: [],
      partialOutput: "",
      toolCalls: [],
      filesTouched: [],
      errors: [],
      logs: input.logs,
      rawEventLogPath: input.logs.eventsPath,
      cancelController: new AbortController(),
      detailLevel: input.detailLevel,
      keepAlive: input.keepAlive,
      allowPoolRelease: input.allowPoolRelease,
    };
    this.runs.set(taskId, run);
    this.emit("updated", run);
    return run;
  }

  /**
   * 获取任务对象。
   *
   * @param taskId 任务 ID。
   * @returns 任务对象或 undefined。
   */
  get(taskId: string): ActiveSubagentRun | undefined {
    return this.runs.get(taskId);
  }

  /**
   * 列出当前注册表中的全部任务。
   *
   * @returns 任务对象快照列表。
   */
  list(): ActiveSubagentRun[] {
    return Array.from(this.runs.values());
  }

  /**
   * 获取多个任务对象。
   *
   * @param taskIds 任务 ID 列表。
   * @returns 任务对象列表。
   */
  getMany(taskIds: string[]): ActiveSubagentRun[] {
    return taskIds.map((id) => this.get(id)).filter((run): run is ActiveSubagentRun => Boolean(run));
  }

  /**
   * 更新任务状态并发出事件。
   *
   * @param run 任务对象。
   * @param status 新状态。
   */
  setStatus(run: ActiveSubagentRun, status: SubagentTaskState): void {
    run.status = status;
    if (isTerminalStatus(status)) {
      run.completedAt = new Date();
    }
    this.emit("updated", run);
    this.emit(`updated:${run.taskId}`, run);
  }

  /**
   * 标记任务产生心跳。
   *
   * @param run 任务对象。
   */
  touchHeartbeat(run: ActiveSubagentRun): void {
    run.lastHeartbeatAt = new Date();
    this.emit("updated", run);
    this.emit(`updated:${run.taskId}`, run);
  }

  /**
   * 标记任务产生有效活动。
   *
   * @param run 任务对象。
   */
  touchActivity(run: ActiveSubagentRun): void {
    run.lastActivityAt = new Date();
    this.touchHeartbeat(run);
  }

  /**
   * 删除任务对象。
   *
   * @param taskId 任务 ID。
   */
  delete(taskId: string): void {
    this.runs.delete(taskId);
  }

  /**
   * 等待任意任务更新。
   *
   * @param taskIds 任务 ID 列表。
   * @param timeoutMs 等待超时毫秒。
   * @returns 被更新的任务对象；超时时返回 undefined。
   */
  async waitForUpdate(taskIds: string[], timeoutMs: number): Promise<ActiveSubagentRun | undefined> {
    const taskIdSet = new Set(taskIds);
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.off("updated", onUpdated);
        resolve(undefined);
      }, timeoutMs);

      const onUpdated = (run: ActiveSubagentRun): void => {
        if (!taskIdSet.has(run.taskId)) {
          return;
        }
        clearTimeout(timer);
        this.off("updated", onUpdated);
        resolve(run);
      };

      this.on("updated", onUpdated);
    });
  }
}

/**
 * 判断状态是否为终态。
 *
 * @param status 任务状态。
 * @returns 是终态时返回 true。
 */
export function isTerminalStatus(status: SubagentTaskState): boolean {
  return ["completed", "failed", "timeout", "heartbeat_timeout", "cancelled", "closed"].includes(status);
}

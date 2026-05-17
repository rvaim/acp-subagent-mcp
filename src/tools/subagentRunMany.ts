import type { ActiveSubagentTask } from "../runtime/taskRegistry.js";
import { isFinishedTaskState } from "../runtime/taskRegistry.js";
import { SubagentRuntimeError, toSubagentError } from "../runtime/errors.js";
import type { SubagentRunManyInput, SubagentRunManyOutput, SubagentRunManyItem, SubagentIndexedRunOutput, SubagentRejectedItem } from "../task/types.js";
import type { SubagentTaskRunnerDependencies } from "../runtime/taskRunner.js";
import { forceCancelActiveTask, startSubagentTask } from "../runtime/taskRunner.js";
import { rejectDynamicMcpServers } from "../runtime/security.js";
import { subagentRunManyInputSchema } from "./schemas.js";

interface StartedBatchTask {
  index: number;
  active: ActiveSubagentTask;
}

/**
 * 处理 subagent_run_many：同步批量运行多个子代理。
 *
 * 子代理内部并行执行；本工具只在全部子代理完成、失败、超时或取消后返回。
 * 不再返回 pending_task_ids，也不要求主 agent 后续 wait/result。
 */
export async function handleSubagentRunMany(rawInput: unknown, deps: SubagentTaskRunnerDependencies): Promise<SubagentRunManyOutput> {
  rejectDynamicMcpServers(rawInput);
  const input = subagentRunManyInputSchema.parse(rawInput) as SubagentRunManyInput;
  return runBatchSubagents({
    tasks: input.tasks,
    conflictPolicy: input.conflict_policy,
    onTaskFailure: input.on_task_failure ?? "keep_others_running",
    deps,
    abortReason: "MCP run_many call 已取消"
  });
}

/**
 * 同步批量运行一组已经构造好的任务。revise_many 复用这里。
 */
export async function runBatchSubagents(options: {
  tasks: SubagentRunManyItem[];
  conflictPolicy?: SubagentRunManyInput["conflict_policy"];
  onTaskFailure: "keep_others_running" | "cancel_all";
  deps: SubagentTaskRunnerDependencies;
  abortReason: string;
}): Promise<SubagentRunManyOutput> {
  const startedAt = Date.now();
  const started: StartedBatchTask[] = [];
  const rejected: SubagentRejectedItem[] = [];
  const detachAbort = bindRequestAbortToStarted(started, options.deps, options.abortReason);

  try {
    for (const [index, item] of options.tasks.entries()) {
      await throwIfBatchAborted(started, options.deps, options.abortReason);
      try {
        const active = await startSubagentTask({
          input: { ...item, conflict_policy: options.conflictPolicy },
          conflictPolicy: options.conflictPolicy
        }, options.deps);
        started.push({ index, active });
      } catch (error) {
        const normalized = toSubagentError(error);
        rejected.push({ index, agent_type: item.agent_type, reason: normalized.user_message, error_code: normalized.code });
        if (options.onTaskFailure === "cancel_all") {
          await cancelStarted(started, options.deps, "批量启动阶段有任务失败，按策略取消全部");
          break;
        }
      }
    }

    await waitForAllStartedOrAbort(started, options.deps, options.abortReason);
    return buildRunManyOutput(started, rejected, Date.now() - startedAt);
  } finally {
    detachAbort();
  }
}

/**
 * 把 request cancellation 绑定到本批已经启动的任务。
 */
function bindRequestAbortToStarted(started: StartedBatchTask[], deps: SubagentTaskRunnerDependencies, reason: string): () => void {
  const signal = deps.requestSignal;
  if (!signal) return () => undefined;

  const onAbort = () => {
    void cancelStarted(started, deps, requestAbortReason(signal, reason));
  };

  if (signal.aborted) {
    onAbort();
    return () => undefined;
  }

  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

/**
 * 等待全部已启动任务完成，同时响应 request cancellation。
 */
async function waitForAllStartedOrAbort(started: StartedBatchTask[], deps: SubagentTaskRunnerDependencies, reason: string): Promise<void> {
  const waitAll = Promise.allSettled(started.map((item) => item.active.currentTurnPromise));
  const signal = deps.requestSignal;
  if (!signal) {
    await waitAll;
    return;
  }

  if (signal.aborted) {
    await cancelStarted(started, deps, requestAbortReason(signal, reason));
    throw new SubagentRuntimeError("cancelled", requestAbortReason(signal, reason), { recoverable: true });
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", abort);
    const abort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      void cancelStarted(started, deps, requestAbortReason(signal, reason)).finally(() => {
        reject(new SubagentRuntimeError("cancelled", requestAbortReason(signal, reason), { recoverable: true }));
      });
    };

    signal.addEventListener("abort", abort, { once: true });
    waitAll.then(
      () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      }
    );
  });
}

/**
 * 如果批量调用已经被取消，先强制清理已启动任务再抛出取消错误。
 */
async function throwIfBatchAborted(started: StartedBatchTask[], deps: SubagentTaskRunnerDependencies, reason: string): Promise<void> {
  const signal = deps.requestSignal;
  if (!signal?.aborted) return;
  const message = requestAbortReason(signal, reason);
  await cancelStarted(started, deps, message);
  throw new SubagentRuntimeError("cancelled", message, { recoverable: true });
}

/**
 * 取消本批已经启动且仍未结束的任务。
 */
async function cancelStarted(started: StartedBatchTask[], deps: SubagentTaskRunnerDependencies, reason: string): Promise<void> {
  await Promise.allSettled(started.map(async ({ active }) => {
    if (!isFinishedTaskState(active.status)) {
      await forceCancelActiveTask(active, deps, reason).catch(() => undefined);
    }
  }));
}

/**
 * 构造同步批量输出。
 */
function buildRunManyOutput(started: StartedBatchTask[], rejected: SubagentRejectedItem[], elapsedMs: number): SubagentRunManyOutput {
  const completed: SubagentIndexedRunOutput[] = [];
  const failed: SubagentIndexedRunOutput[] = [];
  const cancelledTaskIds: string[] = [];

  for (const item of started) {
    const result = item.active.result;
    if (!result) continue;
    const indexed = {
      ...result,
      index: item.index,
      task_id: result.task_id ?? item.active.taskId,
      title: result.title ?? item.active.task.title
    } as SubagentIndexedRunOutput;
    if (indexed.status === "completed" || indexed.status === "partial") completed.push(indexed);
    else failed.push(indexed);
    if (indexed.status === "cancelled") cancelledTaskIds.push(indexed.task_id);
  }

  const total = started.length + rejected.length;
  const allFailed = total > 0 && completed.length === 0 && (failed.length + rejected.length) === total;
  const status = cancelledTaskIds.length > 0 && completed.length === 0
    ? "cancelled"
    : failed.length > 0 || rejected.length > 0
      ? allFailed ? "failed" : "partial"
      : "completed";

  return {
    schema_version: 1,
    status,
    completed,
    failed,
    rejected,
    cancelled_task_ids: cancelledTaskIds,
    elapsed_ms: elapsedMs,
    summary: `同步批量完成：成功 ${completed.length} 个，失败 ${failed.length} 个，启动拒绝 ${rejected.length} 个，取消 ${cancelledTaskIds.length} 个。`
  };
}

function requestAbortReason(signal: AbortSignal, fallbackReason: string): string {
  const reason = signal.reason;
  if (reason instanceof Error && reason.message) return reason.message;
  if (typeof reason === "string" && reason.length > 0) return reason;
  return fallbackReason;
}

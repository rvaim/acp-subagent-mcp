import type { SubagentWaitInput, SubagentWaitOutput } from "../task/types.js";
import type { SubagentTaskRunnerDependencies } from "../runtime/taskRunner.js";
import { forceCancelActiveTask } from "../runtime/taskRunner.js";
import { SubagentRuntimeError } from "../runtime/errors.js";
import { isFinishedTaskState } from "../runtime/taskRegistry.js";
import { subagentWaitInputSchema } from "./schemas.js";

/**
 * 处理 subagent_wait：按策略等待任务进入指定条件。
 */
export async function handleSubagentWait(rawInput: unknown, deps: SubagentTaskRunnerDependencies): Promise<SubagentWaitOutput> {
  const input = subagentWaitInputSchema.parse(rawInput) as SubagentWaitInput;
  const startedAt = Date.now();
  const timeoutMs = (input.timeout_secs ?? 30) * 1000;
  const initialSeq = new Map(input.task_ids.map((taskId) => [taskId, deps.registry.get(taskId)?.updateSeq ?? -1]));

  for (const taskId of input.task_ids) {
    if (!deps.registry.get(taskId)) throw new SubagentRuntimeError("invalid_input", `任务不存在：${taskId}`);
  }

  throwIfAbortedAndCancel(input, deps);

  while (true) {
    const snapshot = input.task_ids.map((taskId) => deps.registry.get(taskId)!);
    const conditionMet = isWaitConditionMet(input.return_when, snapshot, initialSeq);
    const elapsed = Date.now() - startedAt;
    if (conditionMet || elapsed >= timeoutMs) {
      if (!conditionMet && input.on_timeout === "cancel_pending") {
        for (const task of snapshot) {
          if (!isFinishedTaskState(task.status)) await forceCancelActiveTask(task, deps, "subagent_wait timeout").catch(() => undefined);
        }
      }
      return buildWaitOutput(input, deps, Date.now() - startedAt, !conditionMet && elapsed >= timeoutMs);
    }

    await waitForChangeOrAbort(input, deps, Math.min(1000, timeoutMs - elapsed));
  }
}

/**
 * 等待任务变化，同时响应 MCP request cancellation。
 *
 * Host 手动停止当前 wait 调用时，默认视为“用户不再需要这些子代理继续运行”，
 * 因此会取消本次 wait 覆盖的仍在运行任务，避免后台继续占用资源。
 */
async function waitForChangeOrAbort(input: SubagentWaitInput, deps: SubagentTaskRunnerDependencies, timeoutMs: number): Promise<void> {
  const signal = deps.requestSignal;
  if (!signal) {
    await deps.registry.waitForChange(timeoutMs);
    return;
  }

  throwIfAbortedAndCancel(input, deps);

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", abort);
    const abort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      void cancelWaitTasks(input, deps, "MCP wait call 已取消").finally(() => {
        reject(new SubagentRuntimeError("cancelled", "MCP wait call 已取消", { recoverable: true }));
      });
    };

    signal.addEventListener("abort", abort, { once: true });
    deps.registry.waitForChange(timeoutMs).then(
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
 * 若 wait 调用进入时已经被取消，立即取消关联任务并抛出错误。
 */
function throwIfAbortedAndCancel(input: SubagentWaitInput, deps: SubagentTaskRunnerDependencies): void {
  const signal = deps.requestSignal;
  if (!signal?.aborted) return;
  void cancelWaitTasks(input, deps, "MCP wait call 已取消");
  throw new SubagentRuntimeError("cancelled", "MCP wait call 已取消", { recoverable: true });
}

/**
 * 取消本次 wait 关注的仍在运行任务。
 */
async function cancelWaitTasks(input: SubagentWaitInput, deps: SubagentTaskRunnerDependencies, reason: string): Promise<void> {
  await Promise.allSettled(input.task_ids.map(async (taskId) => {
    const task = deps.registry.get(taskId);
    if (task && !isFinishedTaskState(task.status)) await forceCancelActiveTask(task, deps, reason).catch(() => undefined);
  }));
}

/**
 * 判断等待条件是否满足。
 */
function isWaitConditionMet(returnWhen: SubagentWaitInput["return_when"], tasks: ReturnType<SubagentTaskRunnerDependencies["registry"]["list"]>, initialSeq: Map<string, number>): boolean {
  const finished = tasks.filter((task) => isFinishedTaskState(task.status));
  const success = tasks.filter((task) => task.status === "completed" || task.status === "partial");
  const failure = tasks.filter((task) => task.status === "failed" || task.status === "timeout" || task.status === "cancelled");

  if (returnWhen === "all_completed") return finished.length === tasks.length;
  if (returnWhen === "first_completed") return finished.length > 0;
  if (returnWhen === "first_success") return success.length > 0;
  if (returnWhen === "first_failure") return failure.length > 0;
  if (returnWhen === "timeout_partial") return finished.length === tasks.length;
  if (returnWhen === "any_update") {
    return tasks.some((task) => task.updateSeq !== (initialSeq.get(task.taskId) ?? -1));
  }

  return false;
}

/**
 * 构造 wait 输出。
 */
function buildWaitOutput(input: SubagentWaitInput, deps: SubagentTaskRunnerDependencies, elapsedMs: number, timedOut: boolean): SubagentWaitOutput {
  const tasks = input.task_ids.map((taskId) => deps.registry.get(taskId)!).filter(Boolean);
  const completed = tasks
    .filter((task) => (task.status === "completed" || task.status === "partial") && task.result)
    .map((task) => ({ ...task.result!, task_id: task.taskId }));
  const failed = tasks
    .filter((task) => ["failed", "timeout", "cancelled"].includes(task.status) && task.result)
    .map((task) => ({ ...task.result!, task_id: task.taskId }));
  const pending_task_ids = tasks.filter((task) => !isFinishedTaskState(task.status)).map((task) => task.taskId);
  const cancelled_task_ids = tasks.filter((task) => task.status === "cancelled").map((task) => task.taskId);
  const status = pending_task_ids.length === 0 ? "completed" : timedOut ? "timeout" : "partial";

  return {
    schema_version: 1,
    status,
    completed,
    failed,
    pending_task_ids,
    cancelled_task_ids,
    elapsed_ms: elapsedMs,
    summary: `完成 ${completed.length} 个，失败 ${failed.length} 个，仍在运行 ${pending_task_ids.length} 个。`
  };
}

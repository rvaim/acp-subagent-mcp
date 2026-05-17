import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config/types.js";
import type { GenericAcpClient } from "../acp/AcpClient.js";
import { GenericAcpClient as GenericAcpClientClass } from "../acp/AcpClient.js";
import { renderSubagentPrompt, renderSubagentRevisionPrompt } from "../task/renderSubagentPrompt.js";
import { buildRunOutput, deriveRunStatus, parseSubagentResult } from "../task/parseSubagentResult.js";
import { normalizeOutputOptions } from "../task/outputOptions.js";
import { buildSkillPromptContext, type SkillPromptContext } from "../skills/skillBridge.js";
import type {
  ConflictPolicy,
  ResolvedTaskFile,
  SubagentOutputOptions,
  SubagentReviseInput,
  SubagentRunInput,
  SubagentRunOutput,
  SubagentRunStatus,
  SubagentStructuredResult,
  TaskFile
} from "../task/types.js";
import { buildAgentEnv, spawnAgentProcess } from "./processManager.js";
import type { ConcurrencyManager } from "./concurrency.js";
import { createRunLogger, type RunLogger } from "./logs.js";
import { resolveEffectivePermissions, resolveMcpServerProfiles } from "./permissions.js";
import { RunTimeoutController } from "./timeouts.js";
import { SubagentRuntimeError, makeSubagentError, toSubagentError } from "./errors.js";
import {
  assertDepthAllowed,
  assertKnownAgent,
  assertPromptSize,
  resolveSafeCwd,
  resolveTaskFiles,
  taskRequiresWrite,
  toDisplayRelativePath
} from "./security.js";
import { finalizeWorktree, prepareExecutionWorkspace } from "./worktree.js";
import { isTerminalTaskState, type ActiveSubagentTask, type SubagentTurnRecord, type TaskRegistry } from "./taskRegistry.js";

/**
 * 子代理任务启动依赖。
 */
export interface SubagentTaskRunnerDependencies {
  /** 应用配置。 */
  config: AppConfig;
  /** 并发控制器。 */
  concurrency: ConcurrencyManager;
  /** 任务注册表。 */
  registry: TaskRegistry;
  /**
   * 当前 MCP tool call 的取消信号。
   *
   * MCP Host 手动停止当前同步 tool call 时，SDK 会 abort 该信号。运行中的
   * run/run_many/revise/revise_many 会把它级联到 ACP session/cancel 和子进程树清理。
   */
  requestSignal?: AbortSignal;
}

/**
 * 启动任务的内部选项。
 */
export interface StartTaskOptions {
  /** 子代理运行输入。 */
  input: SubagentRunInput;
  /** 可选指定 task id。 */
  taskId?: string;
  /** 本次启动使用的冲突策略。 */
  conflictPolicy?: ConflictPolicy;
  /** 打回重写上下文；存在时使用 revision prompt。 */
  revision?: {
    previousResult: string;
    message?: string;
    correction: NonNullable<SubagentReviseInput["correction"]>;
  };
}

/**
 * 启动一个子代理任务，并让第一轮 prompt 在后台运行。
 *
 * 这是内部函数；外部 MCP 接口不会拿到“后台运行中的 task”。同步工具会立即等待
 * currentTurnPromise 结束或 requestSignal 取消。
 */
export async function startSubagentTask(options: StartTaskOptions, deps: SubagentTaskRunnerDependencies): Promise<ActiveSubagentTask> {
  const input = options.input;
  const agentType = input.agent_type || deps.config.defaults.default_agent;
  const normalizedInput: SubagentRunInput = { ...input, agent_type: agentType };
  assertKnownAgent(deps.config, agentType);
  const currentDepth = assertDepthAllowed(deps.config.defaults.max_depth);
  throwIfRequestAborted(deps);

  const taskId = options.taskId ?? `task_${randomUUID().slice(0, 12)}`;
  const agent = deps.config.agents[agentType];
  const originalCwd = await resolveSafeCwd(normalizedInput.cwd, deps.config.security);
  const isWriter = taskRequiresWrite(normalizedInput);
  const conflictPolicy = options.conflictPolicy ?? normalizedInput.conflict_policy ?? deps.config.concurrency.default_conflict_policy;
  const releaseConcurrency = deps.concurrency.acquire({ config: deps.config, cwd: originalCwd, isWriter, conflictPolicy });

  let logger: RunLogger | undefined;
  let client: GenericAcpClient | undefined;
  let detachRequestAbort: (() => void) | undefined;

  try {
    const workspace = await prepareExecutionWorkspace({
      config: deps.config,
      cwd: originalCwd,
      taskId,
      isWriter,
      conflictPolicy
    });
    const executionCwd = workspace.executionCwd;
    const files = await resolveTaskFiles({
      cwd: executionCwd,
      files: normalizedInput.task.files,
      maxInlineChars: deps.config.defaults.max_inline_file_chars
    });

    logger = await createRunLogger({ cwd: originalCwd, logDir: deps.config.defaults.log_dir, taskId, config: deps.config.logs });
    await logger.writeJson("task.json", {
      ...normalizedInput,
      task_id: taskId,
      execution_cwd: executionCwd,
      conflict_policy: conflictPolicy,
      revision: options.revision ? { correction: options.revision.correction, message: options.revision.message } : undefined
    });

    const outputOptions = normalizeOutputOptions(input.output);
    const permissions = resolveEffectivePermissions(deps.config, normalizedInput);
    const skillContext = await buildSkillPromptContext({ config: deps.config, cwd: originalCwd, input: normalizedInput.skills });
    const rendered = options.revision
      ? renderSubagentRevisionPrompt({
        mode: normalizedInput.mode ?? "custom",
        task: normalizedInput.task,
        previousResult: options.revision.previousResult,
        message: options.revision.message,
        correction: options.revision.correction,
        files,
        systemPrompt: agent.system_prompt,
        permissions,
        output: outputOptions,
        skills: skillContext
      })
      : renderSubagentPrompt({
        mode: normalizedInput.mode ?? "analyze",
        task: normalizedInput.task,
        files,
        systemPrompt: agent.system_prompt,
        permissions,
        output: outputOptions,
        skills: skillContext
      });
    assertPromptSize(rendered.text, deps.config.defaults.max_prompt_chars);
    await logger.writePrompt(rendered.text);

    const active: ActiveSubagentTask = {
      taskId,
      agentType,
      agent,
      cwd: originalCwd,
      executionCwd,
      mode: normalizedInput.mode ?? "analyze",
      status: "starting",
      isWriter,
      conflictPolicy,
      createdAt: new Date(),
      startedAt: new Date(),
      lastActivityAt: new Date(),
      logger,
      worktree: workspace.worktree,
      turns: [],
      task: normalizedInput.task,
      outputOptions,
      partialOutput: "",
      toolCalls: [],
      filesTouched: [],
      errors: [],
      releaseConcurrency,
      cleanedUp: false,
      updateSeq: 0
    };
    deps.registry.add(active);
    detachRequestAbort = bindRequestAbortToTask(active, deps, "MCP tool call 已取消，正在停止子代理");

    const env = buildAgentEnv(agent, currentDepth, executionCwd);
    env.ACP_SUBAGENT_TASK_ID = taskId;
    const processEnvMarker = { key: "ACP_SUBAGENT_TASK_ID", value: taskId };
    const spawned = spawnAgentProcess({
      config: deps.config,
      agent,
      cwd: executionCwd,
      env,
      onStderr: (chunk) => void logger?.appendStderr(chunk)
    });

    client = new GenericAcpClientClass({
      child: spawned.child,
      cwd: executionCwd,
      permissions,
      logger,
      onActivity: () => {
        active.lastActivityAt = new Date();
        if (active.timeoutController && active.currentInactivityTimeoutMs) {
          active.timeoutController.markActivity(active.currentInactivityTimeoutMs);
        }
        active.partialOutput = active.client?.getPartialText() ?? active.partialOutput;
        active.toolCalls = active.client?.getToolCalls() ?? active.toolCalls;
        active.filesTouched = active.client?.getFilesTouched() ?? active.filesTouched;
        deps.registry.notify(active.taskId);
      },
      maxReadFileBytes: deps.config.security.max_read_file_bytes,
      acpCancelGraceMs: deps.config.defaults.acp_cancel_grace_ms,
      processKillGraceMs: deps.config.defaults.process_kill_grace_ms,
      processEnvMarker
    });
    active.client = client;

    await raceWithRequestAbort(client.initialize(), deps, async () => {
      await client?.shutdown().catch(() => undefined);
    });
    const mcpServers = resolveMcpServerProfiles(deps.config, agentType, normalizedInput.mcp_server_profiles);
    const session = await raceWithRequestAbort(client.newSession({ cwd: executionCwd, mcpServers }), deps, async () => {
      await client?.shutdown().catch(() => undefined);
    });
    active.sessionId = session.sessionId;

    launchPromptTurn({
      active,
      deps,
      promptText: rendered.text,
      timeoutSecs: normalizedInput.timeout_secs,
      inactivityTimeoutSecs: normalizedInput.inactivity_timeout_secs,
      outputOptions,
      skillContext,
      revisionOfTaskId: extractRevisionOfTaskId(input.task)
    });

    detachRequestAbort?.();
    detachRequestAbort = undefined;
    return active;
  } catch (error) {
    detachRequestAbort?.();
    releaseConcurrency();
    await client?.shutdown().catch(() => undefined);
    await logger?.writeJson("result.json", failureOutputFromError(agentType, error, Date.now(), undefined, logger, originalCwd)).catch(() => undefined);
    throw error;
  }
}

/**
 * 同步运行一个子代理任务，等待第一轮结束后返回结果。
 */
export async function runSubagentTask(input: SubagentRunInput, deps: SubagentTaskRunnerDependencies): Promise<SubagentRunOutput> {
  const active = await startSubagentTask({ input, conflictPolicy: input.conflict_policy }, deps);
  const detachRequestAbort = bindRequestAbortToTask(active, deps, "MCP tool call 已取消，正在停止子代理");
  try {
    await active.currentTurnPromise;
    if (!active.result) {
      throw new SubagentRuntimeError("internal_error", "子代理任务结束但没有生成结果");
    }
    return active.result;
  } finally {
    detachRequestAbort();
  }
}

/**
 * 同步打回重写。不会复用上一轮子代理进程；只复用任务元数据和上一轮结果文本。
 */
export async function reviseSubagentTask(input: SubagentReviseInput, deps: SubagentTaskRunnerDependencies): Promise<SubagentRunOutput> {
  const source = input.task_id ? deps.registry.get(input.task_id) : undefined;
  if (input.task_id && !source && !input.task) {
    throw new SubagentRuntimeError("invalid_input", `任务不存在或 MCP Server 已重启，请同时传入 task 和 previous_result：${input.task_id}`);
  }

  const baseTask = input.task ?? source?.task;
  if (!baseTask) {
    throw new SubagentRuntimeError("invalid_input", "subagent_revise 需要 task_id，或显式传入 task");
  }

  const previousResult = input.previous_result ?? resultTextFromSource(source);
  if (!previousResult?.trim()) {
    throw new SubagentRuntimeError("invalid_input", "subagent_revise 需要 previous_result，或 task_id 必须指向已有完成结果");
  }

  const revisionOfTaskId = input.task_id ?? source?.taskId;
  const revisionTask = buildRevisionTask(baseTask, input, previousResult, revisionOfTaskId);
  const runInput: SubagentRunInput = {
    agent_type: input.agent_type ?? source?.agentType,
    task: revisionTask,
    cwd: input.cwd ?? source?.cwd,
    timeout_secs: input.timeout_secs,
    inactivity_timeout_secs: input.inactivity_timeout_secs,
    mode: input.mode ?? "custom",
    mcp_server_profiles: input.mcp_server_profiles,
    skills: input.skills,
    output: input.output ?? source?.outputOptions,
    conflict_policy: input.conflict_policy
  };

  const active = await startSubagentTask({
    input: runInput,
    conflictPolicy: input.conflict_policy,
    revision: {
      previousResult,
      message: input.message,
      correction: input.correction
    }
  }, deps);
  const detachRequestAbort = bindRequestAbortToTask(active, deps, "MCP revise call 已取消，正在停止子代理");
  try {
    await active.currentTurnPromise;
    if (!active.result) {
      throw new SubagentRuntimeError("internal_error", "子代理重写任务结束但没有生成结果");
    }
    active.result.revision_of_task_id = revisionOfTaskId;
    return active.result;
  } finally {
    detachRequestAbort();
  }
}

/**
 * 取消一个任务并立刻清理本地进程树。
 */
export async function forceCancelActiveTask(active: ActiveSubagentTask, deps: SubagentTaskRunnerDependencies, reason?: string): Promise<"cancelled" | "already_terminal"> {
  if (isTerminalTaskState(active.status) && active.cleanedUp) return "already_terminal";

  if (!isTerminalTaskState(active.status)) {
    active.status = "cancelling";
    active.errors.push(makeSubagentError("cancelled", reason ? `任务已取消：${reason}` : "任务已取消", { recoverable: true }));
    await active.logger?.appendEvent({ type: "force_cancel", reason: reason ?? "cancelled" }).catch(() => undefined);
    active.timeoutController?.abort("cancelled");
    if (active.client && active.sessionId) {
      void active.client.cancel(active.sessionId).catch(() => undefined);
    }
  }

  await cleanupActiveTask(active, deps);

  if (!isTerminalTaskState(active.status)) {
    active.status = "cancelled";
    active.completedAt = active.completedAt ?? new Date();
  }
  deps.registry.notify(active.taskId);
  return "cancelled";
}

/**
 * 关闭所有活跃任务。
 *
 * 用于 MCP transport 断开、进程收到退出信号或测试主动清理。
 */
export async function shutdownAllActiveTasks(deps: SubagentTaskRunnerDependencies, reason: string): Promise<void> {
  const tasks = deps.registry.list();
  await Promise.allSettled(tasks.map(async (task) => {
    try {
      if (!isTerminalTaskState(task.status)) {
        await forceCancelActiveTask(task, deps, reason);
      } else {
        await cleanupActiveTask(task, deps);
      }
    } catch {
      task.errors.push(makeSubagentError("cancelled", reason, { recoverable: true }));
      await cleanupActiveTask(task, deps).catch(() => undefined);
    }
  }));
}

/**
 * 若当前 MCP 请求已经被取消，则立即抛出可恢复的取消错误。
 */
function throwIfRequestAborted(deps: SubagentTaskRunnerDependencies): void {
  if (deps.requestSignal?.aborted) {
    throw makeRequestCancelledError(deps.requestSignal, "MCP tool call 已取消");
  }
}

/**
 * 将 MCP 请求取消信号绑定到指定任务。
 */
function bindRequestAbortToTask(active: ActiveSubagentTask, deps: SubagentTaskRunnerDependencies, fallbackReason: string): () => void {
  const signal = deps.requestSignal;
  if (!signal) return () => undefined;

  const onAbort = () => {
    const reason = requestAbortReason(signal, fallbackReason);
    void forceCancelActiveTask(active, deps, reason).catch(async () => {
      await cleanupActiveTask(active, deps).catch(() => undefined);
    });
  };

  if (signal.aborted) {
    onAbort();
    return () => undefined;
  }

  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

/**
 * 将初始化、创建 session 等启动阶段 Promise 与 MCP 请求取消信号竞争。
 */
async function raceWithRequestAbort<T>(promise: Promise<T>, deps: SubagentTaskRunnerDependencies, onAbort: () => Promise<void>): Promise<T> {
  const signal = deps.requestSignal;
  if (!signal) return promise;
  if (signal.aborted) {
    await onAbort();
    throw makeRequestCancelledError(signal, "MCP tool call 已取消");
  }

  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", abort);
    const abort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      promise.catch(() => undefined);
      void onAbort().finally(() => reject(makeRequestCancelledError(signal, "MCP tool call 已取消")));
    };

    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
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
 * 构造 MCP 请求取消错误。
 */
function makeRequestCancelledError(signal: AbortSignal, fallbackReason: string): SubagentRuntimeError {
  return new SubagentRuntimeError("cancelled", requestAbortReason(signal, fallbackReason), { recoverable: true });
}

/**
 * 从 AbortSignal 中提取适合写入日志的取消原因。
 */
function requestAbortReason(signal: AbortSignal, fallbackReason: string): string {
  const reason = signal.reason;
  if (reason instanceof Error && reason.message) return reason.message;
  if (typeof reason === "string" && reason.length > 0) return reason;
  return fallbackReason;
}

/**
 * 启动并记录一轮 prompt。返回 turn id。
 */
function launchPromptTurn(options: {
  active: ActiveSubagentTask;
  deps: SubagentTaskRunnerDependencies;
  promptText: string;
  timeoutSecs?: number;
  inactivityTimeoutSecs?: number;
  outputOptions: Required<SubagentOutputOptions>;
  skillContext?: SkillPromptContext;
  revisionOfTaskId?: string;
}): string {
  const { active, deps } = options;
  if (!active.client || !active.sessionId) {
    throw new SubagentRuntimeError("internal_error", "ACP client 或 session 尚未初始化");
  }

  const turnId = `turn_${randomUUID().slice(0, 12)}`;
  const turn: SubagentTurnRecord = {
    turnId,
    createdAt: new Date(),
    promptPreview: options.promptText.slice(0, 500),
    status: "running"
  };
  active.turns.push(turn);
  active.currentTurnId = turnId;
  active.status = "running";
  active.partialOutput = "";
  active.toolCalls = [];
  active.filesTouched = [];
  active.lastActivityAt = new Date();

  const startedAt = Date.now();
  const timeoutMs = (options.timeoutSecs ?? deps.config.defaults.timeout_secs) * 1000;
  const inactivityMs = (options.inactivityTimeoutSecs ?? deps.config.defaults.inactivity_timeout_secs) * 1000;
  const timeoutController = new RunTimeoutController({ timeoutMs, inactivityTimeoutMs: inactivityMs });
  active.timeoutController = timeoutController;
  active.currentInactivityTimeoutMs = inactivityMs;

  active.currentTurnPromise = (async () => {
    let finalStatus: SubagentRunStatus = "failed";
    try {
      const acpPrompt = await active.client!.prompt({
        sessionId: active.sessionId!,
        content: [{ type: "text", text: options.promptText }],
        signal: timeoutController.controller.signal
      });
      active.partialOutput = acpPrompt.text;
      active.toolCalls = acpPrompt.toolCalls;
      active.filesTouched = acpPrompt.filesTouched;
      const structured = parseSubagentResult(acpPrompt.text);
      finalStatus = deriveRunStatus(acpPrompt.stopReason, structured);
      const worktree = await finalizeWorktree({ config: deps.config, worktree: active.worktree, status: finalStatus });
      const output = addTaskMetadata(active, buildRunOutput({
        status: finalStatus,
        agentType: active.agentType,
        sessionId: active.sessionId,
        stopReason: acpPrompt.stopReason,
        structured,
        elapsedMs: Date.now() - startedAt,
        artifacts: buildArtifacts(active.cwd, active.logger, worktree),
        toolCalls: acpPrompt.toolCalls,
        filesTouched: acpPrompt.filesTouched,
        outputOptions: options.outputOptions,
        skillContext: options.skillContext
      }), options.revisionOfTaskId);
      active.result = output;
      active.status = finalStatus;
      turn.status = mapRunStatusToTurnStatus(finalStatus);
      turn.result = output;
      await active.logger?.writeJson("result.json", output);
    } catch (error) {
      const reason = timeoutController.reason;
      finalStatus = timeoutReasonToStatus(reason);
      if (reason && active.client && active.sessionId) {
        await active.client.cancel(active.sessionId).catch(() => undefined);
      }
      const subagentError = toSubagentError(error, reason === "inactivity_timeout" ? "inactivity_timeout" : reason === "cancelled" ? "cancelled" : "internal_error");
      const structured: SubagentStructuredResult = {
        status: finalStatus === "partial" || finalStatus === "completed" ? finalStatus : "failed",
        summary: subagentError.user_message,
        result: subagentError.user_message,
        errors: [subagentError]
      };
      const worktree = await finalizeWorktree({ config: deps.config, worktree: active.worktree, status: finalStatus }).catch(() => active.worktree);
      const output = addTaskMetadata(active, buildRunOutput({
        status: finalStatus,
        agentType: active.agentType,
        sessionId: active.sessionId,
        structured,
        elapsedMs: Date.now() - startedAt,
        artifacts: buildArtifacts(active.cwd, active.logger, worktree),
        toolCalls: active.toolCalls,
        filesTouched: active.filesTouched,
        outputOptions: options.outputOptions,
        skillContext: options.skillContext,
        extraErrors: active.errors
      }), options.revisionOfTaskId);
      active.result = output;
      active.status = finalStatus;
      active.errors.push(subagentError);
      turn.status = mapRunStatusToTurnStatus(finalStatus);
      turn.result = output;
      await active.logger?.writeJson("result.json", output).catch(() => undefined);
    } finally {
      timeoutController.dispose();
      active.timeoutController = undefined;
      active.currentInactivityTimeoutMs = undefined;
      active.completedAt = new Date();
      active.currentTurnId = undefined;
      deps.registry.notify(active.taskId);
      await cleanupActiveTask(active, deps);
    }
  })();

  deps.registry.notify(active.taskId);
  return turnId;
}

/**
 * 清理子进程和并发锁。完成后只保留 registry 中的元数据和日志路径。
 */
async function cleanupActiveTask(active: ActiveSubagentTask, deps: SubagentTaskRunnerDependencies): Promise<void> {
  if (active.cleanupPromise) {
    await active.cleanupPromise;
    return;
  }

  active.cleanupPromise = (async () => {
    await active.client?.shutdown().catch(() => undefined);
    active.client = undefined;
    active.releaseConcurrency?.();
    active.cleanedUp = true;
    deps.registry.notify(active.taskId);
  })();

  await active.cleanupPromise;
}

/**
 * 转换超时原因到任务状态。
 */
function timeoutReasonToStatus(reason: string | undefined): SubagentRunStatus {
  if (reason === "timeout" || reason === "inactivity_timeout") return "timeout";
  if (reason === "cancelled") return "cancelled";
  return "failed";
}

/**
 * 转换任务状态到 turn 状态。
 */
function mapRunStatusToTurnStatus(status: SubagentRunStatus): SubagentTurnRecord["status"] {
  if (status === "completed" || status === "partial") return "completed";
  if (status === "timeout") return "timeout";
  if (status === "cancelled") return "cancelled";
  return "failed";
}

/**
 * 给输出补充 task 元数据。
 */
function addTaskMetadata(active: ActiveSubagentTask, output: SubagentRunOutput, revisionOfTaskId?: string): SubagentRunOutput {
  return {
    ...output,
    task_id: active.taskId,
    title: active.task.title,
    revision_of_task_id: revisionOfTaskId ?? output.revision_of_task_id
  };
}


/**
 * 从任务上下文中提取“打回重写”的来源任务 id。
 */
function extractRevisionOfTaskId(task: SubagentRunInput["task"]): string | undefined {
  return task.parent_context?.previous_findings
    ?.find((item) => item.startsWith("revision_of_task_id="))
    ?.slice("revision_of_task_id=".length);
}

/**
 * 从已有任务结果中提取打回文本。
 */
function resultTextFromSource(source: ActiveSubagentTask | undefined): string | undefined {
  const result = source?.result;
  if (!result) return undefined;
  const payload = {
    summary: result.summary,
    result: result.result,
    findings: result.findings,
    files_changed: result.files_changed,
    risks: result.risks,
    next_steps: result.next_steps,
    errors: result.errors
  };
  return JSON.stringify(payload, null, 2);
}

/**
 * 构造重写任务。重写 prompt 会显式注入上一轮结果和纠正说明。
 */
function buildRevisionTask(baseTask: NonNullable<SubagentReviseInput["task"]>, input: SubagentReviseInput, previousResult: string, revisionOfTaskId?: string): NonNullable<SubagentRunInput["task"]> {
  const correction = input.correction;
  const files = mergeTaskFiles(baseTask.files, input.additional_files);
  const previousFindings = [...(baseTask.parent_context?.previous_findings ?? [])];
  if (revisionOfTaskId) previousFindings.push(`revision_of_task_id=${revisionOfTaskId}`);

  return {
    ...baseTask,
    title: `重写：${baseTask.title}`,
    background: [
      baseTask.background,
      "上一轮结果被主代理审核后打回，需要重新产出完整结果。",
      `上一轮结果摘要：${truncateForPrompt(previousResult, 20000)}`,
      `打回原因：${correction.reason}`,
      correction.rejected_result ? `被拒绝结果摘要：${correction.rejected_result}` : undefined,
      correction.expected_change ? `期望修正：${correction.expected_change}` : undefined,
      input.message ? `额外重写指令：${input.message}` : undefined
    ].filter(Boolean).join("\n\n"),
    instructions: [
      ...(baseTask.instructions ?? []),
      "这是一次主代理审核后的打回重写。请重新产出完整结果，不要只给差异说明。",
      "必须修正打回原因中指出的问题；无法满足时在 risks 或 errors 中说明。"
    ],
    files,
    parent_context: {
      ...baseTask.parent_context,
      previous_findings: previousFindings
    }
  };
}

/**
 * 合并原始文件列表和重写新增文件，后者同 path 覆盖前者。
 */
function mergeTaskFiles(baseFiles?: TaskFile[], extraFiles?: TaskFile[]): TaskFile[] | undefined {
  if (!baseFiles?.length && !extraFiles?.length) return undefined;
  const byPath = new Map<string, TaskFile>();
  for (const file of baseFiles ?? []) byPath.set(file.path, file);
  for (const file of extraFiles ?? []) byPath.set(file.path, file);
  return Array.from(byPath.values());
}

/**
 * 避免把上一轮超长结果直接塞爆 prompt。
 */
function truncateForPrompt(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n[TRUNCATED]` : text;
}

/**
 * 构造 artifact 展示路径。
 */
function buildArtifacts(cwd: string, logger?: RunLogger, worktree?: { patchPath?: string; worktreeRoot?: string; patchTruncated?: boolean }): SubagentRunOutput["artifacts"] & Record<string, unknown> | undefined {
  if (!logger) return undefined;
  const artifacts: SubagentRunOutput["artifacts"] & Record<string, unknown> = {
    run_dir: displayPath(cwd, logger.paths.runDir),
    event_log: displayPath(cwd, logger.paths.eventsJsonl),
    stderr_log: displayPath(cwd, logger.paths.stderrLog),
    result_json: displayPath(cwd, logger.paths.resultJson)
  };
  if (worktree?.patchPath) {
    artifacts.patch_file = displayPath(cwd, worktree.patchPath);
    artifacts.worktree_dir = worktree.worktreeRoot ? displayPath(cwd, worktree.worktreeRoot) : undefined;
    artifacts.patch_truncated = worktree.patchTruncated;
  }
  return artifacts;
}

/**
 * 尽量返回相对 cwd 的短路径，减少 token。
 */
function displayPath(cwd: string, filePath: string): string {
  const relative = toDisplayRelativePath(cwd, path.resolve(filePath));
  return relative.startsWith("..") ? filePath : relative;
}

/**
 * setup 阶段失败时构造一个失败输出，便于写入 result.json。
 */
function failureOutputFromError(agentType: string, error: unknown, startedAt: number, sessionId: string | undefined, logger: RunLogger | undefined, cwd: string): SubagentRunOutput {
  const subagentError = toSubagentError(error);
  return buildRunOutput({
    status: "failed",
    agentType,
    sessionId,
    structured: {
      status: "failed",
      summary: subagentError.user_message,
      result: subagentError.user_message,
      errors: [subagentError]
    },
    elapsedMs: Date.now() - startedAt,
    artifacts: buildArtifacts(cwd, logger),
    toolCalls: [],
    filesTouched: [],
    outputOptions: normalizeOutputOptions({ mode: "compact" })
  });
}

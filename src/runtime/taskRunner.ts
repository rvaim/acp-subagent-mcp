import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config/types.js";
import type { GenericAcpClient } from "../acp/AcpClient.js";
import { GenericAcpClient as GenericAcpClientClass } from "../acp/AcpClient.js";
import { renderSubagentContinuePrompt, renderSubagentPrompt } from "../task/renderSubagentPrompt.js";
import { buildRunOutput, deriveRunStatus, parseSubagentResult } from "../task/parseSubagentResult.js";
import { normalizeOutputOptions } from "../task/outputOptions.js";
import { buildSkillPromptContext, type SkillPromptContext } from "../skills/skillBridge.js";
import type {
  ConflictPolicy,
  ResolvedTaskFile,
  SubagentContinueInput,
  SubagentContinueOutput,
  SubagentOutputOptions,
  SubagentRunInput,
  SubagentRunOutput,
  SubagentRunStatus,
  SubagentStartInput,
  SubagentStartOutput,
  SubagentStructuredResult
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
import { isFinishedTaskState, isTerminalTaskState, type ActiveSubagentTask, type SubagentTurnRecord, type TaskRegistry } from "./taskRegistry.js";

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
}

/**
 * 启动任务的内部选项。
 */
export interface StartTaskOptions {
  /** 子代理运行输入。 */
  input: SubagentStartInput;
  /** 是否保留 session。 */
  keepAlive: boolean;
  /** 可选指定 task id。 */
  taskId?: string;
  /** 本次启动使用的冲突策略。 */
  conflictPolicy?: ConflictPolicy;
}

/**
 * 启动一个子代理任务，并让第一轮 prompt 在后台运行。
 */
export async function startSubagentTask(options: StartTaskOptions, deps: SubagentTaskRunnerDependencies): Promise<ActiveSubagentTask> {
  const input = options.input;
  const agentType = input.agent_type || deps.config.defaults.default_agent;
  const normalizedInput: SubagentStartInput = { ...input, agent_type: agentType };
  assertKnownAgent(deps.config, agentType);
  const currentDepth = assertDepthAllowed(deps.config.defaults.max_depth);

  const taskId = options.taskId ?? `task_${randomUUID().slice(0, 12)}`;
  const agent = deps.config.agents[agentType];
  const originalCwd = await resolveSafeCwd(normalizedInput.cwd, deps.config.security.allowed_cwd_roots);
  const isWriter = taskRequiresWrite(normalizedInput);
  const conflictPolicy = options.conflictPolicy ?? normalizedInput.conflict_policy ?? deps.config.concurrency.default_conflict_policy;
  const releaseConcurrency = deps.concurrency.acquire({ config: deps.config, cwd: originalCwd, isWriter, conflictPolicy });

  let logger: RunLogger | undefined;
  let client: GenericAcpClient | undefined;

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
    await logger.writeJson("task.json", { ...normalizedInput, task_id: taskId, execution_cwd: executionCwd, conflict_policy: conflictPolicy });

    const outputOptions = normalizeOutputOptions(input.output);
    const permissions = resolveEffectivePermissions(deps.config, normalizedInput);
    const skillContext = await buildSkillPromptContext({ config: deps.config, cwd: originalCwd, input: normalizedInput.skills });
    const rendered = renderSubagentPrompt({
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
      keepAlive: options.keepAlive,
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

    const env = buildAgentEnv(agent, currentDepth, executionCwd);
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
        active.partialOutput = active.client?.getPartialText() ?? active.partialOutput;
        active.toolCalls = active.client?.getToolCalls() ?? active.toolCalls;
        active.filesTouched = active.client?.getFilesTouched() ?? active.filesTouched;
        deps.registry.notify(active.taskId);
      },
      maxReadFileBytes: deps.config.security.max_read_file_bytes,
      acpCancelGraceMs: deps.config.defaults.acp_cancel_grace_ms,
      processKillGraceMs: deps.config.defaults.process_kill_grace_ms
    });
    active.client = client;

    await client.initialize();
    const mcpServers = resolveMcpServerProfiles(deps.config, agentType, normalizedInput.mcp_server_profiles);
    const session = await client.newSession({ cwd: executionCwd, mcpServers });
    active.sessionId = session.sessionId;
    scheduleSessionTtl(active, deps);

    launchPromptTurn({
      active,
      deps,
      promptText: rendered.text,
      timeoutSecs: normalizedInput.timeout_secs,
      inactivityTimeoutSecs: normalizedInput.inactivity_timeout_secs,
      outputOptions,
      skillContext,
      turnKind: "initial"
    });

    return active;
  } catch (error) {
    releaseConcurrency();
    await client?.shutdown().catch(() => undefined);
    await logger?.writeJson("result.json", failureOutputFromError(agentType, error, Date.now(), undefined, logger, originalCwd)).catch(() => undefined);
    throw error;
  }
}

/**
 * 同步运行一个子代理任务，等待第一轮结束后返回结果。
 */
export async function runSubagentTask(input: SubagentStartInput, deps: SubagentTaskRunnerDependencies): Promise<SubagentRunOutput> {
  const active = await startSubagentTask({ input, keepAlive: false, conflictPolicy: input.conflict_policy }, deps);
  await active.currentTurnPromise;
  if (!active.result) {
    throw new SubagentRuntimeError("internal_error", "子代理任务结束但没有生成结果");
  }
  return active.result;
}

/**
 * 对已有 session 发起下一轮 prompt。调用方随后可用 wait/result 查询结果。
 */
export async function continueSubagentTask(input: SubagentContinueInput, deps: SubagentTaskRunnerDependencies): Promise<SubagentContinueOutput> {
  const active = deps.registry.get(input.task_id);
  if (!active) throw new SubagentRuntimeError("invalid_input", `任务不存在：${input.task_id}`);
  if (!active.keepAlive || !active.client || !active.sessionId || active.status === "closed") {
    throw new SubagentRuntimeError("invalid_input", `任务不支持继续对话或 session 已关闭：${input.task_id}`);
  }
  if (!isFinishedTaskState(active.status)) {
    throw new SubagentRuntimeError("invalid_input", `上一轮尚未结束，不能继续：${input.task_id}`);
  }

  const outputOptions = normalizeOutputOptions(input.output ?? active.outputOptions);
  const files = await resolveTaskFiles({
    cwd: active.executionCwd,
    files: input.additional_files,
    maxInlineChars: deps.config.defaults.max_inline_file_chars
  });
  const skillContext = input.skills ? await buildSkillPromptContext({ config: deps.config, cwd: active.cwd, input: input.skills }) : undefined;
  const rendered = renderSubagentContinuePrompt({
    mode: input.mode ?? "continue",
    message: input.message,
    correction: input.correction,
    files,
    output: outputOptions,
    skills: skillContext
  });
  assertPromptSize(rendered.text, deps.config.defaults.max_prompt_chars);
  await active.logger?.writePrompt(`\n\n--- continue ${new Date().toISOString()} ---\n\n${rendered.text}`);

  const turnId = launchPromptTurn({
    active,
    deps,
    promptText: rendered.text,
    timeoutSecs: input.timeout_secs,
    inactivityTimeoutSecs: input.inactivity_timeout_secs,
    outputOptions,
    skillContext,
    turnKind: "continue"
  });

  return {
    schema_version: 1,
    status: "started",
    task_id: active.taskId,
    turn_id: turnId,
    session_id: active.sessionId,
    created_at: new Date().toISOString(),
    summary: `已向子代理继续发送任务：${active.taskId}`
  };
}

/**
 * 取消一个任务。
 */
export async function cancelActiveTask(active: ActiveSubagentTask, reason?: string): Promise<"cancelled" | "already_terminal"> {
  if (isTerminalTaskState(active.status)) return "already_terminal";
  active.status = "cancelling";
  active.errors.push(makeSubagentError("cancelled", reason ? `任务已取消：${reason}` : "任务已取消", { recoverable: true }));
  active.timeoutController?.abort("cancelled");
  if (active.client && active.sessionId) {
    await active.client.cancel(active.sessionId).catch(() => undefined);
  }
  return "cancelled";
}

/**
 * 关闭任务和底层 session。可用于释放 keep_alive session。
 */
export async function closeActiveTask(active: ActiveSubagentTask, deps: SubagentTaskRunnerDependencies, force: boolean): Promise<void> {
  if (!isFinishedTaskState(active.status) && !force) {
    throw new SubagentRuntimeError("invalid_input", `任务仍在运行，不能关闭；可设置 force=true：${active.taskId}`);
  }

  if (!isFinishedTaskState(active.status) && force) {
    await cancelActiveTask(active, "force close");
    await active.currentTurnPromise?.catch(() => undefined);
  }

  if (active.client && active.sessionId) {
    await active.client.close(active.sessionId).catch(() => undefined);
  }
  await cleanupActiveTask(active, deps, true);
  active.status = "closed";
  active.completedAt = active.completedAt ?? new Date();
  deps.registry.notify(active.taskId);
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
  turnKind: "initial" | "continue";
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
      const output = buildRunOutput({
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
      });
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
      const output = buildRunOutput({
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
      });
      active.result = output;
      active.status = finalStatus;
      active.errors.push(subagentError);
      turn.status = mapRunStatusToTurnStatus(finalStatus);
      turn.result = output;
      await active.logger?.writeJson("result.json", output).catch(() => undefined);
    } finally {
      timeoutController.dispose();
      active.timeoutController = undefined;
      active.completedAt = new Date();
      active.currentTurnId = undefined;
      deps.registry.notify(active.taskId);

      if (!active.keepAlive || active.status === "failed" || active.status === "timeout" || active.status === "cancelled") {
        await cleanupActiveTask(active, deps, true);
      } else {
        scheduleCompletedSessionTtl(active, deps);
      }
    }
  })();

  deps.registry.notify(active.taskId);
  return turnId;
}

/**
 * 清理子进程、timer 和并发锁。
 */
async function cleanupActiveTask(active: ActiveSubagentTask, deps: SubagentTaskRunnerDependencies, removeTimers: boolean): Promise<void> {
  if (active.cleanedUp) return;
  active.cleanedUp = true;
  if (removeTimers) {
    if (active.sessionTtlTimer) clearTimeout(active.sessionTtlTimer);
    if (active.completedTtlTimer) clearTimeout(active.completedTtlTimer);
  }
  await active.client?.shutdown().catch(() => undefined);
  active.releaseConcurrency?.();
  deps.registry.notify(active.taskId);
}

/**
 * 设置整个 session 的 TTL，到期后强制关闭。
 */
function scheduleSessionTtl(active: ActiveSubagentTask, deps: SubagentTaskRunnerDependencies): void {
  if (active.sessionTtlTimer) clearTimeout(active.sessionTtlTimer);
  active.sessionTtlTimer = setTimeout(() => {
    void closeActiveTask(active, deps, true).catch(() => undefined);
  }, deps.config.defaults.session_ttl_secs * 1000);
}

/**
 * 设置 completed session 的 TTL，到期后自动 close。
 */
function scheduleCompletedSessionTtl(active: ActiveSubagentTask, deps: SubagentTaskRunnerDependencies): void {
  if (!active.keepAlive) return;
  if (active.completedTtlTimer) clearTimeout(active.completedTtlTimer);
  active.completedTtlTimer = setTimeout(() => {
    void closeActiveTask(active, deps, true).catch(() => undefined);
  }, deps.config.defaults.completed_session_ttl_secs * 1000);
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

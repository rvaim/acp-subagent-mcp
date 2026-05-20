import path from "node:path";
import type { ServerConfig } from "../config/types.js";
import { GenericAcpClient } from "../acp/AcpClient.js";
import { AcpEventAggregator } from "../acp/eventAggregator.js";
import { renderSubagentPrompt } from "../task/renderSubagentPrompt.js";
import { parseSubagentResult } from "../task/parseSubagentResult.js";
import type {
  InteractionDetailLevel,
  SubagentCancelInput,
  SubagentCloseInput,
  SubagentContinueInput,
  SubagentLogsInput,
  SubagentResultInput,
  SubagentResultOutput,
  SubagentRunInput,
  SubagentRunOutput,
  SubagentStartInput,
  SubagentStartManyInput,
  SubagentStartManyOutput,
  SubagentStartOutput,
  SubagentTask,
  SubagentWaitInput,
  SubagentWaitOutput,
} from "../task/types.js";
import { compactRunOutput } from "./outputCompaction.js";
import { ConcurrencyGuard } from "./concurrency.js";
import { createRunLogs, readLogTail, writeRedactedJson, writeRedactedText } from "./logs.js";
import {
  validateAgentDepth,
  validateAgentType,
  validateSafeCwd,
  validateTaskFiles,
} from "./security.js";
import { startHeartbeatWatchdog, startInactivityWatchdog } from "./heartbeat.js";
import { TaskRegistry, isTerminalStatus, type ActiveSubagentRun } from "./taskRegistry.js";
import { fingerprint, SessionPool, type PooledSubagentSession } from "./sessionPool.js";

/**
 * 子代理运行时。
 *
 * 该类是 MCP tools 和底层 ACP client 之间的编排层，负责：
 * 配置校验、安全校验、进程启动、ACP 会话、超时、心跳、日志、会话池和结果压缩。
 */
export class SubagentRuntime {
  /** 子代理任务注册表。 */
  readonly registry = new TaskRegistry();

  /** 子代理会话池。 */
  readonly sessionPool: SessionPool;

  /** 并发控制器。 */
  private readonly concurrencyGuard: ConcurrencyGuard;

  /**
   * 正在执行的清理流程。
   *
   * 同一个任务可能同时被 MCP cancellation、heartbeat timeout、wall-clock timeout
   * 和用户手动 subagent_cancel 触发清理，因此这里用 WeakMap 保证杀进程逻辑幂等。
   */
  private readonly cleanupPromises = new WeakMap<ActiveSubagentRun, Promise<void>>();

  /**
   * 创建子代理运行时。
   *
   * @param config 服务器配置。
   */
  constructor(private readonly config: ServerConfig) {
    this.sessionPool = new SessionPool(config);
    this.concurrencyGuard = new ConcurrencyGuard(config.concurrency.max_parallel_tasks);
  }

  /**
   * 列出配置文件中可用的子代理。
   *
   * @returns 安全裁剪后的 agent 列表，不包含 command、env、token 和本地敏感路径。
   */
  listAgents(): { agents: Array<{ name: string; description: string; capabilities: string[] }> } {
    return {
      agents: Object.entries(this.config.agents).map(([name, agent]) => ({
        name,
        description: agent.description,
        capabilities: agent.capabilities,
      })),
    };
  }

  /**
   * 同步运行一个子代理任务。
   *
   * @param input 同步运行输入。
   * @returns 子代理任务运行结果。
   */
  async run(input: SubagentRunInput, signal?: AbortSignal): Promise<SubagentRunOutput> {
    const run = await this.prepareRun(input, {
      keepAlive: false,
      allowPoolRelease: this.shouldAllowPoolRelease(input),
      conflictPolicy: this.config.concurrency.default_conflict_policy,
    });

    const unbindAbort = this.bindRequestAbortToRun(run, signal, "同步子代理任务被 MCP Host 取消");
    try {
      await run.completion;
    } catch {
      // execute 流程已经把错误转换为标准 result，这里继续返回结构化 MCP 输出。
    } finally {
      unbindAbort();
    }
    if (!run.result) {
      throw new Error("子代理任务结束但没有生成 result");
    }
    return this.compact(run.result, input.detail_level);
  }

  /**
   * 启动一个有状态子代理任务，立即返回 task_id。
   *
   * @param input 启动输入。
   * @returns 启动结果。
   */
  async start(input: SubagentStartInput, signal?: AbortSignal): Promise<SubagentStartOutput> {
    const run = await this.prepareRun(input, {
      keepAlive: input.keep_alive ?? true,
      allowPoolRelease: false,
      conflictPolicy: this.config.concurrency.default_conflict_policy,
    });
    const unbindAbort = this.bindRequestAbortToRun(run, signal, "启动子代理任务时 MCP Host 取消了请求");
    if (signal?.aborted) {
      unbindAbort();
      throw new Error("启动子代理任务时 MCP Host 取消了请求");
    }
    unbindAbort();

    return {
      status: "started",
      task_id: run.taskId,
      agent_type: run.agentType,
      session_id: run.sessionId,
      reused_session: run.reusedSession,
      created_at: run.createdAt.toISOString(),
    };
  }

  /**
   * 并行启动多个子代理任务。
   *
   * @param input 批量启动输入。
   * @returns 批量启动结果。
   */
  async startMany(input: SubagentStartManyInput, signal?: AbortSignal): Promise<SubagentStartManyOutput> {
    const started: SubagentStartOutput[] = [];
    const failed: SubagentStartManyOutput["failed"] = [];
    const conflictPolicy = input.conflict_policy ?? this.config.concurrency.default_conflict_policy;

    for (const [index, taskInput] of input.tasks.entries()) {
      if (signal?.aborted) {
        await this.cancel({ task_ids: started.map((item) => item.task_id), reason: "批量启动子代理任务时 MCP Host 取消了请求" });
        throw new Error("批量启动子代理任务时 MCP Host 取消了请求");
      }

      try {
        const run = await this.prepareRun(taskInput, {
          keepAlive: taskInput.keep_alive ?? true,
          allowPoolRelease: false,
          conflictPolicy,
        });
        if (signal?.aborted) {
          await this.cancel({ task_ids: [run.taskId, ...started.map((item) => item.task_id)], reason: "批量启动子代理任务时 MCP Host 取消了请求" });
          throw new Error("批量启动子代理任务时 MCP Host 取消了请求");
        }
        started.push({
          status: "started",
          task_id: run.taskId,
          agent_type: run.agentType,
          session_id: run.sessionId,
          reused_session: run.reusedSession,
          created_at: run.createdAt.toISOString(),
        });
      } catch (error) {
        if (signal?.aborted) {
          await this.cancel({ task_ids: started.map((item) => item.task_id), reason: "批量启动子代理任务时 MCP Host 取消了请求" });
          throw error;
        }

        failed.push({
          index,
          agent_type: taskInput.agent_type,
          error: { code: "START_FAILED", message: error instanceof Error ? error.message : String(error) },
        });
        if (input.on_task_failure === "cancel_all") {
          await this.cancel({ task_ids: started.map((item) => item.task_id), reason: "start_many 中某个任务启动失败" });
          break;
        }
      }
    }

    return { status: failed.length ? "partial" : "started", started, failed };
  }

  /**
   * 等待一个或多个任务完成或更新。
   *
   * @param input 等待输入。
   * @returns 等待结果。
   */
  async wait(input: SubagentWaitInput, signal?: AbortSignal): Promise<SubagentWaitOutput> {
    const startedAt = Date.now();
    const timeoutMs = (input.timeout_secs ?? 60) * 1000;

    const throwIfWaitAborted = async (): Promise<void> => {
      if (!signal?.aborted) {
        return;
      }
      await this.cancel({ task_ids: input.task_ids, reason: "等待子代理任务时 MCP Host 取消了请求" });
      throw new Error("等待子代理任务时 MCP Host 取消了请求");
    };

    while (Date.now() - startedAt < timeoutMs) {
      await throwIfWaitAborted();
      const snapshot = this.buildWaitOutput(input.task_ids, startedAt);
      if (this.satisfiesWaitPolicy(snapshot, input.return_when)) {
        return snapshot;
      }

      const remainingMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
      await Promise.race([
        this.registry.waitForUpdate(input.task_ids, Math.min(1000, remainingMs)),
        waitForAbort(signal),
      ]);
      await throwIfWaitAborted();
    }

    if (input.on_timeout === "cancel_pending") {
      const pending = this.buildWaitOutput(input.task_ids, startedAt).pending_task_ids;
      await this.cancel({ task_ids: pending, reason: "subagent_wait timeout" });
    }

    const timeoutOutput = this.buildWaitOutput(input.task_ids, startedAt);
    return { ...timeoutOutput, status: timeoutOutput.pending_task_ids.length ? "timeout" : timeoutOutput.status };
  }

  /**
   * 查询某个任务的当前状态和结果。
   *
   * @param input 查询输入。
   * @returns 任务状态和可见结果。
   */
  result(input: SubagentResultInput): SubagentResultOutput {
    const run = this.requireRun(input.task_id);
    return {
      task_id: run.taskId,
      agent_type: run.agentType,
      status: run.status,
      latest_summary: run.result?.summary ?? summarize(run.partialOutput),
      result: run.result ? this.compact(run.result, input.detail_level) : undefined,
      partial_output: run.result ? undefined : truncate(run.partialOutput, this.config.defaults.max_tool_output_chars),
      raw_event_log_path: run.rawEventLogPath,
    };
  }

  /**
   * 对同一个子代理 session 继续发消息。
   *
   * @param input 继续对话输入。
   * @returns 新一轮运行结果。
   */
  async continue(input: SubagentContinueInput, signal?: AbortSignal): Promise<SubagentRunOutput> {
    const run = this.requireRun(input.task_id);
    if (!run.client || !run.sessionId) {
      throw new Error("该任务没有可继续使用的 ACP session；请使用 subagent_start 并 keep_alive=true 启动");
    }
    if (run.status === "running" || run.status === "starting") {
      throw new Error("上一轮 prompt 还未结束，同一 session 不允许并发 continue");
    }

    if (input.additional_files?.length) {
      await validateTaskFiles({ title: "continue", goal: input.message, files: input.additional_files }, run.cwd ?? process.cwd(), this.config);
    }

    const prompt = this.renderContinuePrompt(input);
    await writeRedactedText(run.logs.renderedPromptPath, `${prompt}\n`);

    run.keepAlive = true;
    run.allowPoolRelease = false;
    run.detailLevel = input.detail_level ?? run.detailLevel;
    run.completion = this.executePromptTurn(run, prompt, {
      timeoutSecs: input.timeout_secs ?? this.config.defaults.timeout_secs,
      inactivityTimeoutSecs: this.config.defaults.inactivity_timeout_secs,
      heartbeatTimeoutSecs: this.config.defaults.heartbeat_timeout_secs,
    });

    const unbindAbort = this.bindRequestAbortToRun(run, signal, "继续子代理任务时 MCP Host 取消了请求");
    try {
      const output = await run.completion;
      return this.compact(output, input.detail_level);
    } catch {
      if (run.result) {
        return this.compact(run.result, input.detail_level);
      }
      throw new Error("继续任务失败且没有生成标准结果");
    } finally {
      unbindAbort();
    }
  }

  /**
   * 取消一个或多个任务。
   *
   * @param input 取消输入。
   * @returns 取消摘要。
   */
  async cancel(input: SubagentCancelInput): Promise<{ cancelled_task_ids: string[]; errors: Array<{ task_id: string; message: string }> }> {
    const cancelledTaskIds: string[] = [];
    const errors: Array<{ task_id: string; message: string }> = [];

    for (const taskId of input.task_ids) {
      const run = this.registry.get(taskId);
      if (!run) {
        errors.push({ task_id: taskId, message: "任务不存在" });
        continue;
      }

      try {
        run.errors.push({ code: "CANCELLED", message: input.reason ?? "任务被取消" });
        this.registry.setStatus(run, "cancelled");
        run.cancelController.abort();
        await this.cancelAndShutdown(run);
        cancelledTaskIds.push(taskId);
      } catch (error) {
        errors.push({ task_id: taskId, message: error instanceof Error ? error.message : String(error) });
      }
    }

    return { cancelled_task_ids: cancelledTaskIds, errors };
  }

  /**
   * 关闭已完成或不再需要的有状态 session。
   *
   * @param input 关闭输入。
   * @returns 关闭状态。
   */
  async close(input: SubagentCloseInput): Promise<{ status: "closed"; task_id: string }> {
    const run = this.requireRun(input.task_id);
    if ((run.status === "running" || run.status === "starting") && !input.force) {
      throw new Error("任务仍在运行，force=false 时不能关闭");
    }

    if (input.force && (run.status === "running" || run.status === "starting")) {
      await this.cancel({ task_ids: [run.taskId], reason: "强制关闭任务" });
    }

    if (run.client && run.sessionId) {
      try {
        await run.client.close(run.sessionId);
      } catch {
        // session/close 是可选能力，失败时继续清理进程。
      }
      await run.client.shutdown();
    }

    this.registry.setStatus(run, "closed");
    return { status: "closed", task_id: run.taskId };
  }

  /**
   * 查询任务日志尾部。
   *
   * @param input 日志查询输入。
   * @returns 日志路径和内容尾部。
   */
  async logs(input: SubagentLogsInput): Promise<{ task_id: string; path: string; content: string; truncated: boolean }> {
    const run = this.requireRun(input.task_id);
    const kind = input.kind ?? "events";
    const filePath = {
      task: run.logs.taskPath,
      prompt: run.logs.renderedPromptPath,
      events: run.logs.eventsPath,
      stderr: run.logs.stderrPath,
      result: run.logs.resultPath,
    }[kind];
    const maxChars = input.max_chars ?? this.config.defaults.max_tool_output_chars;
    const content = await readLogTail(filePath, maxChars);
    return { task_id: run.taskId, path: filePath, content, truncated: content.length >= maxChars };
  }

  /**
   * 关闭运行时持有的池化 session。
   */
  async shutdown(): Promise<void> {
    const runs = this.registry.list();
    await Promise.allSettled(
      runs.map(async (run) => {
        if (!isTerminalStatus(run.status)) {
          run.errors.push({ code: "MCP_SERVER_SHUTDOWN", message: "MCP Server 正在关闭，子代理任务已取消" });
          this.registry.setStatus(run, "cancelled");
        }
        run.cancelController.abort("MCP Server 正在关闭");
        await this.cancelAndShutdown(run);
      }),
    );
    await this.sessionPool.shutdownAll();
  }

  /**
   * 准备任务：校验输入、创建日志、创建任务对象并后台启动执行。
   *
   * @param input 任务输入。
   * @param options 内部执行选项。
   * @returns 任务对象。
   */
  private async prepareRun(
    input: SubagentRunInput,
    options: {
      keepAlive: boolean;
      allowPoolRelease: boolean;
      conflictPolicy: "allow_readonly_parallel" | "single_writer_per_cwd" | "sandbox_worktree";
    },
  ): Promise<ActiveSubagentRun> {
    validateAgentDepth(this.config.defaults.max_depth);
    validateAgentType(input.agent_type, this.config);

    const cwd = await validateSafeCwd(path.resolve(input.cwd ?? process.cwd()), this.config.security.allowed_cwd_roots);
    await validateTaskFiles(input.task, cwd, this.config);

    const agent = this.config.agents[input.agent_type];
    if (!agent) {
      throw new Error(`未知 agent_type：${input.agent_type}`);
    }

    const parentAgentId = input.parent_agent_id ?? input.task.parent_context?.parent_agent ?? "default";
    const detailLevel = input.detail_level ?? this.config.defaults.default_detail_level;
    const logs = await createRunLogs(path.resolve(this.config.defaults.log_dir));
    const poolPreview = this.findPoolPreview(input, cwd, parentAgentId);
    const prompt = renderSubagentPrompt({
      mode: input.mode,
      task: input.task,
      systemPrompt: agent.system_prompt,
      conversationSummary: poolPreview?.conversationSummary,
    });

    if (prompt.length > this.config.defaults.max_prompt_chars) {
      throw new Error(`渲染后的 prompt 长度超过 max_prompt_chars：${prompt.length}`);
    }

    await writeRedactedJson(logs.taskPath, input.task);
    await writeRedactedText(logs.renderedPromptPath, prompt);

    const run = this.registry.create({
      agentType: input.agent_type,
      cwd,
      mode: input.mode,
      parentAgentId,
      logs,
      detailLevel,
      keepAlive: options.keepAlive,
      allowPoolRelease: options.allowPoolRelease,
    });

    this.concurrencyGuard.acquire(run.taskId, cwd, input.task, input.mode, options.conflictPolicy);
    run.completion = this.executeInitialRun(run, input, prompt).finally(() => {
      this.concurrencyGuard.release(run.taskId);
    });

    // 避免后台 Promise 的异常变成未处理异常；结果仍保存在 run.result / run.errors 中。
    run.completion.catch(() => undefined);
    return run;
  }

  /**
   * 执行首轮子代理任务。
   *
   * @param run 任务对象。
   * @param input 原始工具输入。
   * @param prompt 渲染后的 prompt。
   * @returns 子代理运行结果。
   */
  private async executeInitialRun(run: ActiveSubagentRun, input: SubagentRunInput, prompt: string): Promise<SubagentRunOutput> {
    const agent = this.config.agents[run.agentType];
    if (!agent) {
      throw new Error(`未知 agent_type：${run.agentType}`);
    }

    const timeoutSecs = input.timeout_secs ?? agent.timeout_secs ?? this.config.defaults.timeout_secs;
    const inactivityTimeoutSecs = input.inactivity_timeout_secs ?? agent.inactivity_timeout_secs ?? this.config.defaults.inactivity_timeout_secs;
    const heartbeatTimeoutSecs = input.heartbeat_timeout_secs ?? agent.heartbeat_timeout_secs ?? this.config.defaults.heartbeat_timeout_secs;

    this.registry.setStatus(run, "starting");
    run.startedAt = new Date();

    return await this.withTimeouts(run, { timeoutSecs, inactivityTimeoutSecs, heartbeatTimeoutSecs }, async () => {
      const poolPolicy = input.session_pool_policy ?? this.config.session_pool.reuse_policy;
      const permissionPolicyFingerprint = fingerprint(this.config.permissions[run.agentType] ?? this.config.permissions.default);
      let pooled: PooledSubagentSession | undefined;

      if (poolPolicy === "auto") {
        pooled = this.sessionPool.acquire({
          parentAgentId: run.parentAgentId,
          agentType: run.agentType,
          cwd: run.cwd,
          mode: run.mode,
          mcpServers: input.mcp_servers,
          permissionPolicyFingerprint,
        });
      }

      if (pooled) {
        run.client = pooled.client;
        run.client.setLifecycleHandlers({
          onHeartbeat: () => this.registry.touchHeartbeat(run),
          onActivity: () => this.registry.touchActivity(run),
        });
        run.sessionId = pooled.sessionId;
        run.processId = pooled.processId;
        run.reusedSession = true;
        this.sessionPool.remove(pooled.poolEntryId);
      } else {
        run.client = new GenericAcpClient({
          agentType: run.agentType,
          agentConfig: agent,
          serverConfig: this.config,
          cwd: run.cwd ?? process.cwd(),
          logs: run.logs,
          onHeartbeat: () => this.registry.touchHeartbeat(run),
          onActivity: () => this.registry.touchActivity(run),
        });
        run.processId = run.client.child.pid;
        await run.client.initialize();
        const session = await run.client.newSession({ cwd: run.cwd ?? process.cwd(), mcpServers: input.mcp_servers });
        run.sessionId = session.sessionId;
      }

      return await this.executePromptTurn(run, prompt, { timeoutSecs, inactivityTimeoutSecs, heartbeatTimeoutSecs }, input.mcp_servers);
    });
  }

  /**
   * 执行一轮 ACP session/prompt。
   *
   * @param run 任务对象。
   * @param prompt 本轮 prompt。
   * @param timeouts 超时参数。
   * @param mcpServers MCP servers 配置，用于会话池签名。
   * @returns 子代理运行结果。
   */
  private async executePromptTurn(
    run: ActiveSubagentRun,
    prompt: string,
    timeouts: { timeoutSecs: number; inactivityTimeoutSecs: number; heartbeatTimeoutSecs: number },
    mcpServers?: unknown,
  ): Promise<SubagentRunOutput> {
    if (!run.client || !run.sessionId) {
      throw new Error("内部错误：缺少 ACP client 或 sessionId");
    }

    const startedAt = Date.now();
    const turnId = `turn_${run.turns.length + 1}`;
    run.currentTurnId = turnId;
    run.turns.push({ turnId, prompt, status: "running" });
    this.registry.setStatus(run, "running");

    return await this.withTimeouts(run, timeouts, async () => {
      const aggregator = new AcpEventAggregator();
      const promptResult = await run.client!.prompt({ sessionId: run.sessionId!, prompt, aggregator });
      const aggregated = aggregator.result();
      const rawText = aggregated.textOutput || JSON.stringify(promptResult, null, 2);
      const structured = parseSubagentResult(rawText);
      const elapsedMs = Date.now() - startedAt;
      const status = this.mapStructuredStatus(structured.status, promptResult.stopReason);
      const output: SubagentRunOutput = {
        status,
        agent_type: run.agentType,
        session_id: run.sessionId,
        summary: structured.summary,
        result: structured.result,
        structured,
        stop_reason: promptResult.stopReason,
        elapsed_ms: elapsedMs,
        reused_session: run.reusedSession,
        tool_calls: aggregated.toolCalls,
        files_touched: mergeUnique(aggregated.filesTouched, (structured.files_changed ?? []).map((item) => item.path)),
        raw_event_log_path: run.rawEventLogPath,
        errors: [...run.errors, ...(structured.errors ?? [])],
      };

      run.partialOutput = rawText;
      run.toolCalls = output.tool_calls ?? [];
      run.filesTouched = output.files_touched ?? [];
      run.result = output;
      run.contextUsageRatio = estimateContextUsageRatio(prompt, rawText, run.turns.length);
      run.currentTurnId = undefined;
      const currentTurn = run.turns.find((turn) => turn.turnId === turnId);
      if (currentTurn) {
        currentTurn.status = status === "cancelled" ? "cancelled" : status === "failed" ? "failed" : "completed";
        currentTurn.result = output;
      }
      this.registry.setStatus(run, status === "partial" ? "completed" : status);
      await writeRedactedJson(run.logs.resultPath, output);

      await this.cleanupAfterSuccess(run, mcpServers, output.summary);
      return output;
    });
  }

  /**
   * 为执行过程增加 wall-clock、inactivity 和 heartbeat 超时。
   *
   * @param run 任务对象。
   * @param timeouts 超时参数。
   * @param operation 实际执行逻辑。
   * @returns operation 的结果。
   */
  private async withTimeouts<T>(
    run: ActiveSubagentRun,
    timeouts: { timeoutSecs: number; inactivityTimeoutSecs: number; heartbeatTimeoutSecs: number },
    operation: () => Promise<T>,
  ): Promise<T> {
    let settled = false;
    let rejectTimeout: (error: Error) => void = () => undefined;

    const fail = (code: "TIMEOUT" | "INACTIVITY_TIMEOUT" | "HEARTBEAT_TIMEOUT", message: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      run.errors.push({ code, message });
      this.registry.setStatus(run, code === "HEARTBEAT_TIMEOUT" ? "heartbeat_timeout" : "timeout");
      void this.cancelAndShutdown(run);
      rejectTimeout(new Error(message));
    };

    const cancelFromAbortSignal = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      const message = abortReasonToMessage(run.cancelController.signal.reason, "子代理任务被取消，已终止");
      if (!run.errors.some((error) => error.code === "MCP_REQUEST_CANCELLED" || error.code === "CANCELLED")) {
        run.errors.push({ code: "MCP_REQUEST_CANCELLED", message });
      }
      this.registry.setStatus(run, "cancelled");
      void this.cancelAndShutdown(run);
      rejectTimeout(new Error(message));
    };

    const timeoutPromise = new Promise<never>((_, reject) => {
      rejectTimeout = reject;
    });

    const wallTimer = setTimeout(() => {
      fail("TIMEOUT", "子代理任务超过 wall-clock timeout，已终止");
    }, timeouts.timeoutSecs * 1000);

    const heartbeatTimer = startHeartbeatWatchdog({
      getLastHeartbeatMs: () => run.lastHeartbeatAt?.getTime() ?? run.startedAt?.getTime() ?? Date.now(),
      heartbeatTimeoutMs: timeouts.heartbeatTimeoutSecs * 1000,
      onTimeout: () => {
        fail("HEARTBEAT_TIMEOUT", `子代理超过 ${timeouts.heartbeatTimeoutSecs} 秒无心跳，已终止`);
      },
    });

    const inactivityTimer = startInactivityWatchdog(
      () => run.lastActivityAt?.getTime() ?? run.startedAt?.getTime() ?? Date.now(),
      timeouts.inactivityTimeoutSecs * 1000,
      () => {
        fail("INACTIVITY_TIMEOUT", `子代理超过 ${timeouts.inactivityTimeoutSecs} 秒无有效进展，已终止`);
      },
    );

    run.cancelController.signal.addEventListener("abort", cancelFromAbortSignal, { once: true });
    if (run.cancelController.signal.aborted) {
      queueMicrotask(cancelFromAbortSignal);
    }

    try {
      const result = await Promise.race([operation(), timeoutPromise]);
      settled = true;
      return result;
    } catch (error) {
      if (!run.result) {
        const output = await this.buildErrorOutput(run, error);
        run.result = output;
      }
      try {
        await this.cancelAndShutdown(run);
      } catch {
        // 清理失败不能覆盖原始失败原因。
      }
      throw error;
    } finally {
      settled = true;
      run.cancelController.signal.removeEventListener("abort", cancelFromAbortSignal);
      clearTimeout(wallTimer);
      clearInterval(heartbeatTimer);
      clearInterval(inactivityTimer);
    }
  }

  /**
   * 成功完成后的资源处理：保留、入池或关闭。
   *
   * @param run 任务对象。
   * @param mcpServers MCP servers 配置。
   * @param summary 对话摘要。
   */
  private async cleanupAfterSuccess(run: ActiveSubagentRun, mcpServers: unknown, summary: string): Promise<void> {
    if (!run.client || !run.sessionId) {
      return;
    }

    if (run.keepAlive) {
      return;
    }

    if (run.allowPoolRelease) {
      const permissionPolicyFingerprint = fingerprint(this.config.permissions[run.agentType] ?? this.config.permissions.default);
      const released = this.sessionPool.release({
        parentAgentId: run.parentAgentId,
        agentType: run.agentType,
        cwd: run.cwd,
        mode: run.mode,
        mcpServers,
        permissionPolicyFingerprint,
        sessionId: run.sessionId,
        processId: run.processId,
        client: run.client,
        contextUsageRatio: run.contextUsageRatio ?? 0,
        conversationSummary: summary,
      });
      if (released) {
        run.client = undefined;
        return;
      }
    }

    try {
      await run.client.close(run.sessionId);
    } catch {
      // session/close 是 ACP 可选能力，失败时继续关进程。
    }
    await run.client.shutdown();
  }

  /**
   * 取消当前任务并终止进程。
   *
   * @param run 任务对象。
   */
  private async cancelAndShutdown(run: ActiveSubagentRun): Promise<void> {
    const existingCleanup = this.cleanupPromises.get(run);
    if (existingCleanup) {
      await existingCleanup;
      return;
    }

    const cleanupPromise = (async (): Promise<void> => {
      if (!run.client) {
        return;
      }
      if (run.sessionId) {
        try {
          await run.client.cancel(run.sessionId);
        } catch {
          // 取消通知失败时继续清理进程。真正可靠的兜底是下面的进程树终止。
        }
      }
      await run.client.shutdown();
    })();

    this.cleanupPromises.set(run, cleanupPromise);
    await cleanupPromise;
  }

  /**
   * 把 MCP 请求取消信号绑定到指定子代理任务。
   *
   * MCP Host 点击停止时，TypeScript SDK 会通过 extra.signal 通知当前 tool handler。
   * 这里必须把这个信号转换成运行时取消，否则 Host 只会停止等待响应，Claude 等子进程仍会继续运行。
   *
   * @param run 任务对象。
   * @param signal MCP SDK 提供的请求取消信号。
   * @param defaultReason 默认取消原因。
   * @returns 解绑函数。
   */
  private bindRequestAbortToRun(run: ActiveSubagentRun, signal: AbortSignal | undefined, defaultReason: string): () => void {
    if (!signal) {
      return () => undefined;
    }

    const onAbort = (): void => {
      if (isTerminalStatus(run.status)) {
        return;
      }
      const message = abortReasonToMessage(signal.reason, defaultReason);
      run.errors.push({ code: "MCP_REQUEST_CANCELLED", message });
      this.registry.setStatus(run, "cancelled");
      run.cancelController.abort(message);
    };

    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }

    return () => signal.removeEventListener("abort", onAbort);
  }

  /**
   * 根据异常构造标准错误结果。
   *
   * @param run 任务对象。
   * @param error 异常对象。
   * @returns 标准运行结果。
   */
  private async buildErrorOutput(run: ActiveSubagentRun, error: unknown): Promise<SubagentRunOutput> {
    const status = run.status === "heartbeat_timeout" ? "heartbeat_timeout" : run.status === "cancelled" ? "cancelled" : run.status === "timeout" ? "timeout" : "failed";
    const message = error instanceof Error ? error.message : String(error);
    const output: SubagentRunOutput = {
      status,
      agent_type: run.agentType,
      session_id: run.sessionId,
      summary: message,
      result: run.partialOutput || message,
      elapsed_ms: Date.now() - (run.startedAt?.getTime() ?? run.createdAt.getTime()),
      reused_session: run.reusedSession,
      tool_calls: run.toolCalls,
      files_touched: run.filesTouched,
      raw_event_log_path: run.rawEventLogPath,
      errors: run.errors.length ? run.errors : [{ code: "SUBAGENT_FAILED", message }],
    };
    run.result = output;
    await writeRedactedJson(run.logs.resultPath, output);
    if (!isTerminalStatus(run.status)) {
      this.registry.setStatus(run, status);
    }
    return output;
  }

  /**
   * 判断 subagent_run 是否允许完成后进入会话池。
   *
   * @param input 同步运行输入。
   * @returns 允许入池时返回 true。
   */
  private shouldAllowPoolRelease(input: SubagentRunInput): boolean {
    const policy = input.session_pool_policy ?? this.config.session_pool.reuse_policy;
    return policy === "auto" && this.config.session_pool.enabled;
  }

  /**
   * 仅查找会话池摘要，用于 prompt 压缩提示。
   *
   * @param input 子代理输入。
   * @param cwd 工作目录。
   * @param parentAgentId 父代理 ID。
   * @returns 命中的池化 session；不会从池中移除。
   */
  private findPoolPreview(_input: SubagentRunInput, _cwd: string, _parentAgentId: string): PooledSubagentSession | undefined {
    return undefined;
  }

  /**
   * 渲染 continue prompt。
   *
   * @param input continue 输入。
   * @returns 渲染后的 prompt。
   */
  private renderContinuePrompt(input: SubagentContinueInput): string {
    const lines: string[] = ["# 继续子代理任务", "", `模式：${input.mode ?? "continue"}`, "", input.message, ""];
    if (input.correction) {
      lines.push("## 对上一轮结果的纠正", "", `原因：${input.correction.reason}`);
      if (input.correction.rejected_result) {
        lines.push("", "被拒绝的上一轮结果摘要：", input.correction.rejected_result);
      }
      if (input.correction.expected_change) {
        lines.push("", "期望修改：", input.correction.expected_change);
      }
      lines.push("");
    }
    if (input.additional_files?.length) {
      lines.push("## 本轮新增文件", "", "| path | role | action | description |", "|---|---|---|---|");
      for (const file of input.additional_files) {
        lines.push(`| ${file.path} | ${file.role} | ${file.action} | ${file.description ?? ""} |`);
      }
      lines.push("");
    }
    lines.push("请继续使用上一轮 ACP session 的上下文，只返回最终 JSON 结果。", "");
    return lines.join("\n");
  }

  /**
   * 获取任务对象，缺失时抛出明确错误。
   *
   * @param taskId 任务 ID。
   * @returns 任务对象。
   */
  private requireRun(taskId: string): ActiveSubagentRun {
    const run = this.registry.get(taskId);
    if (!run) {
      throw new Error(`任务不存在：${taskId}`);
    }
    return run;
  }

  /**
   * 生成等待工具输出。
   *
   * @param taskIds 任务 ID 列表。
   * @param startedAt 等待开始时间戳。
   * @returns 等待输出。
   */
  private buildWaitOutput(taskIds: string[], startedAt: number): SubagentWaitOutput {
    const completed: SubagentRunOutput[] = [];
    const failed: SubagentRunOutput[] = [];
    const pendingTaskIds: string[] = [];
    const cancelledTaskIds: string[] = [];

    for (const taskId of taskIds) {
      const run = this.registry.get(taskId);
      if (!run) {
        failed.push({
          status: "failed",
          agent_type: "unknown",
          summary: `任务不存在：${taskId}`,
          result: "",
          elapsed_ms: 0,
          errors: [{ code: "TASK_NOT_FOUND", message: `任务不存在：${taskId}` }],
        });
        continue;
      }

      if (!isTerminalStatus(run.status)) {
        pendingTaskIds.push(taskId);
        continue;
      }

      if (run.status === "cancelled") {
        cancelledTaskIds.push(taskId);
      }

      if (run.result) {
        const compacted = this.compact(run.result, run.detailLevel);
        if (compacted.status === "completed" || compacted.status === "partial") {
          completed.push(compacted);
        } else {
          failed.push(compacted);
        }
      }
    }

    return {
      status: pendingTaskIds.length ? "partial" : "completed",
      completed,
      failed,
      pending_task_ids: pendingTaskIds,
      cancelled_task_ids: cancelledTaskIds,
      elapsed_ms: Date.now() - startedAt,
    };
  }

  /**
   * 判断等待快照是否满足等待策略。
   *
   * @param snapshot 等待输出快照。
   * @param policy 等待策略。
   * @returns 满足时返回 true。
   */
  private satisfiesWaitPolicy(snapshot: SubagentWaitOutput, policy: SubagentWaitInput["return_when"]): boolean {
    if (policy === "all_completed") {
      return snapshot.pending_task_ids.length === 0;
    }
    if (policy === "first_completed") {
      return snapshot.completed.length + snapshot.failed.length + snapshot.cancelled_task_ids.length > 0;
    }
    if (policy === "first_success") {
      return snapshot.completed.some((item) => item.status === "completed");
    }
    if (policy === "first_failure") {
      return snapshot.failed.length > 0;
    }
    if (policy === "any_update") {
      return snapshot.completed.length + snapshot.failed.length > 0;
    }
    if (policy === "timeout_partial") {
      return snapshot.pending_task_ids.length === 0;
    }
    return false;
  }

  /**
   * 压缩运行结果。
   *
   * @param output 原始结果。
   * @param detailLevel 可选详情级别。
   * @returns 压缩结果。
   */
  private compact(output: SubagentRunOutput, detailLevel?: InteractionDetailLevel): SubagentRunOutput {
    return compactRunOutput(output, detailLevel ?? this.config.defaults.default_detail_level, this.config.defaults.max_tool_output_chars);
  }

  /**
   * 将结构化状态映射为 MCP tool 输出状态。
   *
   * @param status 子代理声明状态。
   * @param stopReason ACP 停止原因。
   * @returns MCP tool 输出状态。
   */
  private mapStructuredStatus(status: "completed" | "failed" | "partial", stopReason?: string): SubagentRunOutput["status"] {
    if (stopReason === "cancelled") {
      return "cancelled";
    }
    return status;
  }
}

/**
 * 等待 AbortSignal 触发。
 *
 * @param signal 可选取消信号。
 * @returns signal 触发后 resolve 的 Promise；未传 signal 时永不 resolve。
 */
function waitForAbort(signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return new Promise(() => undefined);
  }
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * 将 AbortSignal.reason 转换成人类可读消息。
 *
 * @param reason AbortSignal 的取消原因。
 * @param fallback 默认消息。
 * @returns 可记录到错误结果中的消息。
 */
function abortReasonToMessage(reason: unknown, fallback: string): string {
  if (reason instanceof Error) {
    return reason.message;
  }
  if (typeof reason === "string" && reason.trim()) {
    return reason;
  }
  return fallback;
}

/**
 * 合并字符串数组并去重。
 *
 * @param arrays 多个字符串数组。
 * @returns 去重后的数组。
 */
function mergeUnique(...arrays: string[][]): string[] {
  return Array.from(new Set(arrays.flat().filter(Boolean)));
}

/**
 * 根据 prompt、输出和轮次保守估算上下文使用率。
 *
 * @param prompt 本轮 prompt。
 * @param output 本轮输出。
 * @param turns 当前会话轮次数。
 * @returns 0 到 1 之间的上下文使用比例。
 */
function estimateContextUsageRatio(prompt: string, output: string, turns: number): number {
  const roughChars = prompt.length + output.length + turns * 4000;
  return Math.min(0.99, roughChars / 800000);
}

/**
 * 截断文本。
 *
 * @param text 原始文本。
 * @param maxChars 最大字符数。
 * @returns 截断后文本。
 */
function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n\n[内容已截断]`;
}

/**
 * 从文本中生成摘要。
 *
 * @param text 原始文本。
 * @returns 摘要。
 */
function summarize(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
}

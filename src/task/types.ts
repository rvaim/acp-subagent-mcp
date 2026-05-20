/**
 * 子代理任务的结构化描述。
 *
 * 主代理通过该结构明确告诉子代理：要完成什么目标、需要处理哪些文件、
 * 每个文件允许执行什么动作、有哪些约束条件、最终结果应该如何返回。
 */
export interface SubagentTask {
  /** 任务标题，用于日志展示、结果追踪和提示词标题。 */
  title: string;

  /** 任务目标，描述子代理最终需要完成的事情。 */
  goal: string;

  /** 背景信息，用于帮助子代理理解任务上下文。 */
  background?: string;

  /** 具体执行指令，适合放置可检查的步骤或限制。 */
  instructions?: string[];

  /** 子代理需要处理的文件列表。 */
  files?: TaskFile[];

  /** 任务约束，例如不要改文件、不要运行破坏性命令等。 */
  constraints?: string[];

  /** 期望输出格式。 */
  expected_output?: ExpectedOutput;

  /** 成功标准，用于帮助主代理判断是否需要打回重试。 */
  success_criteria?: string[];

  /** 父代理传递给子代理的必要上下文摘要，必须保持精简。 */
  parent_context?: ParentContext;
}

/**
 * 父代理向子代理传递的压缩上下文。
 *
 * 该结构只保存与当前任务有关的摘要，不允许直接塞入完整父对话，
 * 以避免跨代理传输过多上下文。
 */
export interface ParentContext {
  /** 父代理名称或主 agent 标识，用于日志和会话池隔离。 */
  parent_agent?: string;

  /** 对话摘要，不应该包含无关长上下文。 */
  conversation_summary?: string;

  /** 前序发现或已知结论，只保留可执行结论。 */
  previous_findings?: string[];
}

/**
 * 子代理需要处理的单个文件描述。
 */
export interface TaskFile {
  /** 文件路径，必须相对 cwd，不能路径穿越。 */
  path: string;

  /** 文件在任务中的角色。 */
  role: "primary" | "reference" | "test" | "config" | "output" | "unknown";

  /** 子代理允许对该文件执行的动作。 */
  action: "read" | "review" | "edit" | "create" | "delete" | "ignore";

  /** 文件说明，帮助子代理理解该文件用途。 */
  description?: string;

  /** 需要关注的行号范围。 */
  line_ranges?: LineRange[];

  /** 内联文件内容或片段。 */
  content?: string;

  /** 文件内容传递方式。 */
  content_mode?: "path_only" | "inline" | "snippet";
}

/**
 * 文件行号范围。
 */
export interface LineRange {
  /** 起始行号，从 1 开始。 */
  start: number;

  /** 结束行号，从 1 开始，必须大于等于 start。 */
  end: number;
}

/**
 * 子代理最终结果的期望输出格式。
 */
export interface ExpectedOutput {
  /** 期望输出格式。 */
  format: "text" | "markdown" | "json" | "patch" | "structured";

  /** 必须包含的章节。 */
  required_sections?: string[];

  /** 当 format=json 或 structured 时，可选的 JSON Schema。 */
  json_schema?: Record<string, unknown>;

  /** 是否要求返回改动文件列表。 */
  include_files_changed?: boolean;

  /** 是否要求返回风险说明。 */
  include_risks?: boolean;

  /** 是否要求返回下一步建议。 */
  include_next_steps?: boolean;
}

/**
 * 子代理返回的结构化结果。
 */
export interface SubagentStructuredResult {
  /** 子代理声明的任务状态。 */
  status: "completed" | "failed" | "partial";

  /** 一句话结果摘要。 */
  summary: string;

  /** 主要结果内容。 */
  result: string;

  /** 发现的问题或结论。 */
  findings?: Finding[];

  /** 子代理修改过的文件列表。 */
  files_changed?: FileChange[];

  /** 风险说明。 */
  risks?: string[];

  /** 下一步建议。 */
  next_steps?: string[];

  /** 错误列表。 */
  errors?: SubagentError[];

  /** 原始输出，当无法严格解析 JSON 时保留。 */
  raw_output?: string;
}

/**
 * 子代理发现的问题或结论。
 */
export interface Finding {
  /** 发现的标题。 */
  title?: string;

  /** 发现的详细说明。 */
  message?: string;

  /** 严重程度。 */
  severity?: "info" | "low" | "medium" | "high" | "critical";

  /** 相关文件路径。 */
  file?: string;

  /** 相关起始行号。 */
  line?: number;

  /** 相关结束行号。 */
  end_line?: number;
}

/**
 * 子代理修改或触碰过的文件描述。
 */
export interface FileChange {
  /** 文件路径。 */
  path: string;

  /** 文件动作。 */
  action?: "created" | "modified" | "deleted" | "read" | "reviewed";

  /** 文件变更摘要。 */
  summary?: string;
}

/**
 * 子代理任务错误信息。
 */
export interface SubagentError {
  /** 稳定错误码，便于主代理做分支处理。 */
  code: string;

  /** 面向人类的错误说明。 */
  message: string;

  /** 可选错误详情，默认不会返回大段内容。 */
  details?: unknown;
}

/**
 * 子代理执行过程中的工具调用摘要。
 */
export interface ToolCallSummary {
  /** ACP 工具调用 ID。 */
  tool_call_id?: string;

  /** 工具展示标题或名称。 */
  title?: string;

  /** 工具类型。 */
  kind?: string;

  /** 工具调用状态。 */
  status?: string;

  /** 简短摘要。 */
  summary?: string;
}

/**
 * 子代理任务最终状态。
 */
export type SubagentFinalStatus =
  | "completed"
  | "failed"
  | "partial"
  | "timeout"
  | "heartbeat_timeout"
  | "cancelled";

/**
 * 子代理任务运行态状态。
 */
export type SubagentTaskState =
  | "created"
  | "starting"
  | "running"
  | "waiting_permission"
  | "completed"
  | "failed"
  | "timeout"
  | "heartbeat_timeout"
  | "cancelled"
  | "closed";

/**
 * 子代理输出详情级别。
 */
export type InteractionDetailLevel = "summary" | "normal" | "verbose";

/**
 * 子代理会话池复用策略。
 */
export type SessionPoolPolicy = "auto" | "disable" | "force_new";

/**
 * 子代理运行模式。
 */
export type SubagentMode = "analyze" | "review" | "edit" | "implement" | "debug" | "custom";

/**
 * 同步运行子代理任务的输入参数。
 */
export interface SubagentRunInput {
  /** 要调用的子代理类型，必须存在于 agents.toml。 */
  agent_type: string;

  /** 子代理需要完成的结构化任务。 */
  task: SubagentTask;

  /** 子代理运行时的工作目录，可选。 */
  cwd?: string;

  /** 整个任务的最大运行时间，单位为秒。 */
  timeout_secs?: number;

  /** 任务无有效输出时的最大等待时间，单位为秒。 */
  inactivity_timeout_secs?: number;

  /** 子代理无任何存活响应时的最大等待时间，单位为秒，默认 60。 */
  heartbeat_timeout_secs?: number;

  /** 任务模式，用于影响 prompt 渲染和权限策略。 */
  mode?: SubagentMode;

  /** 需要传递给子代理 session 的 MCP servers 配置。 */
  mcp_servers?: Record<string, unknown> | unknown[];

  /** 会话池复用策略，默认 auto。 */
  session_pool_policy?: SessionPoolPolicy;

  /** 返回给主 agent 的信息详细程度，默认 summary。 */
  detail_level?: InteractionDetailLevel;

  /** 父代理标识，用于会话池隔离；未传时使用 task.parent_context.parent_agent 或 default。 */
  parent_agent_id?: string;
}

/**
 * 子代理任务运行结果。
 */
export interface SubagentRunOutput {
  /** 任务最终状态。 */
  status: SubagentFinalStatus;

  /** 实际调用的子代理类型。 */
  agent_type: string;

  /** ACP session id，如果已经创建 session，则返回该字段。 */
  session_id?: string;

  /** 一句话总结，供主代理快速判断结果。 */
  summary: string;

  /** 子代理返回的主要结果。 */
  result: string;

  /** 解析后的结构化结果。 */
  structured?: SubagentStructuredResult;

  /** ACP prompt turn 的停止原因。 */
  stop_reason?: string;

  /** 任务耗时，单位为毫秒。 */
  elapsed_ms: number;

  /** 是否复用了会话池中的已有 session。 */
  reused_session?: boolean;

  /** 子代理执行过程中的工具调用摘要。 */
  tool_calls?: ToolCallSummary[];

  /** 子代理触碰过的文件列表。 */
  files_touched?: string[];

  /** 原始事件日志路径。 */
  raw_event_log_path?: string;

  /** 错误列表。 */
  errors: SubagentError[];
}

/**
 * 启动一个有状态子代理任务的输入参数。
 */
export interface SubagentStartInput extends SubagentRunInput {
  /** 是否在任务完成后保留 session，以支持后续 continue。 */
  keep_alive?: boolean;
}

/**
 * 启动子代理任务后的返回结果。
 */
export interface SubagentStartOutput {
  /** 启动状态。 */
  status: "started";

  /** MCP Server 生成的任务 ID。 */
  task_id: string;

  /** 实际调用的子代理类型。 */
  agent_type: string;

  /** ACP session id。 */
  session_id?: string;

  /** 是否复用了会话池中的已有 session。 */
  reused_session?: boolean;

  /** 任务创建时间。 */
  created_at: string;
}

/**
 * 并行启动多个子代理任务的输入参数。
 */
export interface SubagentStartManyInput {
  /** 要并行启动的任务列表。 */
  tasks: SubagentStartInput[];

  /** 并行任务的文件冲突处理策略。 */
  conflict_policy?: "allow_readonly_parallel" | "single_writer_per_cwd" | "sandbox_worktree";

  /** 单个任务失败后，其他任务如何处理。 */
  on_task_failure?: "keep_others_running" | "cancel_all";
}

/**
 * 并行启动多个子代理任务后的返回结果。
 */
export interface SubagentStartManyOutput {
  /** 启动状态。 */
  status: "started" | "partial";

  /** 成功启动的任务。 */
  started: SubagentStartOutput[];

  /** 启动失败的任务。 */
  failed: Array<{ index: number; agent_type?: string; error: SubagentError }>;
}

/**
 * 等待一个或多个子代理任务的输入参数。
 */
export interface SubagentWaitInput {
  /** 要等待的任务 ID 列表。 */
  task_ids: string[];

  /** 等待策略。 */
  return_when:
    | "all_completed"
    | "first_completed"
    | "first_success"
    | "first_failure"
    | "any_update"
    | "timeout_partial";

  /** 本次等待的最大时间，单位为秒。 */
  timeout_secs?: number;

  /** 等待超时后，未完成任务应该继续运行还是取消。 */
  on_timeout?: "keep_running" | "cancel_pending";
}

/**
 * 等待子代理任务后的返回结果。
 */
export interface SubagentWaitOutput {
  /** 等待结果状态。 */
  status: "completed" | "partial" | "timeout";

  /** 已完成的任务结果。 */
  completed: SubagentRunOutput[];

  /** 已失败的任务结果。 */
  failed: SubagentRunOutput[];

  /** 仍在运行的任务 ID。 */
  pending_task_ids: string[];

  /** 已取消的任务 ID。 */
  cancelled_task_ids: string[];

  /** 本次等待耗时，单位为毫秒。 */
  elapsed_ms: number;
}

/**
 * 获取子代理任务结果的输入参数。
 */
export interface SubagentResultInput {
  /** 要查询的任务 ID。 */
  task_id: string;

  /** 是否包含事件摘要。 */
  include_events?: boolean;

  /** 是否包含原始输出。 */
  include_raw_output?: boolean;

  /** 返回给主 agent 的信息详细程度，默认 summary。 */
  detail_level?: InteractionDetailLevel;
}

/**
 * 子代理任务当前结果。
 */
export interface SubagentResultOutput {
  /** 任务 ID。 */
  task_id: string;

  /** 子代理类型。 */
  agent_type: string;

  /** 当前任务状态。 */
  status: SubagentTaskState;

  /** 当前最新摘要。 */
  latest_summary?: string;

  /** 最终结果，如果任务已经完成。 */
  result?: SubagentRunOutput;

  /** 部分输出，如果任务仍在运行。 */
  partial_output?: string;

  /** 原始事件日志路径。 */
  raw_event_log_path?: string;
}

/**
 * 继续向已有子代理 session 发送消息的输入参数。
 */
export interface SubagentContinueInput {
  /** 要继续对话的任务 ID。 */
  task_id: string;

  /** 本轮要发送给子代理的新消息。 */
  message: string;

  /** 对上一轮结果的纠正说明。 */
  correction?: {
    /** 为什么上一轮结果不正确。 */
    reason: string;

    /** 被拒绝的上一轮结果摘要。 */
    rejected_result?: string;

    /** 期望子代理如何修正。 */
    expected_change?: string;
  };

  /** 本轮新增或重新指定的文件。 */
  additional_files?: TaskFile[];

  /** 继续对话的模式。 */
  mode?: "revise" | "fix" | "clarify" | "continue" | "custom";

  /** 本轮最大运行时间，单位为秒。 */
  timeout_secs?: number;

  /** 返回给主 agent 的信息详细程度，默认 summary。 */
  detail_level?: InteractionDetailLevel;
}

/**
 * 取消子代理任务的输入参数。
 */
export interface SubagentCancelInput {
  /** 要取消的任务 ID 列表。 */
  task_ids: string[];

  /** 取消原因。 */
  reason?: string;
}

/**
 * 关闭子代理任务和 session 的输入参数。
 */
export interface SubagentCloseInput {
  /** 要关闭的任务 ID。 */
  task_id: string;

  /** 是否强制关闭仍在运行的任务。 */
  force?: boolean;
}

/**
 * 查询子代理日志的输入参数。
 */
export interface SubagentLogsInput {
  /** 要查询的任务 ID。 */
  task_id: string;

  /** 日志类型。 */
  kind?: "task" | "prompt" | "events" | "stderr" | "result";

  /** 最多读取多少个字符，避免污染主代理上下文。 */
  max_chars?: number;
}

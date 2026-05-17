/**
 * 子代理任务状态。
 */
export type SubagentRunStatus = "completed" | "failed" | "partial" | "timeout" | "cancelled";

/**
 * 子代理运行模式。
 */
export type SubagentMode = "analyze" | "review" | "edit" | "implement" | "debug" | "custom";

/**
 * 子代理输出详细程度。默认 compact，用于减少主 agent token 消耗。
 */
export type SubagentOutputMode = "compact" | "standard" | "full";

/**
 * 子代理文件动作。
 */
export type TaskFileAction = "read" | "review" | "edit" | "create" | "delete" | "ignore";

/**
 * 子代理文件角色。
 */
export type TaskFileRole = "primary" | "reference" | "test" | "config" | "output" | "unknown";

/**
 * 子代理需要处理的单个文件描述。
 */
export interface TaskFile {
  /** 文件路径，必须相对 cwd，不能是绝对路径，不能路径穿越。 */
  path: string;
  /** 文件在任务中的角色。 */
  role: TaskFileRole;
  /** 子代理允许对该文件执行的动作。 */
  action: TaskFileAction;
  /** 文件说明，帮助子代理理解该文件用途。 */
  description?: string;
  /** 需要关注的行号范围。 */
  line_ranges?: Array<{ start: number; end: number }>;
  /** 内联文件内容或片段。 */
  content?: string;
  /** 文件内容传递方式。默认 path_only。 */
  content_mode?: "path_only" | "inline" | "snippet";
}

/**
 * 期望的子代理输出格式。
 */
export interface ExpectedOutput {
  /** 期望输出格式。 */
  format: "text" | "markdown" | "json" | "patch" | "structured";
  /** 必须包含的章节。 */
  required_sections?: string[];
  /** 当 format=json 或 structured 时，可选 JSON Schema。 */
  json_schema?: Record<string, unknown>;
  /** 是否要求返回改动文件列表。 */
  include_files_changed?: boolean;
  /** 是否要求返回风险说明。 */
  include_risks?: boolean;
  /** 是否要求返回下一步建议。 */
  include_next_steps?: boolean;
}

/**
 * 子代理任务的结构化描述。
 */
export interface SubagentTask {
  /** 任务标题，用于日志展示和结果追踪。 */
  title: string;
  /** 任务目标，描述子代理最终需要完成的事情。 */
  goal: string;
  /** 背景信息，用于帮助子代理理解任务上下文。 */
  background?: string;
  /** 具体执行指令。 */
  instructions?: string[];
  /** 子代理需要处理的文件列表。 */
  files?: TaskFile[];
  /** 任务约束，例如不要改文件、不要运行破坏性命令等。 */
  constraints?: string[];
  /** 期望输出格式。 */
  expected_output?: ExpectedOutput;
  /** 成功标准，用于帮助主代理判断是否需要打回重试。 */
  success_criteria?: string[];
  /** 父代理传递给子代理的必要上下文摘要。 */
  parent_context?: {
    /** 父代理名称。 */
    parent_agent?: string;
    /** 对话摘要，不应该包含无关长上下文。 */
    conversation_summary?: string;
    /** 前序发现或已知结论。 */
    previous_findings?: string[];
  };
}


/**
 * 子代理 Skill 注入模式。
 */
export type SubagentSkillMode = "off" | "list" | "inline";

/**
 * 控制如何把父代理环境中的 Skills 提供给子代理。
 */
export interface SubagentSkillOptions {
  /** off 不注入；list 只注入名称/描述；inline 内联指定 SKILL.md。默认来自服务端配置。 */
  mode?: SubagentSkillMode;
  /** 要选择或内联的 Skill 名称。为空时 list 模式列出全部可见 Skill；inline 模式只使用配置默认列表。 */
  names?: string[];
  /** 是否扫描项目级 .claude/skills。 */
  include_project?: boolean;
  /** 是否扫描用户级 ~/.claude/skills。 */
  include_user?: boolean;
  /** 单个内联 SKILL.md 最大字符数。 */
  max_skill_chars?: number;
  /** 所有内联 Skill 的总字符数上限。 */
  max_total_chars?: number;
}

/**
 * 控制返回给主 agent 的内容量。
 */
export interface SubagentOutputOptions {
  /** 输出详细程度。默认 compact。 */
  mode?: SubagentOutputMode;
  /** 返回 result 字段的最大字符数。默认由服务端配置决定。 */
  max_result_chars?: number;
  /** 返回 findings 的最大条数。默认 8。 */
  max_findings?: number;
  /** 是否返回工具调用、触碰文件等诊断信息。默认 false。 */
  include_diagnostics?: boolean;
  /** 是否返回完整 structured 字段。默认只在 full 模式返回。 */
  include_structured?: boolean;
}


/**
 * 同步运行子代理任务的输入参数。
 */
export interface SubagentRunInput {
  /** 要调用的子代理类型；未传时使用默认子代理。 */
  agent_type?: string;
  /** 子代理需要完成的结构化任务。 */
  task: SubagentTask;
  /** 子代理运行时的工作目录。未传时使用 MCP Server 启动目录。 */
  cwd?: string;
  /** 整个任务的最大运行时间，单位为秒。 */
  timeout_secs?: number;
  /** 任务无有效输出时的最大等待时间，单位为秒。 */
  inactivity_timeout_secs?: number;
  /** 任务模式，用于影响 prompt 渲染和权限策略。 */
  mode?: SubagentMode;
  /** 允许连接的 MCP server profile 名称。MVP 禁止动态 command。 */
  mcp_server_profiles?: string[];
  /** 父代理 Skill 桥接选项；默认只注入低 token 的 Skill 清单。 */
  skills?: SubagentSkillOptions;
  /** 输出压缩选项，用于减少主 agent token。 */
  output?: SubagentOutputOptions;
}

/**
 * 解析后的任务文件，内部使用绝对路径。
 */
export interface ResolvedTaskFile extends TaskFile {
  /** 主 agent 传入的相对路径。 */
  relativePath: string;
  /** 经过 realpath 和边界校验后的绝对路径。 */
  absolutePath: string;
}

/**
 * 子代理发现的问题或结论。
 */
export interface Finding {
  /** 严重级别。 */
  severity?: "info" | "low" | "medium" | "high" | "critical";
  /** 问题标题。 */
  title?: string;
  /** 详细说明。 */
  detail?: string;
  /** 关联文件。 */
  file?: string;
  /** 关联行号。 */
  line?: number;
  /** 修复建议。 */
  recommendation?: string;
}

/**
 * 子代理修改过的文件描述。
 */
export interface FileChange {
  /** 文件路径，优先使用相对 cwd 的路径。 */
  path: string;
  /** 文件动作。 */
  action?: "created" | "modified" | "deleted" | "unknown";
  /** 简短说明。 */
  summary?: string;
}

/**
 * 子代理错误码。
 */
export type SubagentErrorCode =
  | "unknown_agent_type"
  | "unsafe_cwd"
  | "path_traversal"
  | "prompt_too_large"
  | "inline_file_too_large"
  | "agent_spawn_failed"
  | "acp_initialize_failed"
  | "acp_session_new_failed"
  | "acp_prompt_failed"
  | "acp_auth_required"
  | "permission_denied"
  | "timeout"
  | "inactivity_timeout"
  | "cancelled"
  | "process_exit_nonzero"
  | "result_parse_failed"
  | "unauthorized_file_change"
  | "concurrency_conflict"
  | "mcp_server_profile_not_allowed"
  | "invalid_input"
  | "internal_error";

/**
 * 子代理错误对象。
 */
export interface SubagentError {
  /** 机器可读错误码。 */
  code: SubagentErrorCode;
  /** 是否建议重试。 */
  recoverable: boolean;
  /** 给主 agent 和用户看的简短错误。 */
  user_message: string;
  /** 本地调试信息，默认不返回过长内容。 */
  debug_message?: string;
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
 * 子代理工具调用摘要。
 */
export interface ToolCallSummary {
  /** ACP tool call id。 */
  id?: string;
  /** 工具标题或名称。 */
  title?: string;
  /** 工具类型。 */
  kind?: string;
  /** 当前状态。 */
  status?: string;
}

/**
 * 子代理运行指标。
 */
export interface SubagentRunMetrics {
  /** 任务耗时，单位为毫秒。 */
  elapsed_ms: number;
  /** 返回给主 agent 的 result 字符数。 */
  returned_result_chars?: number;
  /** 原始 result 字符数。 */
  original_result_chars?: number;
}

/**
 * 子代理运行产物路径。
 */
export interface SubagentRunArtifacts {
  /** 本次运行目录。 */
  run_dir?: string;
  /** 脱敏事件日志路径。 */
  event_log?: string;
  /** 脱敏 stderr 日志路径。 */
  stderr_log?: string;
  /** 结果 JSON 路径。 */
  result_json?: string;
}

/**
 * 子代理任务运行结果。
 */
export interface SubagentRunOutput {
  /** 输出 schema 版本，便于后续兼容升级。 */
  schema_version: 1;
  /** 任务最终状态。 */
  status: SubagentRunStatus;
  /** 实际调用的子代理类型。 */
  agent_type: string;
  /** ACP session id。 */
  session_id?: string;
  /** 一句话总结，供主 agent 快速判断结果。 */
  summary: string;
  /** 子代理返回的主要结果，默认会截断。 */
  result: string;
  /** 高价值 findings，默认最多返回若干条。 */
  findings?: Finding[];
  /** 子代理声明或 MCP Server 观测到的文件变更。 */
  files_changed?: FileChange[];
  /** 风险说明。 */
  risks?: string[];
  /** 下一步建议。 */
  next_steps?: string[];
  /** 完整结构化结果，默认仅 full 模式或显式请求时返回。 */
  structured?: SubagentStructuredResult;
  /** ACP prompt turn 的停止原因。 */
  stop_reason?: string;
  /** 运行指标。 */
  metrics: SubagentRunMetrics;
  /** 本地日志和结果产物路径。 */
  artifacts?: SubagentRunArtifacts;
  /** 本次 prompt 注入的 Skill 摘要；只包含名称，不包含完整内容。 */
  skills?: { mode: SubagentSkillMode; names: string[]; truncated?: boolean };
  /** 诊断信息，默认不返回。 */
  diagnostics?: {
    /** 子代理执行过程中的工具调用摘要。 */
    tool_calls?: ToolCallSummary[];
    /** 子代理触碰过的文件列表。 */
    files_touched?: string[];
  };
  /** 是否发生了内容截断。 */
  truncated?: boolean;
  /** 错误列表。 */
  errors: SubagentError[];
}

/**
 * 有状态子代理任务在 MCP Server 内部和对外查询时使用的状态。
 */
export type SubagentTaskState =
  | "created"
  | "starting"
  | "running"
  | "waiting_permission"
  | "cancelling"
  | "completed"
  | "failed"
  | "partial"
  | "timeout"
  | "cancelled"
  | "closed";

/**
 * 并行任务的文件冲突处理策略。
 */
export type ConflictPolicy = "allow_readonly_parallel" | "single_writer_per_cwd" | "sandbox_worktree";

/**
 * 启动一个有状态子代理任务的输入参数。
 */
export interface SubagentStartInput extends SubagentRunInput {
  /** 是否在任务完成后保留 ACP session，以支持后续 continue。 */
  keep_alive?: boolean;
  /** 本任务单独指定的冲突策略；未指定时使用配置默认值。 */
  conflict_policy?: ConflictPolicy;
}

/**
 * 启动子代理任务后的返回结果。
 */
export interface SubagentStartOutput {
  /** 输出 schema 版本。 */
  schema_version: 1;
  /** 启动状态。 */
  status: "started";
  /** MCP Server 生成的任务 ID。 */
  task_id: string;
  /** 实际调用的子代理类型。 */
  agent_type: string;
  /** ACP session id。 */
  session_id?: string;
  /** 任务创建时间。 */
  created_at: string;
  /** 当前任务状态。 */
  task_status: SubagentTaskState;
  /** 一句话摘要，用于 MCP text content。 */
  summary: string;
}

/**
 * 批量启动多个子代理任务的单项输入。
 */
export interface SubagentStartManyItem extends Omit<SubagentStartInput, "conflict_policy"> {
  /** 单项任务是否保留 session。 */
  keep_alive?: boolean;
}

/**
 * 批量启动多个子代理任务的输入参数。
 *
 * 启动阶段会按 tasks 顺序逐个完成初始化；启动成功后的任务在后台并发运行。
 */
export interface SubagentStartManyInput {
  /** 要并行启动的任务列表。 */
  tasks: SubagentStartManyItem[];
  /** 文件冲突处理策略。 */
  conflict_policy?: ConflictPolicy;
  /** 单个任务失败后，其他任务如何处理。 */
  on_task_failure?: "keep_others_running" | "cancel_all";
}

/**
 * 批量启动多个子代理任务后的返回结果。
 *
 * 返回 started 只表示任务已进入后台运行，不表示任务已经完成。
 */
export interface SubagentStartManyOutput {
  /** 输出 schema 版本。 */
  schema_version: 1;
  /** 启动状态。 */
  status: "started" | "partial";
  /** 已启动任务。 */
  started: SubagentStartOutput[];
  /** 被拒绝或启动失败的任务。 */
  rejected: Array<{
    /** 输入数组下标。 */
    index: number;
    /** 传入的 agent 类型。 */
    agent_type?: string;
    /** 失败原因。 */
    reason: string;
    /** 错误码。 */
    error_code: SubagentErrorCode;
  }>;
  /** 一句话摘要。 */
  summary: string;
}

/**
 * 等待一个或多个子代理任务的输入参数。
 */
export interface SubagentWaitInput {
  /** 要等待的任务 ID 列表。 */
  task_ids: string[];
  /** 等待返回策略。 */
  return_when:
    | "all_completed"
    | "first_completed"
    | "first_success"
    | "first_failure"
    | "any_update"
    | "timeout_partial";
  /** 本次等待最大时间，单位秒。 */
  timeout_secs?: number;
  /** 等待超时后如何处理未完成任务。 */
  on_timeout?: "keep_running" | "cancel_pending";
}

/**
 * 等待子代理任务后的返回结果。
 */
export interface SubagentWaitOutput {
  /** 输出 schema 版本。 */
  schema_version: 1;
  /** 等待结果状态。 */
  status: "completed" | "partial" | "timeout";
  /** 已成功或部分完成的任务结果。 */
  completed: Array<SubagentRunOutput & { task_id?: string }>;
  /** 已失败、超时或取消的任务结果。 */
  failed: Array<SubagentRunOutput & { task_id?: string }>;
  /** 仍在运行或等待的任务 ID。 */
  pending_task_ids: string[];
  /** 已取消的任务 ID。 */
  cancelled_task_ids: string[];
  /** 本次等待耗时，单位毫秒。 */
  elapsed_ms: number;
  /** 一句话摘要。 */
  summary: string;
}

/**
 * 获取子代理任务结果的输入参数。
 */
export interface SubagentResultInput {
  /** 要查询的任务 ID。 */
  task_id: string;
  /** 是否包含事件日志片段。默认 false。 */
  include_events?: boolean;
  /** 是否包含原始输出。默认 false。 */
  include_raw_output?: boolean;
  /** 部分输出或日志片段最大字符数。 */
  max_chars?: number;
}

/**
 * 子代理任务当前结果。
 */
export interface SubagentResultOutput {
  /** 输出 schema 版本。 */
  schema_version: 1;
  /** 任务 ID。 */
  task_id: string;
  /** 子代理类型。 */
  agent_type: string;
  /** 当前任务状态。 */
  status: SubagentTaskState;
  /** 当前最新摘要。 */
  latest_summary?: string;
  /** 最终结果，如果任务已经进入终态。 */
  result?: SubagentRunOutput;
  /** 仍在运行时的部分输出，默认截断。 */
  partial_output?: string;
  /** 本地事件日志路径。 */
  raw_event_log_path?: string;
  /** 可选事件日志片段。 */
  events_tail?: string;
  /** 一句话摘要。 */
  summary: string;
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
  /** 继续对话模式。 */
  mode?: "revise" | "fix" | "clarify" | "continue" | "custom";
  /** 本轮最大运行时间，单位秒。 */
  timeout_secs?: number;
  /** 本轮无有效输出时的最大等待时间，单位秒。 */
  inactivity_timeout_secs?: number;
  /** 本轮新增 Skill 桥接选项；不传时复用初始 session 中已注入的 Skill 上下文。 */
  skills?: SubagentSkillOptions;
  /** 输出压缩选项。 */
  output?: SubagentOutputOptions;
}

/**
 * 继续对话启动后的返回结果。
 */
export interface SubagentContinueOutput {
  /** 输出 schema 版本。 */
  schema_version: 1;
  /** 启动状态。 */
  status: "started";
  /** 任务 ID。 */
  task_id: string;
  /** 新的一轮 prompt turn ID。 */
  turn_id: string;
  /** ACP session id。 */
  session_id: string;
  /** 创建时间。 */
  created_at: string;
  /** 一句话摘要。 */
  summary: string;
}

/**
 * 取消一个或多个子代理任务的输入参数。
 */
export interface SubagentCancelInput {
  /** 要取消的任务 ID 列表。 */
  task_ids: string[];
  /** 取消原因。 */
  reason?: string;
}

/**
 * 取消任务后的返回结果。
 */
export interface SubagentCancelOutput {
  /** 输出 schema 版本。 */
  schema_version: 1;
  /** 取消状态。 */
  status: "cancelled" | "partial" | "failed";
  /** 已取消任务。 */
  cancelled_task_ids: string[];
  /** 调用时已经处于终态的任务。 */
  already_terminal_task_ids: string[];
  /** 取消失败列表。 */
  failed: SubagentError[];
  /** 一句话摘要。 */
  summary: string;
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
 * 关闭任务后的返回结果。
 */
export interface SubagentCloseOutput {
  /** 输出 schema 版本。 */
  schema_version: 1;
  /** 关闭状态。 */
  status: "closed";
  /** 任务 ID。 */
  task_id: string;
  /** 关闭时间。 */
  closed_at: string;
  /** 一句话摘要。 */
  summary: string;
}

/**
 * 读取子代理日志的输入参数。
 */
export interface SubagentLogsInput {
  /** 要读取日志的任务 ID。 */
  task_id: string;
  /** 日志类型。 */
  log_type?: "events" | "stderr" | "result" | "prompt" | "task";
  /** 最大读取字节数。 */
  max_bytes?: number;
  /** 是否二次脱敏。默认 true。 */
  redacted?: boolean;
}

/**
 * 读取子代理日志后的输出参数。
 */
export interface SubagentLogsOutput {
  /** 输出 schema 版本。 */
  schema_version: 1;
  /** 任务 ID。 */
  task_id: string;
  /** 日志类型。 */
  log_type: "events" | "stderr" | "result" | "prompt" | "task";
  /** 日志内容，默认截断。 */
  content: string;
  /** 是否发生截断。 */
  truncated: boolean;
  /** 一句话摘要。 */
  summary: string;
}

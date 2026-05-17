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
  /** 成功标准，用于帮助主代理判断是否需要打回重写。 */
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
 * 并行任务的文件冲突处理策略。
 */
export type ConflictPolicy = "allow_readonly_parallel" | "single_writer_per_cwd" | "sandbox_worktree";

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
  /** 本任务单独指定的冲突策略；未指定时使用配置默认值。 */
  conflict_policy?: ConflictPolicy;
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
  /** 本次运行的 task id。可用于后续 subagent_revise。 */
  task_id?: string;
  /** 原始任务标题，便于主 agent 做审核和打回。 */
  title?: string;
  /** 如果本次是重写，记录被打回的原 task id。 */
  revision_of_task_id?: string;
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
 * 有状态子代理任务在 MCP Server 内部使用的状态。
 * 外部 MCP 接口不再暴露异步查询/等待接口；该状态仅用于同步调用期间清理。
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
 * 批量运行多个子代理任务的单项输入。
 */
export type SubagentRunManyItem = Omit<SubagentRunInput, "conflict_policy">;

/**
 * 同步批量运行多个子代理任务的输入参数。
 */
export interface SubagentRunManyInput {
  /** 要并行运行的任务列表。 */
  tasks: SubagentRunManyItem[];
  /** 文件冲突处理策略。 */
  conflict_policy?: ConflictPolicy;
  /** 启动阶段单个任务失败后，其他已启动任务如何处理。 */
  on_task_failure?: "keep_others_running" | "cancel_all";
}

/**
 * 批量子代理结果，带输入下标。
 */
export type SubagentIndexedRunOutput = SubagentRunOutput & { index: number; task_id: string; title: string };

/**
 * 批量启动阶段拒绝项。
 */
export interface SubagentRejectedItem {
  /** 输入数组下标。 */
  index: number;
  /** 传入的 agent 类型。 */
  agent_type?: string;
  /** 失败原因。 */
  reason: string;
  /** 错误码。 */
  error_code: SubagentErrorCode;
}

/**
 * 同步批量运行多个子代理任务后的返回结果。
 */
export interface SubagentRunManyOutput {
  /** 输出 schema 版本。 */
  schema_version: 1;
  /** 批量结果状态。 */
  status: "completed" | "partial" | "failed" | "cancelled";
  /** 成功或部分完成的任务结果。 */
  completed: SubagentIndexedRunOutput[];
  /** 失败、超时或取消的任务结果。 */
  failed: SubagentIndexedRunOutput[];
  /** 启动阶段被拒绝或失败的任务。 */
  rejected: SubagentRejectedItem[];
  /** 已取消的任务 ID。 */
  cancelled_task_ids: string[];
  /** 本批任务耗时，单位毫秒。 */
  elapsed_ms: number;
  /** 一句话摘要。 */
  summary: string;
}

/**
 * 打回重写说明。
 */
export interface SubagentRevisionCorrection {
  /** 主 agent 为什么拒绝上一轮结果。 */
  reason: string;
  /** 被拒绝的上一轮结果摘要；不传时会从 task_id 指向的上一轮结果中提取。 */
  rejected_result?: string;
  /** 主 agent 期望如何修正。 */
  expected_change?: string;
}

/**
 * 同步打回重写输入。
 *
 * 推荐传 task_id：服务端会复用同一轮同步调用留下的任务元数据，但不会复用或保留
 * 子代理进程。若 MCP Server 已重启，可改为同时传 task 和 previous_result。
 */
export interface SubagentReviseInput {
  /** 被打回的 task id。来自 subagent_run/subagent_run_many 的结果。 */
  task_id?: string;
  /** 原始任务；当 task_id 不可用或需要覆盖任务描述时传入。 */
  task?: SubagentTask;
  /** 上一轮被拒绝的完整或摘要结果；不传时从 task_id 的结果中提取。 */
  previous_result?: string;
  /** 主 agent 的打回说明。 */
  correction: SubagentRevisionCorrection;
  /** 额外给子代理的重写指令。 */
  message?: string;
  /** 本轮新增或覆盖的文件列表。 */
  additional_files?: TaskFile[];
  /** 可覆盖原任务运行目录。未传时优先使用 task_id 的 cwd。 */
  cwd?: string;
  /** 可覆盖原任务 agent。未传时优先使用 task_id 的 agent_type。 */
  agent_type?: string;
  /** 本轮最大运行时间，单位秒。 */
  timeout_secs?: number;
  /** 本轮无有效输出时的最大等待时间，单位秒。 */
  inactivity_timeout_secs?: number;
  /** 本轮运行模式。默认 custom。 */
  mode?: SubagentMode;
  /** 允许连接的 MCP server profile 名称。 */
  mcp_server_profiles?: string[];
  /** 父代理 Skill 桥接选项。 */
  skills?: SubagentSkillOptions;
  /** 输出压缩选项。 */
  output?: SubagentOutputOptions;
  /** 本任务单独指定的冲突策略。 */
  conflict_policy?: ConflictPolicy;
}

/**
 * 批量打回重写的单项输入。
 */
export type SubagentReviseManyItem = Omit<SubagentReviseInput, "conflict_policy">;

/**
 * 同步批量打回重写输入。
 */
export interface SubagentReviseManyInput {
  /** 要并行重写的任务列表。 */
  revisions: SubagentReviseManyItem[];
  /** 文件冲突处理策略。 */
  conflict_policy?: ConflictPolicy;
  /** 启动阶段单个重写任务失败后，其他已启动任务如何处理。 */
  on_task_failure?: "keep_others_running" | "cancel_all";
}

/**
 * 同步批量打回重写输出。
 */
export interface SubagentReviseManyOutput extends SubagentRunManyOutput {}

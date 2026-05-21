/**
 * ACP 子代理 MCP Server 的完整配置。
 *
 * 配置来自 agents.toml，所有会影响安全、并发、超时和子代理命令的选项
 * 都集中在该对象中，避免 MCP 工具调用者直接传入 command 或 env。
 */
export interface ServerConfig {
  /** 默认运行参数。 */
  defaults: DefaultsConfig;

  /** 安全边界配置。 */
  security: SecurityConfig;

  /** 并发与文件写冲突配置。 */
  concurrency: ConcurrencyConfig;

  /** 会话池配置。 */
  session_pool: SessionPoolConfig;

  /** 权限策略配置，key 为 default 或 agent_type。 */
  permissions: Record<string, PermissionPolicy>;

  /** 子代理定义，key 为 agent_type。 */
  agents: Record<string, AgentConfig>;

  /** 当前配置文件路径，用于日志和排错。 */
  configPath: string;
}

/**
 * 默认运行参数。
 */
export interface DefaultsConfig {
  /** 整个任务默认最大运行时间，单位为秒。 */
  timeout_secs: number;

  /** 默认无有效输出超时时间，单位为秒。 */
  inactivity_timeout_secs: number;

  /** 默认主代理心跳失联自关闭时间，单位为秒。 */
  heartbeat_timeout_secs: number;

  /** 默认最大递归代理深度。 */
  max_depth: number;

  /** 单次 prompt 最大字符数。 */
  max_prompt_chars: number;

  /** 单个 inline/snippet 文件最大字符数。 */
  max_inline_file_chars: number;

  /** 工具返回给主代理的最大字符数。 */
  max_tool_output_chars: number;

  /** 默认输出详情级别。 */
  default_detail_level: "summary" | "normal" | "verbose";

  /** 运行日志目录。 */
  log_dir: string;

  /** 活跃 session 最大保留时间，单位为秒。 */
  session_ttl_secs: number;

  /** 已完成 session 最大保留时间，单位为秒。 */
  completed_session_ttl_secs: number;

  /** 最大活跃 session 数。 */
  max_active_sessions: number;
}

/**
 * 安全边界配置。
 */
export interface SecurityConfig {
  /** 允许作为 cwd 的根目录列表。 */
  allowed_cwd_roots: string[];

  /** 是否允许子代理联网，MVP 中仅用于权限策略和提示。 */
  allow_network: boolean;
}

/**
 * 并发控制配置。
 */
export interface ConcurrencyConfig {
  /** 最大并行任务数。 */
  max_parallel_tasks: number;

  /** 默认文件冲突策略。 */
  default_conflict_policy: "allow_readonly_parallel" | "single_writer_per_cwd" | "sandbox_worktree";
}

/**
 * 会话池配置。
 */
export interface SessionPoolConfig {
  /** 是否启用会话池。 */
  enabled: boolean;

  /** 每个父代理最多可保留多少个池化 session。 */
  max_pooled_sessions_per_parent: number;

  /** 最大上下文用量比例，超过后不再入池。 */
  max_context_usage_ratio: number;

  /** 空闲 session 过期时间，单位为秒。 */
  idle_ttl_secs: number;

  /** 默认复用策略。 */
  reuse_policy: "auto" | "disable" | "force_new";
}

/**
 * 单项权限决策。
 */
export type PermissionDecision = "allow" | "deny" | "cancel";

/**
 * 子代理权限策略。
 */
export interface PermissionPolicy {
  /** 是否允许读取文件。 */
  read: PermissionDecision;

  /** 是否允许搜索文件。 */
  search: PermissionDecision;

  /** 是否允许编辑文件。 */
  edit: PermissionDecision;

  /** 是否允许执行命令。 */
  execute: PermissionDecision;

  /** 是否允许联网。 */
  network: PermissionDecision;
}

/**
 * 单个 ACP agent 的配置。
 */
export interface AgentConfig {
  /** 面向主代理展示的描述。 */
  description: string;

  /** 子代理启动命令，只能来自配置文件，不能来自工具输入。 */
  command: string;

  /** 子代理启动参数。 */
  args: string[];

  /** 子代理能力标签。 */
  capabilities: string[];

  /** 任务 prompt 前置系统说明。 */
  system_prompt?: string;

  /** 子代理专属环境变量，日志中必须脱敏。 */
  env?: Record<string, string>;

  /** 子代理专属主代理心跳失联自关闭时间，单位为秒。 */
  heartbeat_timeout_secs?: number;

  /** 子代理专属任务超时，单位为秒。 */
  timeout_secs?: number;

  /** 子代理专属无进展超时，单位为秒。 */
  inactivity_timeout_secs?: number;
}

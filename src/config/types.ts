/**
 * 权限决策值。
 */
export type PermissionDecision = "allow" | "deny" | "ask";

/**
 * 子代理权限策略。
 */
export interface PermissionPolicy {
  /** 是否允许读取文件。 */
  read: PermissionDecision;
  /** 是否允许搜索。 */
  search: PermissionDecision;
  /** 是否允许编辑文件。 */
  edit: PermissionDecision;
  /** 是否允许执行命令。 */
  execute: PermissionDecision;
  /** 是否允许联网。 */
  network: PermissionDecision;
}

/**
 * agent env 配置项。字符串会直接传入；对象会从宿主环境读取。
 */
export type AgentEnvValue = string | { from_env: string };

/**
 * 子代理环境变量继承策略。
 *
 * all：继承 MCP Server 进程可见的所有环境变量，再叠加显式 env。
 * allowlist：只继承 env_allowlist 命中的环境变量，再叠加显式 env。
 * none：只传最小运行环境和显式 env。
 */
export type AgentEnvPolicy = "all" | "allowlist" | "none";

/**
 * 单个 ACP agent 配置。
 */
export interface AgentConfig {
  /** 子代理描述，只会向主 agent 暴露此字段和能力列表。 */
  description: string;
  /** 启动命令。来自配置文件或受信环境变量，不能由 MCP tool caller 覆盖。 */
  command: string;
  /** 启动参数。来自配置文件或受信环境变量，不能由 MCP tool caller 覆盖。 */
  args: string[];
  /** 能力标签，用于主 agent 选择子代理。 */
  capabilities: string[];
  /** 注入到子代理任务 prompt 的系统提示词。 */
  system_prompt?: string;
  /** 子进程环境变量继承策略。默认 all，保证子代理可以复用用户已有 CLI 登录和配置。 */
  env_policy?: AgentEnvPolicy;
  /**
   * allowlist 策略下允许继承的宿主环境变量。
   *
   * 支持精确变量名，例如 ANTHROPIC_API_KEY；也支持前缀通配，例如 ANTHROPIC_*。
   */
  env_allowlist?: string[];
  /** 传给子进程的显式环境变量；未设置的 from_env 不会写入子进程环境。 */
  env?: Record<string, AgentEnvValue>;
  /** 当命令不存在或启动失败时给用户看的安装提示。 */
  install_hint?: string;
}

/**
 * 默认运行参数。
 */
export interface DefaultsConfig {
  /** 默认子代理名称。未在 tool input 中传 agent_type 时使用。 */
  default_agent: string;
  /** 默认 wall-clock timeout，单位秒。 */
  timeout_secs: number;
  /** 默认 inactivity timeout，单位秒。 */
  inactivity_timeout_secs: number;
  /** 子代理递归深度上限。 */
  max_depth: number;
  /** prompt 最大字符数。 */
  max_prompt_chars: number;
  /** inline/snippet 文件内容最大字符数。 */
  max_inline_file_chars: number;
  /** 日志目录，相对 cwd 时写入项目内。 */
  log_dir: string;
  /** session TTL。 */
  session_ttl_secs: number;
  /** 完成后 session TTL。 */
  completed_session_ttl_secs: number;
  /** 最大活跃任务数。 */
  max_active_sessions: number;
  /** ACP cancel 后等待 agent 自行停止的毫秒数。 */
  acp_cancel_grace_ms: number;
  /** SIGTERM 后等待 SIGKILL 的毫秒数。 */
  process_kill_grace_ms: number;
}

/**
 * 安全配置。
 */
export interface SecurityConfig {
  /**
   * 严格工作区根目录列表。为空且 auto_workspace_roots=true 时，默认信任本次 tool 输入的 cwd 作为工作区。
   */
  allowed_cwd_roots: string[];
  /** 是否在未配置严格根目录时，自动把本次 cwd 视为当前工作区根目录。 */
  auto_workspace_roots: boolean;
  /** 策略声明：是否允许网络。本项目不提供 OS 级网络隔离。 */
  allow_network: boolean;
  /** ACP fs/read_text_file 单次最大读取字节数。 */
  max_read_file_bytes: number;
  /** 是否要求 agent command 必须是绝对路径。 */
  require_absolute_agent_command: boolean;
}

/**
 * 并发配置。
 */
export interface ConcurrencyConfig {
  /** 最大并发任务数。 */
  max_parallel_tasks: number;
  /** 默认文件冲突策略。 */
  default_conflict_policy: "allow_readonly_parallel" | "single_writer_per_cwd" | "sandbox_worktree";
}

/**
 * git worktree 沙箱配置。
 */
export interface WorktreeConfig {
  /** 是否允许 sandbox_worktree 策略。 */
  enabled: boolean;
  /** worktree 基础目录；相对路径会相对原始 cwd 解析。 */
  base_dir: string;
  /** 失败时是否保留 worktree 便于调试。 */
  keep_on_failure: boolean;
  /** 成功时是否保留 worktree。 */
  keep_on_success: boolean;
  /** 返回 patch 文件最大字节数。 */
  max_patch_bytes: number;
  /** 是否复制未跟踪文件。 */
  include_untracked: boolean;
}

/**
 * 日志配置。
 */
export interface LogsConfig {
  /** 是否启用日志。 */
  enabled: boolean;
  /** 是否脱敏日志。 */
  redact: boolean;
  /** 日志保留天数，当前版本只保存配置，不自动清理。 */
  retention_days: number;
  /** 事件日志最大字节数。 */
  max_event_bytes: number;
  /** stderr 日志最大字节数。 */
  max_stderr_bytes: number;
  /** prompt 保存策略。 */
  save_rendered_prompt: "off" | "redacted" | "raw";
  /** 日志文件权限。 */
  file_mode: "0600";
}

/**
 * 主 agent skill 桥接配置。
 *
 * MCP Server 无法直接读取宿主应用的私有运行时 Skills。这里的能力是
 * 通过扫描项目级 `.claude/skills`、用户级 `~/.claude/skills` 或额外目录，
 * 把 Skill 清单或指定 SKILL.md 低成本注入给 ACP 子代理。
 */
export interface SkillsConfig {
  /** 是否启用 skill 桥接。 */
  enabled: boolean;
  /** 默认注入模式：off 不注入；list 只列清单；inline 内联指定 SKILL.md。 */
  default_mode: "off" | "list" | "inline";
  /** 是否扫描项目级 `.claude/skills`。 */
  include_project_skills: boolean;
  /** 是否扫描用户级 `~/.claude/skills`。 */
  include_user_skills: boolean;
  /** 额外 Skill 根目录。 */
  discovery_roots: string[];
  /** inline 模式默认内联的 Skill 名称。 */
  default_names: string[];
  /** list 模式最多列出的 Skill 数。 */
  max_skills: number;
  /** 单个 Skill 描述最大字符数。 */
  max_description_chars: number;
  /** 单个内联 SKILL.md 最大字符数。 */
  max_skill_chars: number;
  /** 单次 prompt 内联 Skill 总字符数上限。 */
  max_total_skill_chars: number;
}

/**
 * MCP server profile。只允许通过名称引用这些 profile。
 */
export interface McpServerProfile {
  /** 是否启用该 profile。 */
  enabled: boolean;
  /** 传输类型。 */
  transport: "stdio" | "http" | "sse";
  /** 启动命令，必须来自配置文件或受信环境变量。 */
  command?: string;
  /** 启动参数。 */
  args?: string[];
  /** HTTP URL，后续版本使用。 */
  url?: string;
  /** 允许使用该 profile 的 agent 名称。 */
  allowed_agents?: string[];
  /** profile 自己的 env 白名单。 */
  env?: Record<string, AgentEnvValue>;
}

/**
 * 配置来源。
 */
export type ConfigSourceKind = "file" | "defaults";

/**
 * 完整配置结构。
 */
export interface AppConfig {
  /** 配置文件绝对路径；使用默认配置时为 <defaults>。 */
  configPath: string;
  /** 配置来源。 */
  configSource: ConfigSourceKind;
  /** 默认运行参数。 */
  defaults: DefaultsConfig;
  /** 安全配置。 */
  security: SecurityConfig;
  /** 并发配置。 */
  concurrency: ConcurrencyConfig;
  /** 日志配置。 */
  logs: LogsConfig;
  /** worktree 沙箱配置。 */
  worktree: WorktreeConfig;
  /** 主 agent skill 桥接配置。 */
  skills: SkillsConfig;
  /** 权限配置。 */
  permissions: Record<string, PermissionPolicy>;
  /** 子代理配置。 */
  agents: Record<string, AgentConfig>;
  /** MCP server profiles。 */
  mcp_servers: Record<string, McpServerProfile>;
}

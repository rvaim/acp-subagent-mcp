import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import type {
  AgentConfig,
  AppConfig,
  ConcurrencyConfig,
  DefaultsConfig,
  LogsConfig,
  McpServerProfile,
  PermissionPolicy,
  SecurityConfig,
  SkillsConfig,
  WorktreeConfig
} from "./types.js";

/** 默认权限策略：只读、可搜索、不可编辑、不可执行、不可联网。 */
const defaultPermissionPolicy: PermissionPolicy = {
  read: "allow",
  search: "allow",
  edit: "deny",
  execute: "deny",
  network: "deny"
};

/** 默认 Claude 权限策略：允许编辑，但仍默认禁止执行命令和网络。 */
const defaultClaudePermissionPolicy: PermissionPolicy = {
  ...defaultPermissionPolicy,
  edit: "allow"
};

/** 默认运行配置。 */
const defaultDefaults: DefaultsConfig = {
  default_agent: "claude",
  timeout_secs: 600,
  inactivity_timeout_secs: 15,
  max_depth: 2,
  max_prompt_chars: 120000,
  max_inline_file_chars: 30000,
  log_dir: ".subagents/runs",
  session_ttl_secs: 1800,
  completed_session_ttl_secs: 600,
  max_active_sessions: 4,
  mcp_request_heartbeat_ms: 1000,
  acp_cancel_grace_ms: 500,
  process_kill_grace_ms: 500
};

/** 默认安全配置。 */
const defaultSecurity: SecurityConfig = {
  allowed_cwd_roots: [],
  auto_workspace_roots: true,
  allow_network: false,
  max_read_file_bytes: 1024 * 1024,
  require_absolute_agent_command: false
};

/** 默认并发配置。 */
const defaultConcurrency: ConcurrencyConfig = {
  max_parallel_tasks: 4,
  default_conflict_policy: "single_writer_per_cwd"
};

/** 默认 worktree 配置。 */
const defaultWorktree: WorktreeConfig = {
  enabled: false,
  base_dir: ".subagents/worktrees",
  keep_on_failure: true,
  keep_on_success: false,
  max_patch_bytes: 2_000_000,
  include_untracked: false
};

/** 默认日志配置。 */
const defaultLogs: LogsConfig = {
  enabled: true,
  redact: true,
  retention_days: 7,
  max_event_bytes: 10 * 1024 * 1024,
  max_stderr_bytes: 1024 * 1024,
  save_rendered_prompt: "redacted",
  file_mode: "0600"
};

/** 默认主 agent skill 桥接配置。 */
const defaultSkills: SkillsConfig = {
  enabled: true,
  default_mode: "list",
  include_project_skills: true,
  include_user_skills: true,
  discovery_roots: [],
  default_names: [],
  max_skills: 20,
  max_description_chars: 360,
  max_skill_chars: 8000,
  max_total_skill_chars: 20000
};

/** 配置源定位结果。 */
export interface ResolvedConfigSource {
  /** 配置文件路径。未使用文件时为空。 */
  configPath?: string;
  /** 是否由命令行参数或环境变量显式指定。 */
  explicit: boolean;
}

/** env 配置项校验。 */
const envValueSchema = z.union([
  z.string(),
  z.object({ from_env: z.string().min(1) }).strict()
]);

/** agent 环境变量继承策略校验。旧值会被归一到新语义，便于未升级的本地配置继续工作。 */
const agentEnvPolicySchema = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  return normalizeAgentEnvPolicyValue(value) ?? value;
}, z.enum(["all", "allowlist", "none"]));

/** 权限策略校验。 */
const permissionPolicySchema = z.object({
  read: z.enum(["allow", "deny", "ask"]).default(defaultPermissionPolicy.read),
  search: z.enum(["allow", "deny", "ask"]).default(defaultPermissionPolicy.search),
  edit: z.enum(["allow", "deny", "ask"]).default(defaultPermissionPolicy.edit),
  execute: z.enum(["allow", "deny", "ask"]).default(defaultPermissionPolicy.execute),
  network: z.enum(["allow", "deny", "ask"]).default(defaultPermissionPolicy.network)
}).strict();

/** agent 配置校验。 */
const agentConfigSchema: z.ZodType<AgentConfig> = z.object({
  description: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  capabilities: z.array(z.string()).default([]),
  system_prompt: z.string().optional(),
  env_policy: agentEnvPolicySchema.default("all"),
  env_allowlist: z.array(z.string()).default([]),
  env: z.record(z.string(), envValueSchema).default({}),
  install_hint: z.string().optional()
}).strict();

/** MCP server profile 校验。 */
const mcpServerProfileSchema: z.ZodType<McpServerProfile> = z.object({
  enabled: z.boolean().default(false),
  transport: z.enum(["stdio", "http", "sse"]).default("stdio"),
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  url: z.string().optional(),
  allowed_agents: z.array(z.string()).default([]),
  env: z.record(z.string(), envValueSchema).default({})
}).strict();

/** 完整配置校验。 */
const appConfigSchema = z.object({
  defaults: z.object({
    default_agent: z.string().min(1).default(defaultDefaults.default_agent),
    timeout_secs: z.number().int().positive().default(defaultDefaults.timeout_secs),
    inactivity_timeout_secs: z.number().int().positive().default(defaultDefaults.inactivity_timeout_secs),
    max_depth: z.number().int().min(0).default(defaultDefaults.max_depth),
    max_prompt_chars: z.number().int().positive().default(defaultDefaults.max_prompt_chars),
    max_inline_file_chars: z.number().int().positive().default(defaultDefaults.max_inline_file_chars),
    log_dir: z.string().min(1).default(defaultDefaults.log_dir),
    session_ttl_secs: z.number().int().positive().default(defaultDefaults.session_ttl_secs),
    completed_session_ttl_secs: z.number().int().positive().default(defaultDefaults.completed_session_ttl_secs),
    max_active_sessions: z.number().int().positive().default(defaultDefaults.max_active_sessions),
    mcp_request_heartbeat_ms: z.number().int().min(0).default(defaultDefaults.mcp_request_heartbeat_ms),
    acp_cancel_grace_ms: z.number().int().positive().default(defaultDefaults.acp_cancel_grace_ms),
    process_kill_grace_ms: z.number().int().positive().default(defaultDefaults.process_kill_grace_ms)
  }).default(defaultDefaults),
  security: z.object({
    allowed_cwd_roots: z.array(z.string()).default(defaultSecurity.allowed_cwd_roots),
    auto_workspace_roots: z.boolean().default(defaultSecurity.auto_workspace_roots),
    allow_network: z.boolean().default(defaultSecurity.allow_network),
    max_read_file_bytes: z.number().int().positive().default(defaultSecurity.max_read_file_bytes),
    require_absolute_agent_command: z.boolean().default(defaultSecurity.require_absolute_agent_command)
  }).default(defaultSecurity),
  concurrency: z.object({
    max_parallel_tasks: z.number().int().positive().default(defaultConcurrency.max_parallel_tasks),
    default_conflict_policy: z.enum(["allow_readonly_parallel", "single_writer_per_cwd", "sandbox_worktree"])
      .default(defaultConcurrency.default_conflict_policy)
  }).default(defaultConcurrency),
  logs: z.object({
    enabled: z.boolean().default(defaultLogs.enabled),
    redact: z.boolean().default(defaultLogs.redact),
    retention_days: z.number().int().positive().default(defaultLogs.retention_days),
    max_event_bytes: z.number().int().positive().default(defaultLogs.max_event_bytes),
    max_stderr_bytes: z.number().int().positive().default(defaultLogs.max_stderr_bytes),
    save_rendered_prompt: z.enum(["off", "redacted", "raw"]).default(defaultLogs.save_rendered_prompt),
    file_mode: z.literal("0600").default(defaultLogs.file_mode)
  }).default(defaultLogs),
  worktree: z.object({
    enabled: z.boolean().default(defaultWorktree.enabled),
    base_dir: z.string().min(1).default(defaultWorktree.base_dir),
    keep_on_failure: z.boolean().default(defaultWorktree.keep_on_failure),
    keep_on_success: z.boolean().default(defaultWorktree.keep_on_success),
    max_patch_bytes: z.number().int().positive().default(defaultWorktree.max_patch_bytes),
    include_untracked: z.boolean().default(defaultWorktree.include_untracked)
  }).default(defaultWorktree),
  skills: z.object({
    enabled: z.boolean().default(defaultSkills.enabled),
    default_mode: z.enum(["off", "list", "inline"]).default(defaultSkills.default_mode),
    include_project_skills: z.boolean().default(defaultSkills.include_project_skills),
    include_user_skills: z.boolean().default(defaultSkills.include_user_skills),
    discovery_roots: z.array(z.string()).default(defaultSkills.discovery_roots),
    default_names: z.array(z.string()).default(defaultSkills.default_names),
    max_skills: z.number().int().positive().default(defaultSkills.max_skills),
    max_description_chars: z.number().int().positive().default(defaultSkills.max_description_chars),
    max_skill_chars: z.number().int().positive().default(defaultSkills.max_skill_chars),
    max_total_skill_chars: z.number().int().positive().default(defaultSkills.max_total_skill_chars)
  }).default(defaultSkills),
  permissions: z.record(z.string(), permissionPolicySchema).default({ default: defaultPermissionPolicy }),
  agents: z.record(z.string(), agentConfigSchema).default({}),
  mcp_servers: z.record(z.string(), mcpServerProfileSchema).default({})
}).strict();

/**
 * 读取并校验配置。
 *
 * 未提供配置文件时会使用内置默认配置：默认 agent 为 claude，命令为
 * claude-agent-acp。该命令必须由用户环境提供，本包不会自动安装任何具体子代理 adapter。
 */
export async function loadConfig(configSource?: string | ResolvedConfigSource): Promise<AppConfig> {
  const source = typeof configSource === "string"
    ? { configPath: configSource, explicit: true }
    : configSource ?? await resolveConfigSourceFromArgs([]);

  let parsedInput: unknown;
  let configPath = "<defaults>";
  let sourceKind: AppConfig["configSource"] = "defaults";

  if (source.configPath) {
    const resolvedConfigPath = path.resolve(source.configPath);
    const exists = await fileExists(resolvedConfigPath);
    if (!exists && source.explicit) {
      throw new Error(`配置文件不存在：${resolvedConfigPath}`);
    }
    if (exists) {
      const raw = await readFile(resolvedConfigPath, "utf8");
      parsedInput = parseToml(raw) as unknown;
      configPath = resolvedConfigPath;
      sourceKind = "file";
    }
  }

  const parsed = appConfigSchema.parse(parsedInput ?? {});
  const defaultAgents = buildDefaultAgentsFromEnv();
  const envAgents = parseJsonObjectEnv<Record<string, AgentConfig>>("ACP_SUBAGENT_AGENTS_JSON", {});
  const envMcpServers = parseJsonObjectEnv<Record<string, McpServerProfile>>("ACP_SUBAGENT_MCP_SERVERS_JSON", {});

  const defaults = applyDefaultEnvOverrides({ ...defaultDefaults, ...parsed.defaults });
  const security = applySecurityEnvOverrides({ ...defaultSecurity, ...parsed.security });
  const concurrency = applyConcurrencyEnvOverrides({ ...defaultConcurrency, ...parsed.concurrency });
  const worktree = applyWorktreeEnvOverrides({ ...defaultWorktree, ...parsed.worktree });
  const logs = applyLogsEnvOverrides({ ...defaultLogs, ...parsed.logs });
  const skills = applySkillsEnvOverrides({ ...defaultSkills, ...parsed.skills });
  const permissions: Record<string, PermissionPolicy> = {
    default: defaultPermissionPolicy,
    claude: defaultClaudePermissionPolicy,
    ...parsed.permissions
  };
  const agents = normalizeAgentConfigs({
    ...defaultAgents,
    ...(parsed.agents as Record<string, AgentConfig>),
    ...envAgents
  });
  const mcpServers: Record<string, McpServerProfile> = {
    ...(parsed.mcp_servers as Record<string, McpServerProfile>),
    ...envMcpServers
  };

  if (!agents[defaults.default_agent]) {
    throw new Error(`默认子代理不存在：${defaults.default_agent}`);
  }

  return {
    configPath,
    configSource: sourceKind,
    defaults,
    security,
    concurrency,
    logs,
    worktree,
    skills,
    permissions,
    agents,
    mcp_servers: mcpServers
  };
}

/**
 * 根据命令行和环境变量解析配置来源。
 *
 * 优先级：--config、ACP_SUBAGENT_CONFIG、当前目录 agents.toml、内置默认配置。
 */
export async function resolveConfigSourceFromArgs(argv: string[]): Promise<ResolvedConfigSource> {
  const configFlagIndex = argv.findIndex((value) => value === "--config" || value === "-c");
  if (configFlagIndex >= 0 && argv[configFlagIndex + 1]) {
    return { configPath: argv[configFlagIndex + 1], explicit: true };
  }

  if (process.env.ACP_SUBAGENT_CONFIG) {
    return { configPath: process.env.ACP_SUBAGENT_CONFIG, explicit: true };
  }

  const localConfigPath = path.resolve("agents.toml");
  if (await fileExists(localConfigPath)) {
    return { configPath: localConfigPath, explicit: false };
  }

  return { explicit: false };
}

/**
 * 兼容旧调用方式：只返回配置路径或默认文件名。
 */
export function resolveConfigPathFromArgs(argv: string[]): string {
  const configFlagIndex = argv.findIndex((value) => value === "--config" || value === "-c");
  if (configFlagIndex >= 0 && argv[configFlagIndex + 1]) return argv[configFlagIndex + 1];
  return process.env.ACP_SUBAGENT_CONFIG ?? "agents.toml";
}

/**
 * 构造默认子代理配置。
 *
 * 默认名称是 claude，但配置入口保持通用：
 * - ACP_SUBAGENT_DEFAULT_AGENT 指定默认 agent 名称。
 * - ACP_SUBAGENT_DEFAULT_AGENT_COMMAND 指定默认 agent 命令。
 * - ACP_SUBAGENT_DEFAULT_AGENT_ARGS 指定默认 agent 参数。
 */
function buildDefaultAgentsFromEnv(): Record<string, AgentConfig> {
  const defaultAgentName = process.env.ACP_SUBAGENT_DEFAULT_AGENT?.trim() || "claude";
  const command = process.env.ACP_SUBAGENT_DEFAULT_AGENT_COMMAND?.trim() || inferDefaultAgentCommand(defaultAgentName);
  const args = parseArgsEnv("ACP_SUBAGENT_DEFAULT_AGENT_ARGS", inferDefaultAgentArgs(defaultAgentName));
  const envFromJson = parseJsonObjectEnv<Record<string, string | { from_env: string }>>("ACP_SUBAGENT_DEFAULT_AGENT_ENV_JSON", {});

  return {
    [defaultAgentName]: {
      description: `默认 ${defaultAgentName} ACP 子代理。`,
      command,
      args,
      capabilities: inferDefaultAgentCapabilities(defaultAgentName),
      system_prompt: `你是一个被父代理调用的 ${defaultAgentName} 子代理。严格遵守任务边界，只返回最终结果，不输出隐藏推理。`,
      env_policy: parseAgentEnvPolicyEnv("ACP_SUBAGENT_ENV_POLICY", "all"),
      env_allowlist: parseListEnv("ACP_SUBAGENT_ENV_ALLOWLIST", []),
      env: envFromJson,
      install_hint: `未找到默认 ${defaultAgentName} ACP 子代理命令：${command}。请确认该命令已在 PATH 中；或设置 ACP_SUBAGENT_DEFAULT_AGENT_COMMAND 为可执行文件绝对路径；或创建 agents.toml 自定义 [agents.${defaultAgentName}]。本包不会自动安装具体子代理 adapter。`
    }
  };
}

/**
 * 根据常见 agent 名称推断默认 ACP 命令。
 */
function inferDefaultAgentCommand(agentName: string): string {
  if (agentName === "claude") return "claude-agent-acp";
  if (agentName === "codex") return "codex-acp";
  if (agentName === "gemini") return "gemini";
  return `${agentName}-acp`;
}

/**
 * 根据常见 agent 名称推断默认 ACP 参数。
 */
function inferDefaultAgentArgs(agentName: string): string[] {
  if (agentName === "gemini") return ["--acp"];
  return [];
}

/**
 * 根据默认 agent 名称生成简短能力标签。
 */
function inferDefaultAgentCapabilities(agentName: string): string[] {
  const base = [agentName, "code", "review", "analysis", "edit"];
  return Array.from(new Set(base));
}

/**
 * 归一化所有 agent 的环境变量继承配置。
 *
 * 这样通过 ACP_SUBAGENT_AGENTS_JSON 增加的 agent 也会获得默认 all 策略，
 * 同时只保留全局 ACP_SUBAGENT_ENV_POLICY / ACP_SUBAGENT_ENV_ALLOWLIST 作为环境变量入口。
 * 如需按 agent 单独配置，请使用 agents.toml 或 ACP_SUBAGENT_AGENTS_JSON，避免为某个具体 agent 暴露专用环境变量。
 */
function normalizeAgentConfigs(agents: Record<string, AgentConfig>): Record<string, AgentConfig> {
  const globalPolicy = normalizeAgentEnvPolicyValue(process.env.ACP_SUBAGENT_ENV_POLICY?.trim());
  const globalAllowlist = parseOptionalListEnv("ACP_SUBAGENT_ENV_ALLOWLIST");
  const normalized: Record<string, AgentConfig> = {};

  for (const [name, agent] of Object.entries(agents)) {
    normalized[name] = {
      ...agent,
      env_policy: globalPolicy ?? normalizeAgentEnvPolicyValue(agent.env_policy as string | undefined) ?? "all",
      env_allowlist: globalAllowlist ?? agent.env_allowlist ?? []
    };
  }

  return normalized;
}

/**
 * 应用 defaults 环境变量覆盖。
 */
function applyDefaultEnvOverrides(config: DefaultsConfig): DefaultsConfig {
  return {
    ...config,
    default_agent: process.env.ACP_SUBAGENT_DEFAULT_AGENT?.trim() || config.default_agent,
    timeout_secs: parsePositiveIntEnv("ACP_SUBAGENT_TIMEOUT_SECS", config.timeout_secs),
    inactivity_timeout_secs: parsePositiveIntEnv("ACP_SUBAGENT_INACTIVITY_TIMEOUT_SECS", config.inactivity_timeout_secs),
    max_active_sessions: parsePositiveIntEnv("ACP_SUBAGENT_MAX_ACTIVE_SESSIONS", config.max_active_sessions),
    mcp_request_heartbeat_ms: parseNonNegativeIntEnv("ACP_SUBAGENT_MCP_REQUEST_HEARTBEAT_MS", config.mcp_request_heartbeat_ms),
    acp_cancel_grace_ms: parsePositiveIntEnv("ACP_SUBAGENT_ACP_CANCEL_GRACE_MS", config.acp_cancel_grace_ms),
    process_kill_grace_ms: parsePositiveIntEnv("ACP_SUBAGENT_PROCESS_KILL_GRACE_MS", config.process_kill_grace_ms),
    log_dir: process.env.ACP_SUBAGENT_LOG_DIR?.trim() || config.log_dir
  };
}

/**
 * 应用安全环境变量覆盖。
 */
function applySecurityEnvOverrides(config: SecurityConfig): SecurityConfig {
  const workspaceRoots = parseOptionalListEnv("ACP_SUBAGENT_WORKSPACE_ROOTS");
  const configuredRoots = workspaceRoots ?? config.allowed_cwd_roots;

  return {
    ...config,
    allowed_cwd_roots: configuredRoots,
    auto_workspace_roots: parseBooleanEnv("ACP_SUBAGENT_AUTO_WORKSPACE_ROOTS", config.auto_workspace_roots),
    allow_network: parseBooleanEnv("ACP_SUBAGENT_ALLOW_NETWORK", config.allow_network),
    require_absolute_agent_command: parseBooleanEnv("ACP_SUBAGENT_REQUIRE_ABSOLUTE_AGENT_COMMAND", config.require_absolute_agent_command)
  };
}

/**
 * 应用并发环境变量覆盖。
 */
function applyConcurrencyEnvOverrides(config: ConcurrencyConfig): ConcurrencyConfig {
  return {
    ...config,
    max_parallel_tasks: parsePositiveIntEnv("ACP_SUBAGENT_MAX_PARALLEL_TASKS", config.max_parallel_tasks)
  };
}

/**
 * 应用 worktree 环境变量覆盖。
 */
function applyWorktreeEnvOverrides(config: WorktreeConfig): WorktreeConfig {
  return {
    ...config,
    enabled: parseBooleanEnv("ACP_SUBAGENT_WORKTREE_ENABLED", config.enabled)
  };
}

/**
 * 应用日志环境变量覆盖。
 */
function applyLogsEnvOverrides(config: LogsConfig): LogsConfig {
  return {
    ...config,
    redact: parseBooleanEnv("ACP_SUBAGENT_REDACT_LOGS", config.redact)
  };
}

/**
 * 应用 skill 环境变量覆盖。
 */
function applySkillsEnvOverrides(config: SkillsConfig): SkillsConfig {
  const json = parseJsonObjectEnv<Partial<SkillsConfig>>("ACP_SUBAGENT_SKILLS", {});
  const modeFromEnv = process.env.ACP_SUBAGENT_SKILL_MODE as SkillsConfig["default_mode"] | undefined;
  const defaultMode = modeFromEnv && ["off", "list", "inline"].includes(modeFromEnv) ? modeFromEnv : json.default_mode ?? config.default_mode;
  return {
    ...config,
    ...json,
    enabled: parseBooleanEnv("ACP_SUBAGENT_SKILLS_ENABLED", json.enabled ?? config.enabled),
    default_mode: defaultMode,
    include_project_skills: parseBooleanEnv("ACP_SUBAGENT_SKILL_INCLUDE_PROJECT", json.include_project_skills ?? config.include_project_skills),
    include_user_skills: parseBooleanEnv("ACP_SUBAGENT_SKILL_INCLUDE_USER", json.include_user_skills ?? config.include_user_skills),
    discovery_roots: parseListEnv("ACP_SUBAGENT_SKILL_ROOTS", json.discovery_roots ?? config.discovery_roots),
    default_names: parseListEnv("ACP_SUBAGENT_SKILL_NAMES", json.default_names ?? config.default_names),
    max_skills: parsePositiveIntEnv("ACP_SUBAGENT_SKILL_MAX_SKILLS", json.max_skills ?? config.max_skills),
    max_description_chars: parsePositiveIntEnv("ACP_SUBAGENT_SKILL_MAX_DESCRIPTION_CHARS", json.max_description_chars ?? config.max_description_chars),
    max_skill_chars: parsePositiveIntEnv("ACP_SUBAGENT_SKILL_MAX_CHARS", json.max_skill_chars ?? config.max_skill_chars),
    max_total_skill_chars: parsePositiveIntEnv("ACP_SUBAGENT_SKILL_MAX_TOTAL_CHARS", json.max_total_skill_chars ?? config.max_total_skill_chars)
  };
}

/**
 * 判断文件是否存在。
 */
async function fileExists(filePath: string): Promise<boolean> {
  return access(filePath).then(() => true).catch(() => false);
}

/**
 * 解析布尔环境变量。
 */
function parseBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

/**
 * 解析正整数环境变量。
 */
function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * 解析非负整数环境变量。0 用于显式关闭某些周期性机制。
 */
function parseNonNegativeIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * 解析字符串列表环境变量。支持 JSON array、逗号分隔和平台 path delimiter。
 */
function parseListEnv(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch {
      return fallback;
    }
  }
  const delimiter = trimmed.includes(",") ? "," : path.delimiter;
  return trimmed.split(delimiter).map((item) => item.trim()).filter(Boolean);
}

/**
 * 解析可选字符串列表环境变量。undefined 表示用户没有设置该环境变量。
 */
function parseOptionalListEnv(name: string): string[] | undefined {
  if (!(name in process.env)) return undefined;
  return parseListEnv(name, []);
}

/**
 * 解析 agent 环境变量继承策略。
 */
function parseAgentEnvPolicyEnv(name: string, fallback: "all" | "allowlist" | "none"): "all" | "allowlist" | "none" {
  const raw = process.env[name]?.trim();
  return normalizeAgentEnvPolicyValue(raw) ?? fallback;
}

/**
 * 归一化环境变量继承策略。
 *
 * 新配置只推荐 all / allowlist / none。旧值为了平滑升级继续接受：
 * inherit -> all，auth -> allowlist，minimal -> none。
 */
function normalizeAgentEnvPolicyValue(raw: string | undefined): "all" | "allowlist" | "none" | undefined {
  if (!raw) return undefined;
  if (raw === "all" || raw === "allowlist" || raw === "none") return raw;
  if (raw === "inherit") return "all";
  if (raw === "auth") return "allowlist";
  if (raw === "minimal") return "none";
  return undefined;
}

/**
 * 解析 args 环境变量。优先支持 JSON array，其次做简单空白切分。
 */
function parseArgsEnv(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      return fallback;
    }
  }
  return trimmed.split(/\s+/).filter(Boolean);
}

/**
 * 解析 JSON object 环境变量。
 */
function parseJsonObjectEnv<T extends Record<string, unknown>>(name: string, fallback: T): T {
  const raw = process.env[name];
  if (!raw?.trim()) return fallback;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as T;
  } catch {
    // 环境变量 JSON 写错时不让 MCP stdio 输出污染 stdout，启动阶段会继续使用 fallback。
  }
  return fallback;
}

/**
 * 渲染一个可复制的默认 TOML 配置，用于高级用户落盘修改。
 */
export function renderDefaultConfigToml(): string {
  return `# @rvaim/acp-subagent-mcp 默认配置示例
#
# 普通用户不需要创建这个文件；直接通过 MCP Host / Claude Desktop 启动即可。
# 只有需要严格限制工作区、增加子代理或覆盖命令时，才需要落盘配置。

[defaults]
default_agent = "claude"
timeout_secs = 600
inactivity_timeout_secs = 15
max_depth = 2
max_prompt_chars = 120000
max_inline_file_chars = 30000
log_dir = ".subagents/runs"
session_ttl_secs = 1800
completed_session_ttl_secs = 600
max_active_sessions = 4
mcp_request_heartbeat_ms = 1000
acp_cancel_grace_ms = 500
process_kill_grace_ms = 500

[security]
# 默认不需要设置 allowed_cwd_roots；MCP tool 传入的 cwd 会被视为当前工作区。
# 如果你要做更严格的限制，再把下面这行改成固定目录列表。
allowed_cwd_roots = []
auto_workspace_roots = true
allow_network = false
max_read_file_bytes = 1048576
require_absolute_agent_command = false

[concurrency]
max_parallel_tasks = 4
default_conflict_policy = "single_writer_per_cwd"

[skills]
enabled = true
default_mode = "list"
include_project_skills = true
include_user_skills = true
discovery_roots = []
default_names = []
max_skills = 20
max_description_chars = 360
max_skill_chars = 8000
max_total_skill_chars = 20000

[permissions.default]
read = "allow"
search = "allow"
edit = "deny"
execute = "deny"
network = "deny"

[permissions.claude]
read = "allow"
search = "allow"
edit = "allow"
execute = "deny"
network = "deny"

[agents.claude]
description = "默认 Claude ACP 子代理。"
command = "claude-agent-acp"
args = []
capabilities = ["claude", "code", "review", "analysis", "edit"]
env_policy = "all"
# env_policy 可选：all | allowlist | none。默认 all，会继承 MCP Server 进程可见的全部环境变量。
# env_allowlist 只在 env_policy="allowlist" 时生效，支持精确名称和 ANTHROPIC_* 这种前缀通配。
env_allowlist = ["ANTHROPIC_*", "CLAUDE_*", "PATH", "HOME", "USERPROFILE"]
install_hint = "请确认 claude-agent-acp 已在 PATH，或用 ACP_SUBAGENT_DEFAULT_AGENT_COMMAND 指定绝对路径。本包不会自动安装具体子代理 adapter。"

[agents.claude.env]
# 这里是可选显式覆盖；默认 all 已经会继承宿主环境。未设置的 from_env 不会以空字符串传给子进程。
# ANTHROPIC_API_KEY = { from_env = "ANTHROPIC_API_KEY" }
`;
}

/**
 * 渲染 Claude Desktop 可直接复制的 MCP 配置片段。
 */
export function renderClaudeDesktopConfigJson(): string {
  const config = {
    mcpServers: {
      "acp-subagent": {
        command: "npx",
        args: ["-y", "@rvaim/acp-subagent-mcp"],
        env: {
          ACP_SUBAGENT_DEFAULT_AGENT: "claude",
          ACP_SUBAGENT_ENV_POLICY: "all",
          ACP_SUBAGENT_SKILL_MODE: "list"
        }
      }
    }
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}


/**
 * 渲染 Codex config.toml 可直接复制的 MCP 配置片段。
 *
 * Codex CLI 和 Codex IDE 扩展共用该配置格式。Codex Desktop 如果提供
 * “Open config.toml” 或等价 MCP 设置入口，也可以使用同一段配置。
 */
export function renderCodexConfigToml(): string {
  return `[mcp_servers.acp-subagent]
command = "npx"
args = ["-y", "@rvaim/acp-subagent-mcp"]
# 可选：Codex 启动 stdio MCP server 时显式转发这些宿主环境变量。
# 如果你的子代理依赖本地登录、代理、证书或 API key，请把对应变量列在这里。
env_vars = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "CLAUDE_CONFIG_DIR",
  "OPENAI_API_KEY",
  "CODEX_HOME",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY"
]

[mcp_servers.acp-subagent.env]
ACP_SUBAGENT_DEFAULT_AGENT = "claude"
ACP_SUBAGENT_ENV_POLICY = "all"
ACP_SUBAGENT_SKILL_MODE = "list"
`;
}

/**
 * 渲染通用 MCP Host 的 stdio JSON 配置片段。
 */
export function renderGenericMcpConfigJson(): string {
  const config = {
    mcpServers: {
      "acp-subagent": {
        type: "stdio",
        command: "npx",
        args: ["-y", "@rvaim/acp-subagent-mcp"],
        env: {
          ACP_SUBAGENT_DEFAULT_AGENT: "claude",
          ACP_SUBAGENT_ENV_POLICY: "all",
          ACP_SUBAGENT_SKILL_MODE: "list"
        }
      }
    }
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

/**
 * 转义 TOML 字符串中的反斜杠和双引号。
 */
function escapeTomlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

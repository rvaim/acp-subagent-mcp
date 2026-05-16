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
  inactivity_timeout_secs: 120,
  max_depth: 2,
  max_prompt_chars: 120000,
  max_inline_file_chars: 30000,
  log_dir: ".subagent-runs",
  session_ttl_secs: 1800,
  completed_session_ttl_secs: 600,
  max_active_sessions: 4,
  acp_cancel_grace_ms: 3000,
  process_kill_grace_ms: 2000
};

/** 默认安全配置。 */
const defaultSecurity: SecurityConfig = {
  allowed_cwd_roots: [process.cwd()],
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
  base_dir: ".subagent-worktrees",
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
    acp_cancel_grace_ms: z.number().int().positive().default(defaultDefaults.acp_cancel_grace_ms),
    process_kill_grace_ms: z.number().int().positive().default(defaultDefaults.process_kill_grace_ms)
  }).default(defaultDefaults),
  security: z.object({
    allowed_cwd_roots: z.array(z.string()).default(defaultSecurity.allowed_cwd_roots),
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
  const agents: Record<string, AgentConfig> = {
    ...defaultAgents,
    ...(parsed.agents as Record<string, AgentConfig>),
    ...envAgents
  };
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
 * 构造默认 Claude 子代理配置。
 */
function buildDefaultAgentsFromEnv(): Record<string, AgentConfig> {
  const command = process.env.ACP_SUBAGENT_CLAUDE_COMMAND?.trim() || "claude-agent-acp";
  const args = parseArgsEnv("ACP_SUBAGENT_CLAUDE_ARGS", []);
  const envFromJson = parseJsonObjectEnv<Record<string, string | { from_env: string }>>("ACP_SUBAGENT_CLAUDE_ENV_JSON", {});

  return {
    claude: {
      description: "默认 Claude ACP 子代理，适合代码审查、实现、调试和多轮修正。",
      command,
      args,
      capabilities: ["claude", "code", "review", "analysis", "edit"],
      system_prompt: "你是一个被父代理调用的 Claude 子代理。严格遵守任务边界，只返回最终结果，不输出隐藏推理。",
      env: {
        ANTHROPIC_API_KEY: { from_env: "ANTHROPIC_API_KEY" },
        ANTHROPIC_AUTH_TOKEN: { from_env: "ANTHROPIC_AUTH_TOKEN" },
        ANTHROPIC_BASE_URL: { from_env: "ANTHROPIC_BASE_URL" },
        ANTHROPIC_MODEL: { from_env: "ANTHROPIC_MODEL" },
        CLAUDE_CONFIG_DIR: { from_env: "CLAUDE_CONFIG_DIR" },
        ...envFromJson
      },
      install_hint: "未找到默认 Claude ACP 子代理命令。请确认 claude-agent-acp 已在 PATH 中；或在 Claude Desktop 的 env 中设置 ACP_SUBAGENT_CLAUDE_COMMAND 为可执行文件绝对路径；或创建 agents.toml 自定义 [agents.claude]。本包不会自动安装具体子代理 adapter。"
    }
  };
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
    log_dir: process.env.ACP_SUBAGENT_LOG_DIR?.trim() || config.log_dir
  };
}

/**
 * 应用安全环境变量覆盖。
 */
function applySecurityEnvOverrides(config: SecurityConfig): SecurityConfig {
  const allowedRoots = parseListEnv("ACP_SUBAGENT_ALLOWED_ROOTS", config.allowed_cwd_roots);
  return {
    ...config,
    allowed_cwd_roots: allowedRoots.length > 0 ? allowedRoots : [process.cwd()],
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
  return `# acp-subagent-mcp 默认配置示例\n\n[defaults]\ndefault_agent = "claude"\ntimeout_secs = 600\ninactivity_timeout_secs = 120\nmax_depth = 2\nmax_prompt_chars = 120000\nmax_inline_file_chars = 30000\nlog_dir = ".subagent-runs"\nsession_ttl_secs = 1800\ncompleted_session_ttl_secs = 600\nmax_active_sessions = 4\nacp_cancel_grace_ms = 3000\nprocess_kill_grace_ms = 2000\n\n[security]\nallowed_cwd_roots = ["${escapeTomlString(process.cwd())}"]\nallow_network = false\nmax_read_file_bytes = 1048576\nrequire_absolute_agent_command = false\n\n[concurrency]\nmax_parallel_tasks = 4\ndefault_conflict_policy = "single_writer_per_cwd"\n\n[skills]\nenabled = true\ndefault_mode = "list"\ninclude_project_skills = true\ninclude_user_skills = true\ndiscovery_roots = []\ndefault_names = []\nmax_skills = 20\nmax_description_chars = 360\nmax_skill_chars = 8000\nmax_total_skill_chars = 20000\n\n[permissions.default]\nread = "allow"\nsearch = "allow"\nedit = "deny"\nexecute = "deny"\nnetwork = "deny"\n\n[permissions.claude]\nread = "allow"\nsearch = "allow"\nedit = "allow"\nexecute = "deny"\nnetwork = "deny"\n\n[agents.claude]\ndescription = "默认 Claude ACP 子代理。"\ncommand = "claude-agent-acp"\nargs = []\ncapabilities = ["claude", "code", "review", "analysis", "edit"]\ninstall_hint = "请确认 claude-agent-acp 已在 PATH，或用 ACP_SUBAGENT_CLAUDE_COMMAND 指定绝对路径。本包不会自动安装具体子代理 adapter。"\n\n[agents.claude.env]\nANTHROPIC_API_KEY = { from_env = "ANTHROPIC_API_KEY" }\nANTHROPIC_AUTH_TOKEN = { from_env = "ANTHROPIC_AUTH_TOKEN" }\nANTHROPIC_BASE_URL = { from_env = "ANTHROPIC_BASE_URL" }\nANTHROPIC_MODEL = { from_env = "ANTHROPIC_MODEL" }\nCLAUDE_CONFIG_DIR = { from_env = "CLAUDE_CONFIG_DIR" }\n`;
}

/**
 * 渲染 Claude Desktop 可直接复制的 MCP 配置片段。
 */
export function renderClaudeDesktopConfigJson(): string {
  const exampleRoot = process.env.ACP_SUBAGENT_ALLOWED_ROOTS || process.cwd();
  const config = {
    mcpServers: {
      "acp-subagent": {
        command: "npx",
        args: ["-y", "acp-subagent-mcp"],
        env: {
          ACP_SUBAGENT_ALLOWED_ROOTS: exampleRoot,
          ACP_SUBAGENT_DEFAULT_AGENT: "claude",
          ACP_SUBAGENT_CLAUDE_COMMAND: "claude-agent-acp",
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

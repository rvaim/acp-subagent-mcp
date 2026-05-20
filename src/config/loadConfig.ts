import fs from "node:fs/promises";
import path from "node:path";
import { parse } from "smol-toml";
import type {
  AgentConfig,
  ConcurrencyConfig,
  DefaultsConfig,
  PermissionPolicy,
  SecurityConfig,
  ServerConfig,
  SessionPoolConfig,
} from "./types.js";

/** 默认权限策略：只允许读和搜索，拒绝写、执行和联网。 */
const DEFAULT_PERMISSION_POLICY: PermissionPolicy = {
  read: "allow",
  search: "allow",
  edit: "deny",
  execute: "deny",
  network: "deny",
};

/** 默认运行参数。 */
const DEFAULT_DEFAULTS: DefaultsConfig = {
  timeout_secs: 600,
  inactivity_timeout_secs: 120,
  heartbeat_timeout_secs: 3,
  max_depth: 2,
  max_prompt_chars: 120000,
  max_inline_file_chars: 30000,
  max_tool_output_chars: 12000,
  default_detail_level: "summary",
  log_dir: ".subagent-runs",
  session_ttl_secs: 1800,
  completed_session_ttl_secs: 600,
  max_active_sessions: 8,
};

/** 默认安全配置。 */
const DEFAULT_SECURITY: SecurityConfig = {
  allowed_cwd_roots: [process.cwd()],
  allow_network: false,
};

/** 默认并发配置。 */
const DEFAULT_CONCURRENCY: ConcurrencyConfig = {
  max_parallel_tasks: 4,
  default_conflict_policy: "single_writer_per_cwd",
};

/** 默认会话池配置。 */
const DEFAULT_SESSION_POOL: SessionPoolConfig = {
  enabled: true,
  max_pooled_sessions_per_parent: 4,
  max_context_usage_ratio: 0.9,
  idle_ttl_secs: 1800,
  reuse_policy: "auto",
};

/**
 * 解析配置文件路径。
 *
 * 优先读取 SUBAGENT_MCP_CONFIG 环境变量；未设置时读取当前工作目录下的 agents.toml。
 *
 * @returns 解析后的绝对配置文件路径。
 */
export function resolveConfigPath(): string {
  const configuredPath = process.env.SUBAGENT_MCP_CONFIG ?? "agents.toml";
  return path.resolve(configuredPath);
}

/**
 * 加载并校验 agents.toml。
 *
 * @param configPath 可选配置文件路径；未传时会调用 resolveConfigPath。
 * @returns 归一化后的服务器配置。
 * @throws 当配置无法读取、格式错误或没有任何 agent 时抛出错误。
 */
export async function loadConfig(configPath = resolveConfigPath()): Promise<ServerConfig> {
  const absoluteConfigPath = path.resolve(configPath);
  const rawToml = await fs.readFile(absoluteConfigPath, "utf8");
  const parsed = parse(rawToml) as Record<string, unknown>;

  const defaults = normalizeDefaults(parsed.defaults);
  const security = normalizeSecurity(parsed.security);
  const concurrency = normalizeConcurrency(parsed.concurrency);
  const sessionPool = normalizeSessionPool(parsed.session_pool);
  const permissions = normalizePermissions(parsed.permissions);
  const agents = normalizeAgents(parsed.agents);

  if (Object.keys(agents).length === 0) {
    throw new Error("agents.toml 中必须至少配置一个 [agents.<name>] 子代理");
  }

  return {
    defaults,
    security,
    concurrency,
    session_pool: sessionPool,
    permissions,
    agents,
    configPath: absoluteConfigPath,
  };
}

/**
 * 归一化默认运行参数。
 *
 * @param value TOML 中的 defaults 表。
 * @returns 合并默认值后的 DefaultsConfig。
 */
function normalizeDefaults(value: unknown): DefaultsConfig {
  const input = asRecord(value);
  return {
    timeout_secs: numberOr(input.timeout_secs, DEFAULT_DEFAULTS.timeout_secs),
    inactivity_timeout_secs: numberOr(input.inactivity_timeout_secs, DEFAULT_DEFAULTS.inactivity_timeout_secs),
    heartbeat_timeout_secs: numberOr(input.heartbeat_timeout_secs, DEFAULT_DEFAULTS.heartbeat_timeout_secs),
    max_depth: numberOr(input.max_depth, DEFAULT_DEFAULTS.max_depth),
    max_prompt_chars: numberOr(input.max_prompt_chars, DEFAULT_DEFAULTS.max_prompt_chars),
    max_inline_file_chars: numberOr(input.max_inline_file_chars, DEFAULT_DEFAULTS.max_inline_file_chars),
    max_tool_output_chars: numberOr(input.max_tool_output_chars, DEFAULT_DEFAULTS.max_tool_output_chars),
    default_detail_level: stringUnionOr(input.default_detail_level, ["summary", "normal", "verbose"], DEFAULT_DEFAULTS.default_detail_level),
    log_dir: stringOr(input.log_dir, DEFAULT_DEFAULTS.log_dir),
    session_ttl_secs: numberOr(input.session_ttl_secs, DEFAULT_DEFAULTS.session_ttl_secs),
    completed_session_ttl_secs: numberOr(input.completed_session_ttl_secs, DEFAULT_DEFAULTS.completed_session_ttl_secs),
    max_active_sessions: numberOr(input.max_active_sessions, DEFAULT_DEFAULTS.max_active_sessions),
  };
}

/**
 * 归一化安全配置。
 *
 * @param value TOML 中的 security 表。
 * @returns 合并默认值后的 SecurityConfig。
 */
function normalizeSecurity(value: unknown): SecurityConfig {
  const input = asRecord(value);
  const roots = arrayOfStringOr(input.allowed_cwd_roots, DEFAULT_SECURITY.allowed_cwd_roots);
  return {
    allowed_cwd_roots: roots.map((root) => path.resolve(root)),
    allow_network: booleanOr(input.allow_network, DEFAULT_SECURITY.allow_network),
  };
}

/**
 * 归一化并发配置。
 *
 * @param value TOML 中的 concurrency 表。
 * @returns 合并默认值后的 ConcurrencyConfig。
 */
function normalizeConcurrency(value: unknown): ConcurrencyConfig {
  const input = asRecord(value);
  return {
    max_parallel_tasks: numberOr(input.max_parallel_tasks, DEFAULT_CONCURRENCY.max_parallel_tasks),
    default_conflict_policy: stringUnionOr(
      input.default_conflict_policy,
      ["allow_readonly_parallel", "single_writer_per_cwd", "sandbox_worktree"],
      DEFAULT_CONCURRENCY.default_conflict_policy,
    ),
  };
}

/**
 * 归一化会话池配置。
 *
 * @param value TOML 中的 session_pool 表。
 * @returns 合并默认值后的 SessionPoolConfig。
 */
function normalizeSessionPool(value: unknown): SessionPoolConfig {
  const input = asRecord(value);
  return {
    enabled: booleanOr(input.enabled, DEFAULT_SESSION_POOL.enabled),
    max_pooled_sessions_per_parent: numberOr(
      input.max_pooled_sessions_per_parent,
      DEFAULT_SESSION_POOL.max_pooled_sessions_per_parent,
    ),
    max_context_usage_ratio: numberOr(input.max_context_usage_ratio, DEFAULT_SESSION_POOL.max_context_usage_ratio),
    idle_ttl_secs: numberOr(input.idle_ttl_secs, DEFAULT_SESSION_POOL.idle_ttl_secs),
    reuse_policy: stringUnionOr(input.reuse_policy, ["auto", "disable", "force_new"], DEFAULT_SESSION_POOL.reuse_policy),
  };
}

/**
 * 归一化权限配置。
 *
 * @param value TOML 中的 permissions 表。
 * @returns 以 default 和 agent_type 为 key 的权限策略。
 */
function normalizePermissions(value: unknown): Record<string, PermissionPolicy> {
  const input = asRecord(value);
  const output: Record<string, PermissionPolicy> = {
    default: { ...DEFAULT_PERMISSION_POLICY, ...normalizePermissionPolicy(input.default) },
  };

  for (const [agentType, policyValue] of Object.entries(input)) {
    if (agentType === "default") {
      continue;
    }
    output[agentType] = { ...(output.default ?? DEFAULT_PERMISSION_POLICY), ...normalizePermissionPolicy(policyValue) };
  }

  return output;
}

/**
 * 归一化单个权限策略。
 *
 * @param value TOML 中的单个权限表。
 * @returns 部分 PermissionPolicy，便于与默认策略合并。
 */
function normalizePermissionPolicy(value: unknown): Partial<PermissionPolicy> {
  const input = asRecord(value);
  const choices = ["allow", "deny", "cancel"] as const;
  const output: Partial<PermissionPolicy> = {};
  const read = stringUnionOrOptional(input.read, choices);
  const search = stringUnionOrOptional(input.search, choices);
  const edit = stringUnionOrOptional(input.edit, choices);
  const execute = stringUnionOrOptional(input.execute, choices);
  const network = stringUnionOrOptional(input.network, choices);
  if (read) output.read = read;
  if (search) output.search = search;
  if (edit) output.edit = edit;
  if (execute) output.execute = execute;
  if (network) output.network = network;
  return output;
}

/**
 * 归一化 agent 配置。
 *
 * @param value TOML 中的 agents 表。
 * @returns 以 agent_type 为 key 的 AgentConfig。
 */
function normalizeAgents(value: unknown): Record<string, AgentConfig> {
  const input = asRecord(value);
  const agents: Record<string, AgentConfig> = {};

  for (const [agentType, agentValue] of Object.entries(input)) {
    const agentInput = asRecord(agentValue);
    const command = stringOr(agentInput.command, "");
    if (!command) {
      throw new Error(`agents.${agentType}.command 不能为空`);
    }

    const envValue = asRecord(agentInput.env);
    const env: Record<string, string> = {};
    for (const [envName, envRawValue] of Object.entries(envValue)) {
      if (typeof envRawValue === "string") {
        env[envName] = envRawValue;
      }
    }

    agents[agentType] = {
      description: stringOr(agentInput.description, "未提供描述"),
      command,
      args: arrayOfStringOr(agentInput.args, []),
      capabilities: arrayOfStringOr(agentInput.capabilities, []),
      system_prompt: typeof agentInput.system_prompt === "string" ? agentInput.system_prompt : undefined,
      env,
      heartbeat_timeout_secs: typeof agentInput.heartbeat_timeout_secs === "number" ? agentInput.heartbeat_timeout_secs : undefined,
      timeout_secs: typeof agentInput.timeout_secs === "number" ? agentInput.timeout_secs : undefined,
      inactivity_timeout_secs:
        typeof agentInput.inactivity_timeout_secs === "number" ? agentInput.inactivity_timeout_secs : undefined,
    };
  }

  return agents;
}

/**
 * 将 unknown 安全转换为普通对象。
 *
 * @param value 待转换值。
 * @returns 普通对象；非对象时返回空对象。
 */
function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/**
 * 读取数字配置。
 *
 * @param value 用户配置值。
 * @param fallback 默认值。
 * @returns 有效数字或默认值。
 */
function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * 读取字符串配置。
 *
 * @param value 用户配置值。
 * @param fallback 默认值。
 * @returns 有效字符串或默认值。
 */
function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/**
 * 读取布尔配置。
 *
 * @param value 用户配置值。
 * @param fallback 默认值。
 * @returns 有效布尔值或默认值。
 */
function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * 读取字符串数组配置。
 *
 * @param value 用户配置值。
 * @param fallback 默认值。
 * @returns 有效字符串数组或默认值。
 */
function arrayOfStringOr(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : fallback;
}

/**
 * 读取枚举字符串配置。
 *
 * @param value 用户配置值。
 * @param choices 允许值。
 * @param fallback 默认值。
 * @returns 枚举值或默认值。
 */
function stringUnionOr<T extends string>(value: unknown, choices: readonly T[], fallback: T): T {
  return typeof value === "string" && choices.includes(value as T) ? (value as T) : fallback;
}

/**
 * 读取可选枚举字符串配置。
 *
 * @param value 用户配置值。
 * @param choices 允许值。
 * @returns 枚举值或 undefined。
 */
function stringUnionOrOptional<T extends string>(value: unknown, choices: readonly T[]): T | undefined {
  return typeof value === "string" && choices.includes(value as T) ? (value as T) : undefined;
}

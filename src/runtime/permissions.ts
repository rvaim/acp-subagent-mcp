import type { AppConfig, McpServerProfile, PermissionPolicy } from "../config/types.js";
import type { SubagentRunInput } from "../task/types.js";
import { SubagentRuntimeError } from "./errors.js";
import { taskRequiresWrite } from "./security.js";

/**
 * 对 ACP agent 最终声明的有效权限。
 */
export interface EffectivePermissions {
  /** 是否允许通过 ACP fs/read_text_file 读取文件。 */
  canReadFiles: boolean;
  /** 是否允许通过 ACP fs/write_text_file 写文件。 */
  canWriteFiles: boolean;
  /** 是否允许 ACP terminal/*。默认 false。 */
  canExecuteCommands: boolean;
  /** 是否允许网络。MVP 仅作为策略标记。 */
  canUseNetwork: boolean;
  /** 原始策略。 */
  policy: PermissionPolicy;
}

/**
 * 根据配置和任务模式计算有效权限。
 */
export function resolveEffectivePermissions(config: AppConfig, input: SubagentRunInput): EffectivePermissions {
  const agentType = input.agent_type ?? config.defaults.default_agent;
  const policy = config.permissions[agentType] ?? config.permissions.default;
  const requiresWrite = taskRequiresWrite(input);

  return {
    canReadFiles: policy.read === "allow",
    canWriteFiles: policy.edit === "allow" && requiresWrite,
    canExecuteCommands: policy.execute === "allow",
    canUseNetwork: policy.network === "allow" && config.security.allow_network,
    policy
  };
}

/**
 * 选择 ACP permission option。
 */
export function selectPermissionOption(params: unknown, permissions: EffectivePermissions): { outcome: { outcome: "selected"; optionId: string } } | { outcome: { outcome: "cancelled" } } {
  const options = extractOptions(params);
  const toolKind = extractToolKind(params);

  const shouldAllow = shouldAllowToolKind(toolKind, permissions);
  const selected = shouldAllow
    ? options.find((option) => option.kind.includes("allow"))
    : options.find((option) => option.kind.includes("reject") || option.kind.includes("deny"));

  if (!selected) {
    return { outcome: { outcome: "cancelled" } };
  }

  return { outcome: { outcome: "selected", optionId: selected.optionId } };
}

/**
 * 根据 profile 名称解析允许传给 ACP agent 的 MCP server 配置。
 */
export function resolveMcpServerProfiles(config: AppConfig, agentType: string, profileNames: string[] | undefined): Array<Record<string, unknown>> {
  const names = profileNames ?? [];
  const profiles: Array<Record<string, unknown>> = [];

  for (const name of names) {
    const profile = config.mcp_servers[name];
    if (!profile || !profile.enabled) {
      throw new SubagentRuntimeError("mcp_server_profile_not_allowed", `MCP server profile 不存在或未启用：${name}`);
    }
    if (profile.allowed_agents && profile.allowed_agents.length > 0 && !profile.allowed_agents.includes(agentType)) {
      throw new SubagentRuntimeError("mcp_server_profile_not_allowed", `agent ${agentType} 不允许使用 MCP server profile：${name}`);
    }
    profiles.push(profileToAcpMcpServer(name, profile));
  }

  return profiles;
}

/**
 * 将 profile 转为 ACP session/new mcpServers 条目。
 */
function profileToAcpMcpServer(name: string, profile: McpServerProfile): Record<string, unknown> {
  if (profile.transport === "stdio") {
    return {
      name,
      command: profile.command,
      args: profile.args ?? [],
      env: Object.entries(profile.env ?? {}).map(([key, value]) => ({ name: key, value }))
    };
  }

  return {
    name,
    transport: profile.transport,
    url: profile.url
  };
}

/**
 * 从 ACP permission request 参数中提取 options。
 */
function extractOptions(params: unknown): Array<{ optionId: string; kind: string }> {
  if (!params || typeof params !== "object" || !("options" in params) || !Array.isArray((params as { options?: unknown }).options)) {
    return [];
  }

  return ((params as { options: unknown[] }).options).flatMap((option) => {
    if (!option || typeof option !== "object") return [];
    const optionId = String((option as { optionId?: unknown }).optionId ?? "");
    const kind = String((option as { kind?: unknown }).kind ?? "");
    return optionId ? [{ optionId, kind }] : [];
  });
}

/**
 * 从 ACP permission request 中推断工具类型。
 */
function extractToolKind(params: unknown): string {
  if (!params || typeof params !== "object") return "unknown";
  const toolCall = (params as { toolCall?: unknown }).toolCall;
  if (!toolCall || typeof toolCall !== "object") return "unknown";
  return String((toolCall as { kind?: unknown; title?: unknown }).kind ?? (toolCall as { title?: unknown }).title ?? "unknown").toLowerCase();
}

/**
 * 根据工具类型和权限判断是否允许。
 */
function shouldAllowToolKind(toolKind: string, permissions: EffectivePermissions): boolean {
  if (toolKind.includes("read") || toolKind.includes("search")) return permissions.canReadFiles;
  if (toolKind.includes("edit") || toolKind.includes("write") || toolKind.includes("delete")) return permissions.canWriteFiles;
  if (toolKind.includes("terminal") || toolKind.includes("execute") || toolKind.includes("shell")) return permissions.canExecuteCommands;
  if (toolKind.includes("network") || toolKind.includes("http")) return permissions.canUseNetwork;
  return false;
}

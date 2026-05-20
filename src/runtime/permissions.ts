import type { PermissionDecision, PermissionPolicy, ServerConfig } from "../config/types.js";

/**
 * ACP 权限请求的简化结构。
 */
export interface PermissionRequestLike {
  /** 请求的动作名称或工具名。 */
  action?: string;

  /** 请求的工具名。 */
  toolName?: string;

  /** 请求说明。 */
  description?: string;

  /** 其他协议字段。 */
  [key: string]: unknown;
}

/**
 * ACP 权限响应。
 */
export interface PermissionResponseLike {
  /** 权限结果。 */
  outcome: "approved" | "denied" | "cancelled";

  /** 人类可读说明。 */
  message?: string;
}

/**
 * 根据配置为 ACP 权限请求做自动决策。
 *
 * @param agentType 子代理类型。
 * @param request ACP agent 发来的权限请求。
 * @param config 服务器配置。
 * @returns ACP 权限响应。
 */
export function decidePermission(agentType: string, request: PermissionRequestLike, config: ServerConfig): PermissionResponseLike {
  const policy = resolvePermissionPolicy(agentType, config);
  const category = classifyPermissionRequest(request);
  const decision = policy[category];

  if (decision === "allow") {
    return { outcome: "approved", message: `已根据 permissions.${agentType} 自动允许 ${category}` };
  }

  if (decision === "cancel") {
    return { outcome: "cancelled", message: `已根据权限策略取消 ${category}` };
  }

  return { outcome: "denied", message: `已根据权限策略拒绝 ${category}` };
}

/**
 * 解析某个 agent 的权限策略。
 *
 * @param agentType 子代理类型。
 * @param config 服务器配置。
 * @returns 合并 default 后的权限策略。
 */
export function resolvePermissionPolicy(agentType: string, config: ServerConfig): PermissionPolicy {
  const fallback: PermissionPolicy = { read: "deny", search: "deny", edit: "deny", execute: "deny", network: "deny" };
  return {
    ...fallback,
    ...(config.permissions.default ?? {}),
    ...(config.permissions[agentType] ?? {}),
  };
}

/**
 * 将权限请求粗略归类到配置中的权限维度。
 *
 * @param request ACP 权限请求。
 * @returns 权限类别。
 */
function classifyPermissionRequest(request: PermissionRequestLike): keyof PermissionPolicy {
  const text = `${request.action ?? ""} ${request.toolName ?? ""} ${request.description ?? ""}`.toLowerCase();

  if (/(write|edit|modify|patch|delete|remove|create)/.test(text)) {
    return "edit";
  }
  if (/(exec|shell|terminal|command|run|bash|sh|npm|node)/.test(text)) {
    return "execute";
  }
  if (/(network|http|fetch|curl|wget|web|url)/.test(text)) {
    return "network";
  }
  if (/(search|grep|find|ripgrep|rg)/.test(text)) {
    return "search";
  }
  return "read";
}

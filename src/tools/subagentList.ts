import type { AppConfig } from "../config/types.js";

/**
 * subagent_list 输出。
 */
export interface SubagentListOutput {
  /** 默认子代理名称。 */
  default_agent: string;
  /** 配置来源。 */
  config_source: "file" | "defaults";
  /** 可用子代理列表。 */
  agents: Array<{
    /** agent 名称。 */
    name: string;
    /** 简短说明。 */
    description: string;
    /** 能力标签。 */
    capabilities: string[];
    /** 是否为默认 agent。 */
    default?: boolean;
    /** 缺少默认依赖时的安装提示。 */
    install_hint?: string;
  }>;
  /** Skill 桥接摘要，不包含任何 Skill 内容。 */
  skills: {
    /** 是否启用。 */
    enabled: boolean;
    /** 默认模式。 */
    default_mode: "off" | "list" | "inline";
  };
}

/**
 * 处理 subagent_list。
 */
export function handleSubagentList(config: AppConfig): SubagentListOutput {
  return {
    default_agent: config.defaults.default_agent,
    config_source: config.configSource,
    agents: Object.entries(config.agents).map(([name, agent]) => ({
      name,
      description: agent.description,
      capabilities: agent.capabilities,
      default: name === config.defaults.default_agent || undefined,
      install_hint: name === "claude" && agent.command === "claude-agent-acp"
        ? "如提示找不到 claude-agent-acp，请确认该命令已在 PATH，或设置 ACP_SUBAGENT_CLAUDE_COMMAND。本包不会自动安装具体子代理 adapter。"
        : undefined
    })),
    skills: {
      enabled: config.skills.enabled,
      default_mode: config.skills.default_mode
    }
  };
}

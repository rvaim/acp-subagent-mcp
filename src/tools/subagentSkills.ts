import { z } from "zod";
import type { AppConfig } from "../config/types.js";
import { listVisibleSkills } from "../skills/skillBridge.js";
import { resolveSafeCwd } from "../runtime/security.js";

/** subagent_skills 输入校验。 */
export const subagentSkillsInputSchema = z.object({
  cwd: z.string().optional(),
  include_project: z.boolean().optional(),
  include_user: z.boolean().optional(),
  limit: z.number().int().positive().max(100).optional()
}).strict();

/** subagent_skills MCP JSON Schema。 */
export const subagentSkillsInputJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    cwd: { type: "string", description: "可选；用于发现项目级 .claude/skills" },
    include_project: { type: "boolean" },
    include_user: { type: "boolean" },
    limit: { type: "integer", minimum: 1, maximum: 100 }
  }
} as const;

/** subagent_skills 输出 JSON Schema。 */
export const subagentSkillsOutputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "enabled", "skills", "summary"],
  properties: {
    schema_version: { type: "integer", const: 1 },
    enabled: { type: "boolean" },
    default_mode: { type: "string", enum: ["off", "list", "inline"] },
    skills: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "description", "source", "disable_model_invocation"],
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          when_to_use: { type: "string" },
          source: { type: "string", enum: ["project", "user", "extra"] },
          disable_model_invocation: { type: "boolean" }
        }
      }
    },
    summary: { type: "string" }
  }
} as const;

/**
 * 列出当前 cwd 可见的父代理 Skills。
 *
 * 该工具只返回名称和短描述，不返回完整 SKILL.md，避免主 agent 被长上下文污染。
 */
export async function handleSubagentSkills(args: unknown, config: AppConfig): Promise<Record<string, unknown>> {
  const input = subagentSkillsInputSchema.parse(args);
  const cwd = await resolveSafeCwd(input.cwd, config.security.allowed_cwd_roots);
  const skills = await listVisibleSkills({
    config,
    cwd,
    includeProject: input.include_project,
    includeUser: input.include_user,
    limit: input.limit
  });

  return {
    schema_version: 1,
    enabled: config.skills.enabled,
    default_mode: config.skills.default_mode,
    skills: skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      when_to_use: skill.whenToUse,
      source: skill.source,
      disable_model_invocation: skill.disableModelInvocation
    })),
    summary: `发现 ${skills.length} 个可见 Skill。`
  };
}

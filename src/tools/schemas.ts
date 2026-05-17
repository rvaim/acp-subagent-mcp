import { z } from "zod";

/** 文件输入 schema。 */
const taskFileSchema = z.object({
  path: z.string().min(1),
  role: z.enum(["primary", "reference", "test", "config", "output", "unknown"]),
  action: z.enum(["read", "review", "edit", "create", "delete", "ignore"]),
  description: z.string().optional(),
  line_ranges: z.array(z.object({ start: z.number().int().positive(), end: z.number().int().positive() }).strict()).optional(),
  content: z.string().optional(),
  content_mode: z.enum(["path_only", "inline", "snippet"]).optional()
}).strict();

/** 期望输出 schema。 */
const expectedOutputSchema = z.object({
  format: z.enum(["text", "markdown", "json", "patch", "structured"]),
  required_sections: z.array(z.string()).optional(),
  json_schema: z.record(z.string(), z.unknown()).optional(),
  include_files_changed: z.boolean().optional(),
  include_risks: z.boolean().optional(),
  include_next_steps: z.boolean().optional()
}).strict();

/** 子代理任务 schema。 */
const subagentTaskSchema = z.object({
  title: z.string().min(1),
  goal: z.string().min(1),
  background: z.string().optional(),
  instructions: z.array(z.string()).optional(),
  files: z.array(taskFileSchema).max(200).optional(),
  constraints: z.array(z.string()).optional(),
  expected_output: expectedOutputSchema.optional(),
  success_criteria: z.array(z.string()).optional(),
  parent_context: z.object({
    parent_agent: z.string().optional(),
    conversation_summary: z.string().optional(),
    previous_findings: z.array(z.string()).optional()
  }).strict().optional()
}).strict();

/** 输出压缩选项 schema。 */
const outputOptionsSchema = z.object({
  mode: z.enum(["compact", "standard", "full"]).default("compact"),
  max_result_chars: z.number().int().min(200).max(50000).default(4000),
  max_findings: z.number().int().min(0).max(100).default(8),
  include_diagnostics: z.boolean().default(false),
  include_structured: z.boolean().default(false)
}).strict().default({
  mode: "compact",
  max_result_chars: 4000,
  max_findings: 8,
  include_diagnostics: false,
  include_structured: false
});

/** 父代理 Skill 桥接 schema。 */
const skillBridgeSchema = z.object({
  mode: z.enum(["off", "list", "inline"]).optional(),
  names: z.array(z.string()).max(32).optional(),
  include_project: z.boolean().optional(),
  include_user: z.boolean().optional(),
  max_skill_chars: z.number().int().min(200).max(50000).optional(),
  max_total_chars: z.number().int().min(200).max(100000).optional()
}).strict();

const conflictPolicySchema = z.enum(["allow_readonly_parallel", "single_writer_per_cwd", "sandbox_worktree"]);
const modeSchema = z.enum(["analyze", "review", "edit", "implement", "debug", "custom"]);
const onTaskFailureSchema = z.enum(["keep_others_running", "cancel_all"]).default("keep_others_running");

/** subagent_run 输入 zod schema。 */
export const subagentRunInputSchema = z.object({
  agent_type: z.string().min(1).optional(),
  task: subagentTaskSchema,
  cwd: z.string().optional(),
  timeout_secs: z.number().int().positive().max(24 * 60 * 60).optional(),
  inactivity_timeout_secs: z.number().int().positive().max(24 * 60 * 60).optional(),
  mode: modeSchema.default("analyze"),
  mcp_server_profiles: z.array(z.string()).max(16).optional(),
  skills: skillBridgeSchema.optional(),
  output: outputOptionsSchema.optional(),
  conflict_policy: conflictPolicySchema.optional()
}).strict();

/** subagent_run_many 输入 zod schema。 */
export const subagentRunManyInputSchema = z.object({
  tasks: z.array(subagentRunInputSchema.omit({ conflict_policy: true })).min(1).max(32),
  conflict_policy: conflictPolicySchema.optional(),
  on_task_failure: onTaskFailureSchema
}).strict();

/** subagent_revise 输入 zod schema。 */
export const subagentReviseInputSchema = z.object({
  task_id: z.string().min(1).optional(),
  task: subagentTaskSchema.optional(),
  previous_result: z.string().optional(),
  correction: z.object({
    reason: z.string().min(1),
    rejected_result: z.string().optional(),
    expected_change: z.string().optional()
  }).strict(),
  message: z.string().optional(),
  additional_files: z.array(taskFileSchema).max(200).optional(),
  cwd: z.string().optional(),
  agent_type: z.string().min(1).optional(),
  timeout_secs: z.number().int().positive().max(24 * 60 * 60).optional(),
  inactivity_timeout_secs: z.number().int().positive().max(24 * 60 * 60).optional(),
  mode: modeSchema.default("custom"),
  mcp_server_profiles: z.array(z.string()).max(16).optional(),
  skills: skillBridgeSchema.optional(),
  output: outputOptionsSchema.optional(),
  conflict_policy: conflictPolicySchema.optional()
}).strict();

/** subagent_revise_many 输入 zod schema。 */
export const subagentReviseManyInputSchema = z.object({
  revisions: z.array(subagentReviseInputSchema.omit({ conflict_policy: true })).min(1).max(32),
  conflict_policy: conflictPolicySchema.optional(),
  on_task_failure: onTaskFailureSchema
}).strict();

/** subagent_list 输入 zod schema。 */
export const subagentListInputSchema = z.object({}).strict();

/** subagent_run MCP JSON Schema。保持简洁，减少主 agent 工具 schema token。 */
export const subagentRunInputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["task"],
  properties: {
    agent_type: { type: "string", description: "可选；默认使用服务端 default_agent" },
    cwd: { type: "string", description: "可选；绝对工作目录。默认当前工作区；可用 ACP_SUBAGENT_WORKSPACE_ROOTS 限制" },
    mode: { type: "string", enum: ["analyze", "review", "edit", "implement", "debug", "custom"], default: "analyze" },
    timeout_secs: { type: "integer", minimum: 1 },
    inactivity_timeout_secs: { type: "integer", minimum: 1 },
    conflict_policy: { type: "string", enum: ["allow_readonly_parallel", "single_writer_per_cwd", "sandbox_worktree"] },
    mcp_server_profiles: { type: "array", items: { type: "string" }, description: "只允许引用服务端配置中的 profile；禁止动态 command" },
    skills: skillOptionsJsonSchema(),
    output: outputOptionsJsonSchema(),
    task: taskJsonSchema()
  }
} as const;

/** run_many 工具 JSON schema。 */
export const subagentRunManyInputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["tasks"],
  properties: {
    tasks: { type: "array", minItems: 1, maxItems: 32, items: omitProperty(subagentRunInputJsonSchema, "conflict_policy") },
    conflict_policy: { type: "string", enum: ["allow_readonly_parallel", "single_writer_per_cwd", "sandbox_worktree"] },
    on_task_failure: { type: "string", enum: ["keep_others_running", "cancel_all"], default: "keep_others_running" }
  }
} as const;

/** revise 工具 JSON schema。 */
export const subagentReviseInputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["correction"],
  properties: {
    task_id: { type: "string", description: "推荐；来自 subagent_run/subagent_run_many 的 task_id" },
    task: taskJsonSchema(),
    previous_result: { type: "string", description: "当 task_id 不可用或需要覆盖上一轮结果时传入" },
    correction: {
      type: "object",
      additionalProperties: false,
      required: ["reason"],
      properties: {
        reason: { type: "string" },
        rejected_result: { type: "string" },
        expected_change: { type: "string" }
      }
    },
    message: { type: "string" },
    additional_files: { type: "array", items: taskFileSchemaToJson() },
    cwd: { type: "string" },
    agent_type: { type: "string" },
    timeout_secs: { type: "integer", minimum: 1 },
    inactivity_timeout_secs: { type: "integer", minimum: 1 },
    mode: { type: "string", enum: ["analyze", "review", "edit", "implement", "debug", "custom"], default: "custom" },
    conflict_policy: { type: "string", enum: ["allow_readonly_parallel", "single_writer_per_cwd", "sandbox_worktree"] },
    mcp_server_profiles: { type: "array", items: { type: "string" } },
    skills: skillOptionsJsonSchema(),
    output: outputOptionsJsonSchema()
  }
} as const;

/** revise_many 工具 JSON schema。 */
export const subagentReviseManyInputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["revisions"],
  properties: {
    revisions: { type: "array", minItems: 1, maxItems: 32, items: omitProperty(subagentReviseInputJsonSchema, "conflict_policy") },
    conflict_policy: { type: "string", enum: ["allow_readonly_parallel", "single_writer_per_cwd", "sandbox_worktree"] },
    on_task_failure: { type: "string", enum: ["keep_others_running", "cancel_all"], default: "keep_others_running" }
  }
} as const;

/** subagent_run 输出 JSON Schema，供支持 outputSchema 的 MCP client 使用。 */
export const subagentRunOutputJsonSchema = {
  type: "object",
  additionalProperties: true,
  required: ["schema_version", "status", "agent_type", "summary", "result", "metrics", "errors"],
  properties: {
    schema_version: { type: "integer", const: 1 },
    task_id: { type: "string" },
    title: { type: "string" },
    revision_of_task_id: { type: "string" },
    status: { type: "string", enum: ["completed", "failed", "partial", "timeout", "cancelled"] },
    agent_type: { type: "string" },
    session_id: { type: "string" },
    summary: { type: "string" },
    result: { type: "string" },
    truncated: { type: "boolean" },
    metrics: { type: "object", additionalProperties: true },
    artifacts: { type: "object", additionalProperties: true },
    skills: { type: "object", additionalProperties: true },
    errors: { type: "array", items: { type: "object", additionalProperties: true } }
  }
} as const;

/** run_many 输出 JSON schema。 */
export const subagentRunManyOutputJsonSchema = {
  type: "object",
  additionalProperties: true,
  required: ["schema_version", "status", "completed", "failed", "rejected", "cancelled_task_ids", "elapsed_ms", "summary"],
  properties: {
    schema_version: { type: "integer", const: 1 },
    status: { type: "string", enum: ["completed", "partial", "failed", "cancelled"] },
    completed: { type: "array", items: { type: "object", additionalProperties: true } },
    failed: { type: "array", items: { type: "object", additionalProperties: true } },
    rejected: { type: "array", items: { type: "object", additionalProperties: true } },
    cancelled_task_ids: { type: "array", items: { type: "string" } },
    elapsed_ms: { type: "integer" },
    summary: { type: "string" }
  }
} as const;

/** subagent_list MCP JSON Schema。 */
export const subagentListInputJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {}
} as const;

/** subagent_list 输出 JSON Schema。 */
export const subagentListOutputJsonSchema = {
  type: "object",
  required: ["agents", "default_agent", "skills"],
  additionalProperties: false,
  properties: {
    default_agent: { type: "string" },
    config_source: { type: "string", enum: ["file", "defaults"] },
    skills: {
      type: "object",
      additionalProperties: false,
      required: ["enabled", "default_mode"],
      properties: {
        enabled: { type: "boolean" },
        default_mode: { type: "string", enum: ["off", "list", "inline"] }
      }
    },
    agents: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "description", "capabilities"],
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          capabilities: { type: "array", items: { type: "string" } },
          default: { type: "boolean" },
          install_hint: { type: "string" }
        }
      }
    }
  }
} as const;

/** 通用紧凑输出 JSON schema。 */
export const genericToolOutputJsonSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    schema_version: { type: "integer", const: 1 },
    status: { type: "string" },
    summary: { type: "string" }
  }
} as const;

function taskJsonSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["title", "goal"],
    properties: {
      title: { type: "string" },
      goal: { type: "string" },
      background: { type: "string" },
      instructions: { type: "array", items: { type: "string" } },
      constraints: { type: "array", items: { type: "string" } },
      success_criteria: { type: "array", items: { type: "string" } },
      files: { type: "array", items: taskFileSchemaToJson() },
      expected_output: {
        type: "object",
        additionalProperties: true,
        properties: {
          format: { type: "string", enum: ["text", "markdown", "json", "patch", "structured"] }
        }
      },
      parent_context: {
        type: "object",
        additionalProperties: false,
        properties: {
          parent_agent: { type: "string" },
          conversation_summary: { type: "string" },
          previous_findings: { type: "array", items: { type: "string" } }
        }
      }
    }
  };
}

function outputOptionsJsonSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      mode: { type: "string", enum: ["compact", "standard", "full"], default: "compact" },
      max_result_chars: { type: "integer", minimum: 200, maximum: 50000, default: 4000 },
      max_findings: { type: "integer", minimum: 0, maximum: 100, default: 8 },
      include_diagnostics: { type: "boolean", default: false },
      include_structured: { type: "boolean", default: false }
    }
  };
}

function skillOptionsJsonSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    description: "父代理 Skill 桥接；默认只注入低 token 的 skill 清单。mode=inline 时仅内联 names 指定的 SKILL.md",
    properties: {
      mode: { type: "string", enum: ["off", "list", "inline"] },
      names: { type: "array", items: { type: "string" } },
      include_project: { type: "boolean" },
      include_user: { type: "boolean" },
      max_skill_chars: { type: "integer", minimum: 200, maximum: 50000 },
      max_total_chars: { type: "integer", minimum: 200, maximum: 100000 }
    }
  };
}

/** 把 TaskFile schema 映射成简短 JSON schema。 */
function taskFileSchemaToJson(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["path", "role", "action"],
    properties: {
      path: { type: "string", description: "相对 cwd 的安全路径" },
      role: { type: "string", enum: ["primary", "reference", "test", "config", "output", "unknown"] },
      action: { type: "string", enum: ["read", "review", "edit", "create", "delete", "ignore"] },
      description: { type: "string" },
      content_mode: { type: "string", enum: ["path_only", "inline", "snippet"] },
      content: { type: "string" },
      line_ranges: { type: "array", items: { type: "object", properties: { start: { type: "integer" }, end: { type: "integer" } } } }
    }
  };
}

function omitProperty(schema: typeof subagentRunInputJsonSchema | typeof subagentReviseInputJsonSchema, key: string): Record<string, unknown> {
  const properties = { ...(schema.properties as Record<string, unknown>) };
  delete properties[key];
  return { ...schema, properties };
}

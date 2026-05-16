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

/** subagent_run 输入 zod schema。 */
export const subagentRunInputSchema = z.object({
  agent_type: z.string().min(1).optional(),
  task: subagentTaskSchema,
  cwd: z.string().optional(),
  timeout_secs: z.number().int().positive().max(24 * 60 * 60).optional(),
  inactivity_timeout_secs: z.number().int().positive().max(24 * 60 * 60).optional(),
  mode: z.enum(["analyze", "review", "edit", "implement", "debug", "custom"]).default("analyze"),
  mcp_server_profiles: z.array(z.string()).max(16).optional(),
  skills: skillBridgeSchema.optional(),
  output: outputOptionsSchema.optional()
}).strict();

/** subagent_list 输入 zod schema。 */
export const subagentListInputSchema = z.object({}).strict();

/** subagent_run MCP JSON Schema。保持简洁，减少主 agent 工具 schema token。 */
export const subagentRunInputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["task"],
  properties: {
    agent_type: { type: "string", description: "可选；默认 claude 或环境变量指定的默认 agent" },
    cwd: { type: "string", description: "可选；绝对工作目录。默认当前工作区；高级场景可用 ACP_SUBAGENT_WORKSPACE_ROOTS 限制" },
    mode: { type: "string", enum: ["analyze", "review", "edit", "implement", "debug", "custom"], default: "analyze" },
    timeout_secs: { type: "integer", minimum: 1 },
    inactivity_timeout_secs: { type: "integer", minimum: 1 },
    mcp_server_profiles: { type: "array", items: { type: "string" }, description: "只允许引用 profile；禁止动态 command" },
    skills: {
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
    },
    output: {
      type: "object",
      additionalProperties: false,
      properties: {
        mode: { type: "string", enum: ["compact", "standard", "full"], default: "compact" },
        max_result_chars: { type: "integer", minimum: 200, maximum: 50000, default: 4000 },
        max_findings: { type: "integer", minimum: 0, maximum: 100, default: 8 },
        include_diagnostics: { type: "boolean", default: false },
        include_structured: { type: "boolean", default: false }
      }
    },
    task: {
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
        files: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["path", "role", "action"],
            properties: {
              path: { type: "string", description: "相对 cwd 的安全路径" },
              role: { type: "string", enum: ["primary", "reference", "test", "config", "output", "unknown"] },
              action: { type: "string", enum: ["read", "review", "edit", "create", "delete", "ignore"] },
              description: { type: "string" },
              content_mode: { type: "string", enum: ["path_only", "inline", "snippet"], default: "path_only" },
              content: { type: "string" },
              line_ranges: {
                type: "array",
                items: {
                  type: "object",
                  required: ["start", "end"],
                  properties: { start: { type: "integer" }, end: { type: "integer" } }
                }
              }
            }
          }
        },
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
    }
  }
} as const;

/** subagent_list MCP JSON Schema。 */
export const subagentListInputJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {}
} as const;

/** subagent_run 输出 JSON Schema，供支持 outputSchema 的 MCP client 使用。 */
export const subagentRunOutputJsonSchema = {
  type: "object",
  additionalProperties: true,
  required: ["schema_version", "status", "agent_type", "summary", "result", "metrics", "errors"],
  properties: {
    schema_version: { type: "integer", const: 1 },
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

/** subagent_start 输入 zod schema。 */
export const subagentStartInputSchema = subagentRunInputSchema.extend({
  keep_alive: z.boolean().default(false),
  conflict_policy: z.enum(["allow_readonly_parallel", "single_writer_per_cwd", "sandbox_worktree"]).optional()
});

/** subagent_start_many 输入 zod schema。 */
export const subagentStartManyInputSchema = z.object({
  tasks: z.array(subagentStartInputSchema.omit({ conflict_policy: true })).min(1).max(32),
  conflict_policy: z.enum(["allow_readonly_parallel", "single_writer_per_cwd", "sandbox_worktree"]).optional(),
  on_task_failure: z.enum(["keep_others_running", "cancel_all"]).default("keep_others_running")
}).strict();

/** subagent_wait 输入 zod schema。 */
export const subagentWaitInputSchema = z.object({
  task_ids: z.array(z.string().min(1)).min(1).max(64),
  return_when: z.enum(["all_completed", "first_completed", "first_success", "first_failure", "any_update", "timeout_partial"]),
  timeout_secs: z.number().int().positive().max(24 * 60 * 60).optional(),
  on_timeout: z.enum(["keep_running", "cancel_pending"]).default("keep_running")
}).strict();

/** subagent_result 输入 zod schema。 */
export const subagentResultInputSchema = z.object({
  task_id: z.string().min(1),
  include_events: z.boolean().default(false),
  include_raw_output: z.boolean().default(false),
  max_chars: z.number().int().min(200).max(50000).default(4000)
}).strict();

/** subagent_continue 输入 zod schema。 */
export const subagentContinueInputSchema = z.object({
  task_id: z.string().min(1),
  message: z.string().min(1),
  correction: z.object({
    reason: z.string().min(1),
    rejected_result: z.string().optional(),
    expected_change: z.string().optional()
  }).strict().optional(),
  additional_files: z.array(taskFileSchema).max(200).optional(),
  mode: z.enum(["revise", "fix", "clarify", "continue", "custom"]).default("continue"),
  timeout_secs: z.number().int().positive().max(24 * 60 * 60).optional(),
  inactivity_timeout_secs: z.number().int().positive().max(24 * 60 * 60).optional(),
  skills: skillBridgeSchema.optional(),
  output: outputOptionsSchema.optional()
}).strict();

/** subagent_cancel 输入 zod schema。 */
export const subagentCancelInputSchema = z.object({
  task_ids: z.array(z.string().min(1)).min(1).max(64),
  reason: z.string().optional()
}).strict();

/** subagent_close 输入 zod schema。 */
export const subagentCloseInputSchema = z.object({
  task_id: z.string().min(1),
  force: z.boolean().default(false)
}).strict();

/** subagent_logs 输入 zod schema。 */
export const subagentLogsInputSchema = z.object({
  task_id: z.string().min(1),
  log_type: z.enum(["events", "stderr", "result", "prompt", "task"]).default("events"),
  max_bytes: z.number().int().min(200).max(1_000_000).default(20000),
  redacted: z.boolean().default(true)
}).strict();

/** start 工具 JSON schema。 */
export const subagentStartInputJsonSchema = {
  ...subagentRunInputJsonSchema,
  properties: {
    ...subagentRunInputJsonSchema.properties,
    keep_alive: { type: "boolean", default: false, description: "完成后是否保留 session 以支持 continue" },
    conflict_policy: { type: "string", enum: ["allow_readonly_parallel", "single_writer_per_cwd", "sandbox_worktree"] }
  }
} as const;

/** start_many 工具 JSON schema。 */
export const subagentStartManyInputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["tasks"],
  properties: {
    tasks: { type: "array", minItems: 1, maxItems: 32, items: subagentStartInputJsonSchema },
    conflict_policy: { type: "string", enum: ["allow_readonly_parallel", "single_writer_per_cwd", "sandbox_worktree"] },
    on_task_failure: { type: "string", enum: ["keep_others_running", "cancel_all"], default: "keep_others_running" }
  }
} as const;

/** wait 工具 JSON schema。 */
export const subagentWaitInputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["task_ids", "return_when"],
  properties: {
    task_ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 64 },
    return_when: { type: "string", enum: ["all_completed", "first_completed", "first_success", "first_failure", "any_update", "timeout_partial"] },
    timeout_secs: { type: "integer", minimum: 1 },
    on_timeout: { type: "string", enum: ["keep_running", "cancel_pending"], default: "keep_running" }
  }
} as const;

/** result 工具 JSON schema。 */
export const subagentResultInputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["task_id"],
  properties: {
    task_id: { type: "string" },
    include_events: { type: "boolean", default: false },
    include_raw_output: { type: "boolean", default: false },
    max_chars: { type: "integer", minimum: 200, maximum: 50000, default: 4000 }
  }
} as const;

/** continue 工具 JSON schema。 */
export const subagentContinueInputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["task_id", "message"],
  properties: {
    task_id: { type: "string" },
    message: { type: "string" },
    correction: {
      type: "object",
      additionalProperties: false,
      properties: {
        reason: { type: "string" },
        rejected_result: { type: "string" },
        expected_change: { type: "string" }
      }
    },
    additional_files: { type: "array", items: taskFileSchemaToJson() },
    mode: { type: "string", enum: ["revise", "fix", "clarify", "continue", "custom"], default: "continue" },
    timeout_secs: { type: "integer", minimum: 1 },
    inactivity_timeout_secs: { type: "integer", minimum: 1 },
    skills: subagentRunInputJsonSchema.properties.skills,
    output: subagentRunInputJsonSchema.properties.output
  }
} as const;

/** cancel 工具 JSON schema。 */
export const subagentCancelInputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["task_ids"],
  properties: {
    task_ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 64 },
    reason: { type: "string" }
  }
} as const;

/** close 工具 JSON schema。 */
export const subagentCloseInputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["task_id"],
  properties: {
    task_id: { type: "string" },
    force: { type: "boolean", default: false }
  }
} as const;

/** logs 工具 JSON schema。 */
export const subagentLogsInputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["task_id"],
  properties: {
    task_id: { type: "string" },
    log_type: { type: "string", enum: ["events", "stderr", "result", "prompt", "task"], default: "events" },
    max_bytes: { type: "integer", minimum: 200, maximum: 1000000, default: 20000 },
    redacted: { type: "boolean", default: true }
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

/** 把 TaskFile schema 映射成简短 JSON schema。 */
function taskFileSchemaToJson(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["path", "role", "action"],
    properties: {
      path: { type: "string" },
      role: { type: "string", enum: ["primary", "reference", "test", "config", "output", "unknown"] },
      action: { type: "string", enum: ["read", "review", "edit", "create", "delete", "ignore"] },
      description: { type: "string" },
      content_mode: { type: "string", enum: ["path_only", "inline", "snippet"] },
      content: { type: "string" },
      line_ranges: { type: "array", items: { type: "object", properties: { start: { type: "integer" }, end: { type: "integer" } } } }
    }
  };
}

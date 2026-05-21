import { z } from "zod";

/** 文件行号范围输入校验。 */
export const lineRangeSchema = z.object({
  start: z.number().int().positive().describe("起始行号，从 1 开始"),
  end: z.number().int().positive().describe("结束行号，必须大于等于 start"),
});

/** 子代理文件输入校验。 */
export const taskFileSchema = z.object({
  path: z.string().min(1).describe("文件路径，必须相对 cwd，不能路径穿越"),
  role: z.enum(["primary", "reference", "test", "config", "output", "unknown"]).describe("文件在任务中的角色"),
  action: z.enum(["read", "review", "edit", "create", "delete", "ignore"]).describe("允许对子代理执行的文件动作"),
  description: z.string().optional().describe("文件说明"),
  line_ranges: z.array(lineRangeSchema).optional().describe("需要关注的行号范围"),
  content: z.string().optional().describe("内联文件内容或片段"),
  content_mode: z.enum(["path_only", "inline", "snippet"]).optional().describe("文件内容传递方式"),
});

/** 期望输出输入校验。 */
export const expectedOutputSchema = z.object({
  format: z.enum(["text", "markdown", "json", "patch", "structured"]).describe("期望输出格式"),
  required_sections: z.array(z.string()).optional().describe("必须包含的章节"),
  json_schema: z.record(z.unknown()).optional().describe("JSON Schema"),
  include_files_changed: z.boolean().optional().describe("是否要求返回改动文件列表"),
  include_risks: z.boolean().optional().describe("是否要求返回风险说明"),
  include_next_steps: z.boolean().optional().describe("是否要求返回下一步建议"),
});

/** 子代理任务输入校验。 */
export const subagentTaskSchema = z.object({
  title: z.string().min(1).describe("任务标题"),
  goal: z.string().min(1).describe("任务目标"),
  background: z.string().optional().describe("背景信息"),
  instructions: z.array(z.string()).optional().describe("具体执行指令"),
  files: z.array(taskFileSchema).optional().describe("子代理需要处理的文件列表"),
  constraints: z.array(z.string()).optional().describe("任务约束"),
  expected_output: expectedOutputSchema.optional().describe("期望输出格式"),
  success_criteria: z.array(z.string()).optional().describe("成功标准"),
  parent_context: z
    .object({
      parent_agent: z.string().optional().describe("父代理名称或主 agent 标识"),
      conversation_summary: z.string().optional().describe("对话摘要"),
      previous_findings: z.array(z.string()).optional().describe("前序发现"),
    })
    .optional()
    .describe("父代理传递给子代理的必要上下文摘要"),
});

/** subagent_run 输入校验。 */
export const subagentRunSchema = z.object({
  agent_type: z.string().min(1).describe("要调用的子代理类型，必须存在于 agents.toml"),
  task: subagentTaskSchema.describe("结构化子代理任务"),
  cwd: z.string().optional().describe("子代理运行时工作目录，必须是绝对路径；未传时使用当前工作目录"),
  timeout_secs: z.number().positive().optional().describe("整个任务最大运行时间，单位秒"),
  inactivity_timeout_secs: z.number().positive().optional().describe("无有效输出时最大等待时间，单位秒"),
  heartbeat_timeout_secs: z.number().positive().optional().describe("子代理检测不到主代理心跳时的自关闭等待时间，默认 3 秒"),
  mode: z.enum(["analyze", "review", "edit", "implement", "debug", "custom"]).optional().describe("任务模式"),
  mcp_servers: z.union([z.record(z.unknown()), z.array(z.unknown())]).optional().describe("传递给 ACP session 的 MCP servers 配置"),
  session_pool_policy: z.enum(["auto", "disable", "force_new"]).optional().describe("会话池复用策略"),
  detail_level: z.enum(["summary", "normal", "verbose"]).optional().describe("返回信息详细程度"),
  parent_agent_id: z.string().optional().describe("父代理 ID，用于会话池隔离"),
});

/** subagent_start 输入校验。 */
export const subagentStartSchema = subagentRunSchema.extend({
  keep_alive: z.boolean().optional().describe("是否在任务完成后保留 session，以支持 continue"),
});

/** subagent_start_many 输入校验。 */
export const subagentStartManySchema = z.object({
  tasks: z.array(subagentStartSchema).min(1).describe("要并行启动的任务列表"),
  conflict_policy: z
    .enum(["allow_readonly_parallel", "single_writer_per_cwd", "sandbox_worktree"])
    .optional()
    .describe("并行任务的文件冲突处理策略"),
  on_task_failure: z.enum(["keep_others_running", "cancel_all"]).optional().describe("单个任务失败后其他任务如何处理"),
});

/** subagent_wait 输入校验。 */
export const subagentWaitSchema = z.object({
  task_ids: z.array(z.string()).min(1).describe("要等待的任务 ID 列表"),
  return_when: z
    .enum(["all_completed", "first_completed", "first_success", "first_failure", "any_update", "timeout_partial"])
    .describe("等待策略"),
  timeout_secs: z.number().positive().optional().describe("本次等待最大时间，单位秒"),
  on_timeout: z.enum(["keep_running", "cancel_pending"]).optional().describe("等待超时后如何处理未完成任务"),
});

/** subagent_result 输入校验。 */
export const subagentResultSchema = z.object({
  task_id: z.string().min(1).describe("要查询的任务 ID"),
  include_events: z.boolean().optional().describe("是否包含事件摘要，当前版本仅返回日志路径"),
  include_raw_output: z.boolean().optional().describe("是否包含原始输出，当前版本仅返回日志路径"),
  detail_level: z.enum(["summary", "normal", "verbose"]).optional().describe("返回信息详细程度"),
});

/** subagent_continue 输入校验。 */
export const subagentContinueSchema = z.object({
  task_id: z.string().min(1).describe("要继续对话的任务 ID"),
  message: z.string().min(1).describe("本轮要发送给子代理的新消息"),
  correction: z
    .object({
      reason: z.string().min(1).describe("为什么上一轮结果不正确"),
      rejected_result: z.string().optional().describe("被拒绝的上一轮结果摘要"),
      expected_change: z.string().optional().describe("期望子代理如何修正"),
    })
    .optional()
    .describe("对上一轮结果的纠正说明"),
  additional_files: z.array(taskFileSchema).optional().describe("本轮新增或重新指定的文件"),
  mode: z.enum(["revise", "fix", "clarify", "continue", "custom"]).optional().describe("继续对话的模式"),
  timeout_secs: z.number().positive().optional().describe("本轮最大运行时间，单位秒"),
  detail_level: z.enum(["summary", "normal", "verbose"]).optional().describe("返回信息详细程度"),
});

/** subagent_cancel 输入校验。 */
export const subagentCancelSchema = z.object({
  task_ids: z.array(z.string()).min(1).describe("要取消的任务 ID 列表"),
  reason: z.string().optional().describe("取消原因"),
});

/** subagent_close 输入校验。 */
export const subagentCloseSchema = z.object({
  task_id: z.string().min(1).describe("要关闭的任务 ID"),
  force: z.boolean().optional().describe("是否强制关闭仍在运行的任务"),
});

/** subagent_logs 输入校验。 */
export const subagentLogsSchema = z.object({
  task_id: z.string().min(1).describe("要查询的任务 ID"),
  kind: z.enum(["task", "prompt", "events", "stderr", "result"]).optional().describe("日志类型"),
  max_chars: z.number().int().positive().max(100000).optional().describe("最多读取多少字符"),
});

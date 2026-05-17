import type { SubagentReviseManyInput, SubagentRunManyItem, SubagentRunManyOutput } from "../task/types.js";
import type { SubagentTaskRunnerDependencies } from "../runtime/taskRunner.js";
import { SubagentRuntimeError } from "../runtime/errors.js";
import { rejectDynamicMcpServers } from "../runtime/security.js";
import { subagentReviseManyInputSchema } from "./schemas.js";
import { runBatchSubagents } from "./subagentRunMany.js";

/**
 * 处理 subagent_revise_many：同步批量打回重写。
 */
export async function handleSubagentReviseMany(rawInput: unknown, deps: SubagentTaskRunnerDependencies): Promise<SubagentRunManyOutput> {
  rejectDynamicMcpServers(rawInput);
  const input = subagentReviseManyInputSchema.parse(rawInput) as SubagentReviseManyInput;
  const tasks = input.revisions.map((revision): SubagentRunManyItem => revisionToRunInput(revision, deps));
  const output = await runBatchSubagents({
    tasks,
    conflictPolicy: input.conflict_policy,
    onTaskFailure: input.on_task_failure ?? "keep_others_running",
    deps,
    abortReason: "MCP revise_many call 已取消"
  });
  output.summary = `同步批量重写完成：成功 ${output.completed.length} 个，失败 ${output.failed.length} 个，启动拒绝 ${output.rejected.length} 个，取消 ${output.cancelled_task_ids.length} 个。`;
  return output;
}

/**
 * 把单个打回项转换为一次新的同步 run。
 *
 * revise_many 也不复用上一轮子代理进程；这里显式拼入上一轮结果和审核意见。
 */
function revisionToRunInput(revision: SubagentReviseManyInput["revisions"][number], deps: SubagentTaskRunnerDependencies): SubagentRunManyItem {
  const source = revision.task_id ? deps.registry.get(revision.task_id) : undefined;
  if (revision.task_id && !source && !revision.task) {
    throw new SubagentRuntimeError("invalid_input", `任务不存在或 MCP Server 已重启，请同时传入 task 和 previous_result：${revision.task_id}`);
  }

  const baseTask = revision.task ?? source?.task;
  if (!baseTask) {
    throw new SubagentRuntimeError("invalid_input", "subagent_revise_many 的每一项都需要 task_id，或显式传入 task");
  }

  const previousResult = revision.previous_result ?? (source?.result ? JSON.stringify({
    summary: source.result.summary,
    result: source.result.result,
    findings: source.result.findings,
    files_changed: source.result.files_changed,
    risks: source.result.risks,
    next_steps: source.result.next_steps,
    errors: source.result.errors
  }, null, 2) : undefined);
  if (!previousResult?.trim()) {
    throw new SubagentRuntimeError("invalid_input", "subagent_revise_many 的每一项都需要 previous_result，或 task_id 必须指向已有完成结果");
  }

  const files = mergeFiles(baseTask.files, revision.additional_files);
  const previousFindings = [...(baseTask.parent_context?.previous_findings ?? [])];
  if (revision.task_id) previousFindings.push(`revision_of_task_id=${revision.task_id}`);

  return {
    agent_type: revision.agent_type ?? source?.agentType,
    cwd: revision.cwd ?? source?.cwd,
    timeout_secs: revision.timeout_secs,
    inactivity_timeout_secs: revision.inactivity_timeout_secs,
    mode: revision.mode ?? "custom",
    mcp_server_profiles: revision.mcp_server_profiles,
    skills: revision.skills,
    output: revision.output ?? source?.outputOptions,
    task: {
      ...baseTask,
      title: `重写：${baseTask.title}`,
      background: [
        baseTask.background,
        "上一轮结果被主代理审核后打回，需要重新产出完整结果。",
        `上一轮结果摘要：${truncate(previousResult, 20000)}`,
        `打回原因：${revision.correction.reason}`,
        revision.correction.rejected_result ? `被拒绝结果摘要：${revision.correction.rejected_result}` : undefined,
        revision.correction.expected_change ? `期望修正：${revision.correction.expected_change}` : undefined,
        revision.message ? `额外重写指令：${revision.message}` : undefined
      ].filter(Boolean).join("\n\n"),
      instructions: [
        ...(baseTask.instructions ?? []),
        "这是一次主代理审核后的打回重写。请重新产出完整结果，不要只给差异说明。",
        "必须修正打回原因中指出的问题；无法满足时在 risks 或 errors 中说明。"
      ],
      files,
      parent_context: {
        ...baseTask.parent_context,
        previous_findings: previousFindings
      }
    }
  };
}

function mergeFiles(baseFiles: typeof undefined | NonNullable<SubagentRunManyItem["task"]["files"]>, extraFiles: typeof baseFiles): typeof baseFiles {
  if (!baseFiles?.length && !extraFiles?.length) return undefined;
  const byPath = new Map<string, NonNullable<typeof baseFiles>[number]>();
  for (const file of baseFiles ?? []) byPath.set(file.path, file);
  for (const file of extraFiles ?? []) byPath.set(file.path, file);
  return Array.from(byPath.values());
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n[TRUNCATED]` : text;
}

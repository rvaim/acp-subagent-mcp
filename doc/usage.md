# 使用文档：常见编排方式

## 选择哪个工具

| 目标 | 工具 |
|---|---|
| 运行一个子代理并等待结果 | `subagent_run` |
| 并行运行多个子代理，全部完成后汇总 | `subagent_run_many` |
| 主 agent 审核后打回一个结果 | `subagent_revise` |
| 主 agent 审核后批量打回多个结果 | `subagent_revise_many` |
| 查看可用 agent 和默认配置摘要 | `subagent_list` |
| 查看可桥接 Skills | `subagent_skills` |

## 单个子代理

```json
{
  "cwd": "/repo/app",
  "mode": "review",
  "task": {
    "title": "审查登录模块",
    "goal": "找出登录模块中阻塞上线的安全和稳定性问题。",
    "files": [
      { "path": "src/auth/login.ts", "role": "primary", "action": "review" }
    ],
    "constraints": ["不要修改文件，只做审查。"],
    "expected_output": {
      "format": "structured",
      "include_risks": true,
      "include_next_steps": true
    }
  },
  "output": {
    "mode": "compact",
    "max_result_chars": 6000
  }
}
```

返回结果会包含 `task_id`。这个 id 不是后台任务查询句柄，只用于之后打回重写时引用原任务和原结果。

## 多个子代理并行处理，全部完成后再处理

```json
{
  "conflict_policy": "allow_readonly_parallel",
  "tasks": [
    {
      "cwd": "/repo/app",
      "mode": "review",
      "task": { "title": "审查 auth", "goal": "审查 src/auth 目录。" }
    },
    {
      "cwd": "/repo/app",
      "mode": "review",
      "task": { "title": "审查 billing", "goal": "审查 src/billing 目录。" }
    },
    {
      "cwd": "/repo/app",
      "mode": "review",
      "task": { "title": "审查 tests", "goal": "审查测试覆盖缺口。" }
    }
  ]
}
```

`subagent_run_many` 返回时，所有子代理都已经完成、失败、超时或被取消。主 agent 可以直接读取：

- `completed`：成功或部分成功的结果；
- `failed`：失败、超时或取消的结果；
- `rejected`：启动阶段就被拒绝的输入；
- `cancelled_task_ids`：取消的任务 ID。

不会返回 pending 列表。

## 主 agent 审核后打回重写

主 agent 收到子代理结果后，可以按自己的标准审核。如果某个结果不合格，调用：

```json
{
  "task_id": "task_abc123",
  "correction": {
    "reason": "结果只给了结论，没有列出对应文件和风险等级。",
    "expected_change": "重新输出完整审查结果，必须包含文件、风险等级、证据和修复建议。"
  },
  "message": "不要只说明改了什么，直接给出完整可交付结果。"
}
```

`subagent_revise` 会启动新的子代理进程，把原任务、上一轮结果和打回意见写入 prompt，并同步等待重写完成。

如果 MCP Server 已重启，原 `task_id` 的内存元数据不存在，可以显式传入 `task` 和 `previous_result`：

```json
{
  "task": {
    "title": "审查登录模块",
    "goal": "找出阻塞上线的问题。"
  },
  "previous_result": "上一轮结果文本或 JSON 摘要",
  "correction": {
    "reason": "遗漏异常路径。",
    "expected_change": "补充异常路径分析。"
  },
  "cwd": "/repo/app"
}
```

## 批量打回重写

```json
{
  "conflict_policy": "allow_readonly_parallel",
  "revisions": [
    {
      "task_id": "task_auth",
      "correction": {
        "reason": "没有覆盖登录失败分支。",
        "expected_change": "补充失败分支和锁定策略。"
      }
    },
    {
      "task_id": "task_billing",
      "correction": {
        "reason": "没有区分高低风险。",
        "expected_change": "按风险等级重新组织结果。"
      }
    }
  ]
}
```

`subagent_revise_many` 内部并行执行所有重写任务，全部返回后主 agent 再处理。每个重写结果会带 `revision_of_task_id`。

## 并发冲突策略

| 策略 | 说明 |
|---|---|
| `allow_readonly_parallel` | 允许并行，只适合只读审查和分析。 |
| `single_writer_per_cwd` | 默认；同一工作区同时只允许一个写任务。 |
| `sandbox_worktree` | 使用 git worktree 沙箱执行写任务；需要启用 `[worktree].enabled`。 |

## 输出压缩

默认 `output.mode=compact`，适合主 agent 只需要可执行摘要。需要更多信息时：

```json
{
  "output": {
    "mode": "full",
    "max_result_chars": 20000,
    "include_diagnostics": true,
    "include_structured": true
  }
}
```

`max_result_chars` 上限是 `50000`。

## Skill 桥接

默认 `skills.mode=list`，只把可见 Skill 的名称和描述注入给子代理。需要内联指定 Skill 时：

```json
{
  "skills": {
    "mode": "inline",
    "names": ["code-review"],
    "max_skill_chars": 8000,
    "max_total_chars": 20000
  }
}
```

## 调试

查看返回结果中的 `artifacts` 路径：

- `event_log`：ACP 事件日志；
- `stderr_log`：子代理 stderr；
- `result_json`：最终结果；
- `run_dir`：本次运行目录。

日志默认脱敏。prompt 保存策略由 `[logs].save_rendered_prompt` 控制。

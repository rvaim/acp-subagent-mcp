# 实现交付说明

## 已完成内容

本项目已经实现为一个 TypeScript MCP Server，核心能力包括：

- MCP stdio server 启动入口。
- `agents.toml` 加载与校验。
- `subagent_list`。
- `subagent_run`。
- `subagent_start`。
- `subagent_start_many`。
- `subagent_wait`。
- `subagent_result`。
- `subagent_continue`。
- `subagent_cancel`。
- `subagent_close`。
- `subagent_logs`。
- 通用 ACP client。
- JSON-RPC over stdio 传输层。
- ACP `initialize`、`session/new`、`session/prompt`、`session/cancel`、可选 `session/close`。
- 任务 prompt 中文渲染。
- JSON 和自然语言结果宽容解析。
- wall-clock timeout。
- inactivity timeout。
- 默认 3 秒 heartbeat timeout。
- 任务取消与进程清理。
- 日志记录与脱敏。
- cwd 和任务文件路径安全校验。
- 权限策略自动处理。
- 输出压缩和 `detail_level`。
- 基础会话池。
- 中文 README、中文 DESIGN 和详细 `doc/` 文档。

## 验证记录

已经执行并通过：

```bash
npm run check
npm run build
```

已经使用 `examples/fake-acp-agent.mjs` 验证：

- `SubagentRuntime.run(...)` 可以完成 fake ACP agent 的 `initialize`、`session/new`、`session/prompt` 链路。
- `SubagentRuntime.start(...)`、`wait(...)`、`continue(...)`、`close(...)` 可以完成异步和多轮链路。

## 当前限制

- `sandbox_worktree` 仅保留配置入口和文档说明，尚未实现真实 git worktree 隔离、diff 提取和合并。
- 会话池是内存池，MCP Server 进程退出后不会保留池化 session。
- `subagent_start` 会立即返回，返回瞬间 `session_id` 可能还没有创建完成；后续可通过 `subagent_result` 或 `subagent_wait` 查询。
- 真实 ACP agent 的具体行为取决于对应 agent adapter 是否完整实现 ACP。

## 推荐下一步

1. 用 fake agent 在你的 MCP Host 中跑通工具发现和工具调用。
2. 把 `examples/agents.toml` 复制成真实 `agents.toml`。
3. 增加一个真实 ACP agent，例如 `gemini --acp` 或你自己的 ACP adapter。
4. 用只读 review 任务先验证安全边界，再逐步开放 edit 权限。

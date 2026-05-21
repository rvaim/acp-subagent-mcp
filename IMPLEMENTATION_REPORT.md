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


## 0.1.1 取消与心跳修复记录

这版修复了一个会导致 Claude 子进程残留的问题：上一版只实现了 `subagent_cancel` 工具和超时清理，但 MCP Host 停止当前 `tools/call` 时，SDK 会通过 tool handler 的第二个参数 `extra.signal` 传递取消信号；旧实现没有监听该信号，所以 Host 已停止等待，但 ACP 子进程仍可能继续运行。

本版变更：

- `server.ts` 将 `extra.signal` 传给 `SubagentRuntime.run/start/startMany/wait/continue`。
- `SubagentRuntime` 将 MCP cancellation 映射为运行时取消，写入 `MCP_REQUEST_CANCELLED` 错误码。
- `subagent_wait` 被取消时，会取消它正在等待的任务，避免异步任务后台继续跑。
- `runtime.shutdown()` 现在会取消所有活跃任务，再清理会话池。
- stdio 连接 `end/close`、`SIGINT`、`SIGTERM` 都会触发运行时清理。
- `GenericAcpClient.shutdown()` 改为幂等，避免多路取消重复清理造成竞态。
- `processManager.ts` 增强为进程树清理：类 Unix 下先杀进程组，再按 `ps -eo pid=,ppid=` 补杀后代；Windows 下使用 `taskkill /T`。
- 即使根进程已退出，也会在宽限期后补发 `SIGKILL`，处理忽略 `SIGTERM` 的 Claude/Node 孙进程。

已额外验证：

```bash
npm run check
npm run build
```

并用一个会忽略 `session/cancel`、忽略 `SIGTERM`、同时拉起孙进程的假 ACP agent 验证：

- MCP `notifications/cancelled` 可以触发 `extra.signal`，并杀掉孙进程。
- `heartbeat_timeout_secs=1` 时，心跳超时会返回 `heartbeat_timeout`，并杀掉孙进程。

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

## 0.1.11 心跳、权限和会话池修复记录

本版针对三类回归做了修复：

- 心跳改为主动 JSON-RPC 往返：MCP Server 周期性发送 `$/subagent_mcp/heartbeat`，子代理监督包装器立即回复；MCP Server 通过回复确认子代理 stdio 链路仍然存在。
- 子代理监督包装器不再依赖 `parent-heartbeat.json` 文件；如果默认 3 秒内收不到主代理心跳，会主动关闭自身和真实 ACP agent 进程树。
- `heartbeat_timeout_secs` 默认值从 60 秒改为 3 秒，并新增主代理侧 heartbeat watchdog。
- 默认权限策略改为全部允许：`read/search/edit/execute/network = allow`。如果需要更保守，可在 `agents.toml` 中显式覆盖。
- `fs/read_text_file` 和 `fs/write_text_file` 改用合并后的权限策略，避免 agent 专属配置缺省时回退到拒绝写入。
- 会话池修复了 `mode` 默认值不一致导致的错失复用：未传 `mode` 时统一归一为 `analyze`。
- 新增会话池 `peek`，渲染 prompt 时可带入池化会话摘要；实际执行时再 `acquire`。
- 池化复用同一个 ACP client 时会切换当前任务的 events/stderr 日志路径，避免复用后日志仍写入旧任务目录。
- 新增回归测试：默认心跳下长工具调用、取消/进程树清理、会话池复用、默认写权限。

验证命令：

```bash
npm run check
npm run test:regression
```

# @rvaim/acp-subagent-mcp

通用 ACP 子代理 MCP Server。主 agent 通过 MCP tools 派发任务，本服务在内部拉起支持 ACP 的子代理，并负责同步等待、并行编排、打回重写、取消、超时、日志、安全校验、Skill 桥接和低 token 结果返回。

当前版本采用 **同步工具语义**：主 agent 调用工具后，要么等待子代理全部完成，要么当前 MCP request 被取消后立即进入清理。工具不会向主 agent 暴露后台 pending 任务，也不会要求主 agent 再循环查询任务结果。

默认不需要 `agents.toml`。默认子代理名称是 `claude`，默认尝试执行的命令是 `claude-agent-acp`。本包不会把 Claude、Codex、Gemini 或任何具体 ACP adapter 作为依赖自动安装。

## 文档

- [生命周期与取消语义](doc/lifecycle.md)
- [使用文档：常见编排方式](doc/usage.md)
- [API 文档：MCP tools 输入输出](doc/api.md)
- [配置文档：环境变量、agents.toml、安全与日志](doc/configuration.md)

## 核心语义

- `subagent_run`：同步运行一个子代理，子代理完成、失败、超时或被取消后才返回。
- `subagent_run_many`：同步并行运行多个子代理；内部并发，全部任务进入终态后才返回；返回中没有 `pending_task_ids`。
- `subagent_revise`：同步打回重写一个结果；不保留旧子代理进程，只把原任务、上一轮结果和审核意见作为新任务上下文。
- `subagent_revise_many`：同步并行打回重写多个结果；全部重写任务进入终态后才返回。
- `subagent_list`：列出可用 agent、默认 agent 和 Skill 桥接状态。
- `subagent_skills`：查询可桥接给子代理的 Skills。

已移除旧的异步后台任务接口。也就是说，不再有“启动后返回 task id、稍后再等待或查询”的工具层语义；task id 只用于把已完成结果打回重写。

## 为什么改成同步

旧的“先返回一部分结果，再由主 agent 循环等待剩余任务”会产生一个空窗：工具调用已经返回，但子代理还在 MCP Server 内继续运行。如果 Host 在这个空窗里只停止主 agent 文本生成，而没有向 MCP Server 发送 request cancellation，MCP Server 无法立刻知道用户点了停止。

同步模型把用户可能点击停止的时间尽量留在当前 MCP request 内：

```text
主 agent 调用 subagent_run_many
  -> MCP Server 内部并行启动多个 ACP 子代理
  -> 当前 tool call 一直等待所有子代理完成
  -> Host 取消当前 tool call 时，request AbortSignal 级联到所有运行中子代理
  -> MCP Server 执行 ACP cancel + 本地进程树清理
```

这能消除旧模型中的 pending 任务窗口。仍然需要保留进程级兜底：如果某个 Host 完全不发送 request cancellation、也不关闭 MCP transport，那么服务端无法瞬间感知用户操作，只能依靠 `inactivity_timeout_secs`、任务总超时、transport close 或进程退出钩子清理。

## 重要边界

本项目只发布通用 MCP 调度层，不绑定任何具体子代理实现：

- 不依赖 Claude SDK、Codex SDK、Gemini SDK。
- 不依赖 `@agentclientprotocol/claude-agent-acp`、`codex-acp`、`gemini` 等具体 ACP adapter。
- 默认 agent 名称是 `claude`，但默认命令 `claude-agent-acp` 只会从用户环境的 `PATH` 中查找。
- 如果命令不存在，MCP tool 会返回可恢复错误和配置提示，不会在运行时自动安装。

本项目依赖官方通用 ACP SDK：

```text
@agentclientprotocol/sdk
```

它不是 Claude、Codex、Gemini 的平台 SDK，也不是某个具体 agent adapter。它只提供 ACP 协议的 TypeScript 实现。本项目使用其中的 `ClientSideConnection` 和 `ndJsonStream` 作为 ACP Client。

## 安装

### 方式一：直接用 npx

```bash
npx -y @rvaim/acp-subagent-mcp
```

### 方式二：全局安装

```bash
npm install -g @rvaim/acp-subagent-mcp
acp-subagent-mcp
```

## 快速配置：Claude Desktop

Claude Desktop 使用 `claude_desktop_config.json` 启动本地 MCP Server。

常见位置：

```text
macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json
Windows: %APPDATA%\Claude\claude_desktop_config.json
```

配置片段：

```json
{
  "mcpServers": {
    "acp-subagent": {
      "command": "npx",
      "args": ["-y", "@rvaim/acp-subagent-mcp"],
      "env": {
        "ACP_SUBAGENT_DEFAULT_AGENT": "claude",
        "ACP_SUBAGENT_ENV_POLICY": "all",
        "ACP_SUBAGENT_SKILL_MODE": "list"
      }
    }
  }
}
```

也可以生成示例配置：

```bash
npx -y @rvaim/acp-subagent-mcp --print-claude-desktop-config
```

保存后完全退出并重启 Claude Desktop。

## 快速配置：Codex CLI / Codex IDE Extension

用命令添加：

```bash
codex mcp add acp-subagent -- npx -y @rvaim/acp-subagent-mcp
```

如需显式转发环境变量，编辑 `~/.codex/config.toml` 或项目级 `.codex/config.toml`：

```toml
[mcp_servers.acp-subagent]
command = "npx"
args = ["-y", "@rvaim/acp-subagent-mcp"]
env_vars = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "CLAUDE_CONFIG_DIR",
  "OPENAI_API_KEY",
  "CODEX_HOME",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY"
]

[mcp_servers.acp-subagent.env]
ACP_SUBAGENT_DEFAULT_AGENT = "claude"
ACP_SUBAGENT_ENV_POLICY = "all"
ACP_SUBAGENT_SKILL_MODE = "list"
```

生成示例：

```bash
npx -y @rvaim/acp-subagent-mcp --print-codex-config
```

## 基本调用示例

同步运行一个子代理：

```json
{
  "cwd": "/path/to/project",
  "mode": "review",
  "task": {
    "title": "审查登录模块",
    "goal": "找出阻塞上线的问题，只返回高风险项。",
    "files": [
      { "path": "src/auth/login.ts", "role": "primary", "action": "review" }
    ],
    "expected_output": { "format": "structured", "include_risks": true }
  }
}
```

同步并行运行多个子代理：

```json
{
  "conflict_policy": "allow_readonly_parallel",
  "tasks": [
    {
      "cwd": "/path/to/project",
      "mode": "review",
      "task": { "title": "审查认证", "goal": "审查 auth 目录。" }
    },
    {
      "cwd": "/path/to/project",
      "mode": "review",
      "task": { "title": "审查支付", "goal": "审查 billing 目录。" }
    }
  ]
}
```

打回重写一个结果：

```json
{
  "task_id": "task_abc123",
  "correction": {
    "reason": "结果没有覆盖异常路径。",
    "expected_change": "补充异常路径分析，并重新返回完整结论。"
  }
}
```

批量打回重写：

```json
{
  "conflict_policy": "allow_readonly_parallel",
  "revisions": [
    {
      "task_id": "task_a",
      "correction": { "reason": "遗漏测试建议。", "expected_change": "补充测试建议。" }
    },
    {
      "task_id": "task_b",
      "correction": { "reason": "结论太泛。", "expected_change": "给出可执行修改点。" }
    }
  ]
}
```

## 常用环境变量

| 变量 | 作用 | 默认值 |
|---|---|---|
| `ACP_SUBAGENT_DEFAULT_AGENT` | 默认子代理名称 | `claude` |
| `ACP_SUBAGENT_DEFAULT_AGENT_COMMAND` | 默认 ACP 子代理命令 | `claude-agent-acp` |
| `ACP_SUBAGENT_DEFAULT_AGENT_ARGS` | 默认 ACP 子代理参数，支持 JSON array | 空 |
| `ACP_SUBAGENT_ENV_POLICY` | 默认环境继承策略：`all/allowlist/none` | `all` |
| `ACP_SUBAGENT_ENV_ALLOWLIST` | `allowlist` 策略使用的变量名或前缀通配列表 | 空 |
| `ACP_SUBAGENT_WORKSPACE_ROOTS` | 可选；严格限制子代理可使用的工作区根目录 | 空 |
| `ACP_SUBAGENT_AUTO_WORKSPACE_ROOTS` | 未设置严格根目录时，是否自动信任本次 `cwd` | `true` |
| `ACP_SUBAGENT_TIMEOUT_SECS` | 默认任务总超时 | `600` |
| `ACP_SUBAGENT_INACTIVITY_TIMEOUT_SECS` | 默认无活动超时 | `15` |
| `ACP_SUBAGENT_MCP_REQUEST_HEARTBEAT_MS` | 长 tool call 的 MCP progress heartbeat 间隔 | `1000` |
| `ACP_SUBAGENT_ACP_CANCEL_GRACE_MS` | 收到取消后等待 ACP cancel 正常结束的宽限时间 | `500` |
| `ACP_SUBAGENT_PROCESS_KILL_GRACE_MS` | SIGTERM 后等待 SIGKILL 的宽限时间 | `500` |
| `ACP_SUBAGENT_MAX_PARALLEL_TASKS` | 最大并发任务数 | `4` |
| `ACP_SUBAGENT_LOG_DIR` | 日志目录 | `.subagents/runs` |
| `ACP_SUBAGENT_SKILL_MODE` | Skill 注入模式：`off/list/inline` | `list` |

## 开发与验证

```bash
npm install
npm run check
npm run build
npm run smoke
```

`npm run smoke` 覆盖同步单任务、同步批量任务、同步打回、同步批量打回、request cancellation、顽固子进程清理和脱离进程组的孙进程清理。

# acp-subagent-mcp

通用 ACP 子代理 MCP Server。主 agent 通过 MCP tools 派发任务，本服务在内部拉起支持 ACP 的子代理，负责会话、并发、多轮、取消、超时、日志、安全校验、Skill 桥接和低 token 结果返回。

默认不需要 `agents.toml`。安装后可以直接通过 MCP Host 启动；默认子代理名称是 `claude`，默认尝试执行的命令是 `claude-agent-acp`。本包不会把 Claude、Codex、Gemini 或任何具体 ACP adapter 作为依赖自动安装。

## 文档

- [生命周期、同步/异步与取消语义](doc/lifecycle.md)
- [使用文档：常见编排方式](doc/usage.md)
- [API 文档：MCP tools 输入输出](doc/api.md)
- [配置文档：环境变量、agents.toml、安全与日志](doc/configuration.md)

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

它不是 Claude、Codex、Gemini 的平台 SDK，也不是某个具体 agent adapter。它只提供 ACP 协议的 TypeScript 实现。本项目使用其中的 `ClientSideConnection` 和 `ndJsonStream` 作为 ACP Client，不手写 ACP JSON-RPC transport。

## 特性

- 默认 Claude 子代理：`agent_type` 可省略，自动使用 `claude`。
- 支持 npm / npx / Claude Desktop / Codex CLI / Codex 配置文件 / 通用 MCP Host 的 stdio 配置方式。
- 支持主 agent Skill 桥接：默认扫描项目级 `.claude/skills` 和用户级 `~/.claude/skills`，以低 token 清单形式注入给子代理。
- 支持同步、异步、批量并发运行、多轮、取消、关闭和日志读取；多任务强绑定取消建议使用 `subagent_run_many`。
- 默认 compact 输出，减少主 agent token 消耗。
- 默认环境变量策略是 `all`，子代理会继承 MCP Server 进程可见的全部环境变量；需要收紧时可改成 `allowlist` 或 `none`。
- 默认禁止动态 `mcp_servers`，只能引用配置或环境变量中受信的 profile。
- 默认 `execute=deny`，不向 ACP agent 声明 terminal capability。

## 停止会话时的默认清理策略

推荐把本服务配置成真实 MCP Server 后，直接调用 `subagent_run_many` 或在 `subagent_start_many` 后立刻进入 `subagent_wait`。当 Host 把用户“停止当前响应”传播为 MCP request cancellation 时，本服务会立即进入强制清理路径：ACP `session/cancel` 只作为 best-effort，默认最多等待 500ms，然后清理本地进程树，必要时使用 `SIGKILL`。

如果 Host 只停止模型文本输出、没有取消 MCP request，也没有关闭 stdio transport，MCP Server 无法立刻知道用户点击了停止。为了避免这种情况下子代理继续运行很久，默认 `inactivity_timeout_secs` 已下调为 15 秒，作为无 ACP 协议层活动时的兜底清理。

## 安装

### 方式一：直接用 npx

```bash
npx -y acp-subagent-mcp
```

### 方式二：全局安装

```bash
npm install -g acp-subagent-mcp
acp-subagent-mcp
```

## 默认 Claude 子代理

本 MCP Server 默认会尝试执行：

```bash
claude-agent-acp
```

这只是一个默认命令名，不代表本包会自动安装 Claude adapter，也不会把 Claude SDK 或某个具体 ACP adapter 打进依赖。这样可以保持本项目的通用边界：本 MCP 只负责调度 ACP 子进程，具体子代理由用户环境提供。

如果你的环境里没有这个命令，运行任务时会返回明确提示。可以通过环境变量指定已有命令或绝对路径：

```bash
ACP_SUBAGENT_DEFAULT_AGENT_COMMAND=/absolute/path/to/claude-agent-acp acp-subagent-mcp
```

## 快速配置：Claude Desktop

Claude Desktop 使用 `claude_desktop_config.json` 启动本地 MCP Server。

常见位置：

```text
macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json
Windows: %APPDATA%\Claude\claude_desktop_config.json
```

也可以在 Claude Desktop 中打开：

```text
Settings -> Developer -> Edit Config
```

把下面片段加入 `mcpServers`：

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

保存后完全退出并重启 Claude Desktop。重启后在聊天输入框附近查看 Connectors / MCP servers 状态。

如果工具没有出现，请检查：

```text
macOS:   ~/Library/Logs/Claude/mcp*.log
Windows: %APPDATA%\Claude\logs\mcp*.log
```

桌面应用启动的 stdio MCP 进程通常不会继承完整 shell 环境；如果子代理依赖 API key、代理、证书或自定义配置目录，请把这些变量显式写在上面的 `env` 里，或确保它能通过 `HOME`、`~/.claude` 等用户配置目录读取登录状态。

## 快速配置：Codex CLI / Codex IDE Extension

Codex 的 MCP 配置可以用命令添加，也可以直接编辑 `config.toml`。

用命令添加：

```bash
codex mcp add acp-subagent -- npx -y @rvaim/acp-subagent-mcp
```

进入 Codex TUI 后，可以用 `/mcp` 查看 MCP Server 是否已连接。

如果需要给 MCP Server 显式设置环境变量，建议编辑 `~/.codex/config.toml` 或项目级 `.codex/config.toml`：

```toml
[mcp_servers.acp-subagent]
command = "npx"
args = ["-y", "@rvaim/acp-subagent-mcp"]
# Codex 启动 stdio MCP server 时，只有列在 env_vars 里的宿主变量会被转发。
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

Codex CLI 和 Codex IDE Extension 共用同一份 MCP 配置。Codex Desktop 如果提供 “Open config.toml” 或等价 MCP 设置入口，也可以使用同一段配置。

## 快速配置：通用 MCP Host

任意支持 stdio MCP server 的 Host，一般都可以使用下面的 JSON 结构。部分 Host 不需要 `type` 字段；如果 Host 报 schema 错误，可以删掉 `"type": "stdio"`。

```json
{
  "mcpServers": {
    "acp-subagent": {
      "type": "stdio",
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

生成通用配置：

```bash
npx -y @rvaim/acp-subagent-mcp --print-generic-mcp-config
```

## 常用环境变量

| 变量 | 作用 | 默认值 |
|---|---|---|
| `ACP_SUBAGENT_DEFAULT_AGENT` | 默认子代理名称 | `claude` |
| `ACP_SUBAGENT_DEFAULT_AGENT_COMMAND` | 默认 ACP 子代理命令 | `claude-agent-acp` |
| `ACP_SUBAGENT_DEFAULT_AGENT_ARGS` | 默认 ACP 子代理参数，支持 JSON array | 空 |
| `ACP_SUBAGENT_ENV_POLICY` | 默认环境继承策略：`all/allowlist/none` | `all` |
| `ACP_SUBAGENT_ENV_ALLOWLIST` | `allowlist` 策略使用的变量名或前缀通配列表 | 空 |
| `ACP_SUBAGENT_WORKSPACE_ROOTS` | 可选；严格限制子代理可使用的工作区根目录 | 空，表示自动信任本次 `cwd` |
| `ACP_SUBAGENT_AUTO_WORKSPACE_ROOTS` | 未设置严格根目录时，是否自动信任本次 `cwd` | `true` |
| `ACP_SUBAGENT_TIMEOUT_SECS` | 默认任务超时 | `600` |
| `ACP_SUBAGENT_INACTIVITY_TIMEOUT_SECS` | 默认无活动超时；Host 未及时发送 cancellation 时的快速兜底 | `15` |
| `ACP_SUBAGENT_MCP_REQUEST_HEARTBEAT_MS` | 长 tool call 的 MCP progress heartbeat 间隔；`0` 表示关闭 | `1000` |
| `ACP_SUBAGENT_ACP_CANCEL_GRACE_MS` | 收到取消后等待 ACP cancel / SIGTERM 生效的宽限时间 | `500` |
| `ACP_SUBAGENT_PROCESS_KILL_GRACE_MS` | 发送 `SIGKILL` 后等待进程退出的兜底时间 | `500` |
| `ACP_SUBAGENT_LOG_DIR` | 日志目录 | `.subagents/runs` |
| `ACP_SUBAGENT_SKILL_MODE` | Skill 注入模式：`off/list/inline` | `list` |
| `ACP_SUBAGENT_AGENTS_JSON` | 用 JSON 添加或覆盖 agent 配置 | 空 |
| `ACP_SUBAGENT_MCP_SERVERS_JSON` | 用 JSON 添加 MCP server profile | 空 |

更多配置见 [doc/configuration.md](doc/configuration.md)。

## 高级配置文件

普通用户不需要配置文件。需要添加 Codex、Gemini、自定义 ACP agent、MCP profiles 或更严格安全策略时，可以生成示例：

```bash
acp-subagent-mcp --print-default-config > agents.toml
```

然后在 MCP 配置里加：

```json
{
  "mcpServers": {
    "acp-subagent": {
      "command": "npx",
      "args": ["-y", "acp-subagent-mcp", "--config", "/absolute/path/to/agents.toml"]
    }
  }
}
```

也可以直接使用仓库中的 `examples/agents.toml`。

## 最小调用示例

同步运行一个只读审查任务：

```json
{
  "cwd": "/Users/you/workspace/app",
  "mode": "review",
  "task": {
    "title": "审查登录模块",
    "goal": "找出阻塞上线的问题",
    "files": [
      { "path": "src/auth/login.ts", "role": "primary", "action": "review" }
    ],
    "constraints": ["不要修改文件", "只返回高风险问题"]
  }
}
```

更多同步、异步、批量、取消、多轮和日志场景见 [doc/usage.md](doc/usage.md)，完整工具参数见 [doc/api.md](doc/api.md)。

取消语义有一个重要前提：MCP Host 必须把用户停止当前回答传播为正在执行的 MCP request cancellation。本服务收到该信号后会执行 best-effort ACP cancel，并立即进入本地进程树强制清理；默认只给 ACP adapter `500ms` 响应 cancel，再给进程树 `500ms` 处理 `SIGTERM`，随后使用 `SIGKILL` 兜底。长 tool call 默认还会在 Host 提供 `progressToken` 时每 `1000ms` 发送 MCP progress heartbeat，帮助 Host 更快感知 request 仍在运行并传播 cancellation。不要用主 agent 通过 shell 写出的临时 Node harness 来代表真实 MCP cancellation；只要 `node tmp/run-xxx.mjs` 仍在进程表里，它就仍然持有请求，MCP Server 不会认为该请求已取消。

如果某个 Host 只停止模型文本输出、没有发送 MCP request cancellation，也没有关闭 stdio transport，本服务无法立即知道用户点了停止。新版会在 Host 提供 `progressToken` 时每秒发送一次 MCP progress heartbeat；这不是用来杀子代理的心跳，而是让长 tool call 保持可见，并在 transport 已断开但 SDK 尚未触发 close 时更早发现发送失败。为减少没有 cancellation 时的残留时间，默认 `inactivity_timeout_secs` 已设为 `15` 秒：长时间没有 ACP 协议层活动时会自动取消并清理子代理。`result.json` 中如果看到 `status=timeout` 且 `code=inactivity_timeout`，说明走的是这个兜底路径；如果看到 `status=cancelled`，说明收到了真实 cancellation。

## 本地开发

```bash
npm install
npm run check
npm run build
npm run smoke
```

mock agent smoke test 覆盖：

- `subagent_run`
- `subagent_start`
- `subagent_run_many`
- `subagent_wait`
- `subagent_continue`
- `subagent_result`
- `subagent_start_many`
- `subagent_close`
- MCP request cancellation：模拟 Host 手动停止 `subagent_run`、`subagent_run_many` 和 `subagent_wait` 时，确认子代理会被取消并清理进程树；同时覆盖 adapter 不响应 ACP cancel 时的本地强制清理。

## 发布到 npm

发布前确认：

```bash
npm run check
npm run build
npm pack --dry-run
npm publish --access public
```

`package.json` 已包含：

- `bin.acp-subagent-mcp`
- `files`
- `publishConfig.access=public`
- `prepublishOnly=npm run check && npm run build`
- 不包含任何具体子代理 adapter 的 `dependencies` 或 `optionalDependencies`
- 包含 `@agentclientprotocol/sdk` 作为通用 ACP 协议依赖

## 安全说明

权限策略首先是协议级控制：它决定向 ACP agent 声明哪些 client capabilities，并拦截 ACP `fs/*`、`terminal/*` 等请求。它不能替代操作系统级 sandbox。如果某个 ACP adapter 自己绕过 ACP client 方法直接访问磁盘或网络，MCP Server 不能单靠协议层完全阻止。生产环境建议配合容器、专用用户、git worktree 或文件系统 sandbox。

默认安全策略、取消边界与已知边界见 [doc/lifecycle.md](doc/lifecycle.md) 和 [doc/configuration.md](doc/configuration.md)。

# acp-subagent-mcp

通用 ACP 子代理 MCP Server。主 agent 通过 MCP tools 派发任务，本服务在内部拉起支持 ACP 的子代理，负责会话、并发、多轮、取消、超时、日志、安全校验和结果压缩。

默认不需要 `agents.toml`。安装后即可通过环境变量配置，默认子代理名称是 `claude`，默认尝试执行的命令是 `claude-agent-acp`。本包不会把 Claude、Codex、Gemini 或任何具体 ACP adapter 作为依赖自动安装。

## 特性

- 默认 Claude 子代理：`agent_type` 可省略，自动使用 `claude`；如果本机没有对应命令，工具会返回安装/配置提示。
- 支持 npm / npx / Claude Desktop 的 `mcpServers.command + args + env` 配置方式。
- 支持主 agent Skill 桥接：默认扫描项目级 `.claude/skills` 和用户级 `~/.claude/skills`，以低 token 清单形式注入给子代理。
- 支持同步、异步、并行、多轮、取消、关闭和日志读取。
- 默认 compact 输出，减少主 agent token 消耗。
- 默认禁止动态 `mcp_servers`，只能引用配置或环境变量中受信的 profile。
- 默认 `execute=deny`，不向 ACP agent 声明 terminal capability。

## 依赖边界

本项目只发布通用 MCP 调度层，不绑定任何具体子代理实现：

- 不依赖 Claude SDK、Codex SDK、Gemini SDK。
- 不依赖 `@agentclientprotocol/claude-agent-acp`、`codex-acp`、`gemini` 等具体 ACP adapter。
- 默认 agent 名称仍然是 `claude`，但默认命令 `claude-agent-acp` 只会从用户环境的 `PATH` 中查找。
- 如果命令不存在，MCP tool 会返回可恢复错误和配置提示，不会在运行时自动安装。

本项目会依赖官方通用 ACP SDK：

```text
@agentclientprotocol/sdk
```

它不是 Claude、Codex、Gemini 的平台 SDK，也不是某个具体 agent adapter。它只提供 ACP 协议的 TypeScript 实现。本项目使用其中的 `ClientSideConnection` 和 `ndJsonStream` 作为 ACP Client，不再手写 ACP JSON-RPC transport。

这样做的原因是：npm 包保持通用，用户选择哪种子代理，就在自己的环境里提供对应的 ACP 可执行命令；同时协议栈尽量复用官方 SDK，降低维护风险。

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

### 默认 Claude 子代理

本 MCP Server 默认会尝试执行：

```bash
claude-agent-acp
```

这只是一个默认命令名，不代表本包会自动安装 Claude adapter，也不会把 Claude SDK 或某个具体 ACP adapter 打进依赖。这样可以保持本项目的通用边界：本 MCP 只负责调度 ACP 子进程，具体子代理由用户环境提供。

如果你的环境里没有这个命令，运行任务时会返回明确提示。你可以通过环境变量指定已有命令或绝对路径：

```bash
ACP_SUBAGENT_CLAUDE_COMMAND=/absolute/path/to/claude-agent-acp acp-subagent-mcp
```

如果确实还没有任何 Claude ACP adapter，你可以按该 adapter 自己的文档安装；这一步不由 acp-subagent-mcp 自动完成。

## 在 Claude Desktop 中使用

Claude Desktop 使用 JSON 配置启动本地 MCP server。把下面片段加入 `claude_desktop_config.json` 的 `mcpServers`：

```json
{
  "mcpServers": {
    "acp-subagent": {
      "command": "npx",
      "args": ["-y", "acp-subagent-mcp"],
      "env": {
        "ACP_SUBAGENT_ALLOWED_ROOTS": "/Users/you/projects",
        "ACP_SUBAGENT_DEFAULT_AGENT": "claude",
        "ACP_SUBAGENT_CLAUDE_COMMAND": "claude-agent-acp",
        "ACP_SUBAGENT_SKILL_MODE": "list"
      }
    }
  }
}
```

也可以生成示例配置：

```bash
npx -y acp-subagent-mcp --print-claude-desktop-config
```

常见位置：

```text
macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json
Windows: %APPDATA%\Claude\claude_desktop_config.json
```

修改配置后需要完全重启 Claude Desktop。

## 最少环境变量

不创建 `agents.toml` 时，通常只需要设置：

```bash
ACP_SUBAGENT_ALLOWED_ROOTS=/Users/you/projects
```

多个目录可以用逗号分隔，也可以用 JSON 数组：

```bash
ACP_SUBAGENT_ALLOWED_ROOTS='/Users/you/projects,/tmp'
ACP_SUBAGENT_ALLOWED_ROOTS='["/Users/you/projects","/tmp"]'
```

常用变量：

| 变量 | 作用 | 默认值 |
|---|---|---|
| `ACP_SUBAGENT_ALLOWED_ROOTS` | 允许子代理使用的 cwd 根目录 | MCP 进程启动目录 |
| `ACP_SUBAGENT_DEFAULT_AGENT` | 默认子代理名称 | `claude` |
| `ACP_SUBAGENT_CLAUDE_COMMAND` | Claude ACP 子代理命令 | `claude-agent-acp` |
| `ACP_SUBAGENT_CLAUDE_ARGS` | Claude ACP 子代理参数，支持 JSON array | 空 |
| `ACP_SUBAGENT_TIMEOUT_SECS` | 默认任务超时 | `600` |
| `ACP_SUBAGENT_INACTIVITY_TIMEOUT_SECS` | 默认无活动超时 | `120` |
| `ACP_SUBAGENT_LOG_DIR` | 日志目录 | `.subagent-runs` |
| `ACP_SUBAGENT_SKILL_MODE` | Skill 注入模式：`off/list/inline` | `list` |
| `ACP_SUBAGENT_SKILL_NAMES` | inline 或筛选时的 Skill 名称 | 空 |
| `ACP_SUBAGENT_SKILL_ROOTS` | 额外 Skill 根目录 | 空 |
| `ACP_SUBAGENT_AGENTS_JSON` | 用 JSON 增加/覆盖 agents | 空 |
| `ACP_SUBAGENT_MCP_SERVERS_JSON` | 用 JSON 增加/覆盖 MCP profiles | 空 |

## 主 agent Skill 能力桥接

MCP Server 不能直接读取宿主应用内部的私有 Skill 运行时，也不能替主 agent 调用那些私有 Skill。这里实现的是可落地的桥接能力：

1. 默认扫描项目级 `.claude/skills`。
2. 默认扫描用户级 `~/.claude/skills`。
3. 可通过 `ACP_SUBAGENT_SKILL_ROOTS` 增加额外目录。
4. 默认只把 Skill 名称和描述注入给子代理，避免 token 爆炸。
5. 只有显式请求 `mode=inline` 且指定 `names` 时，才内联对应 `SKILL.md`。

项目级 Skill 示例：

```text
my-project/
  .claude/
    skills/
      code-review/
        SKILL.md
```

`SKILL.md` 示例：

```markdown
---
name: code-review
description: 审查 TypeScript 代码中的高风险缺陷。
when_to_use: 当任务是代码审查、上线前检查或安全风险分析时使用。
---

请重点检查边界条件、错误处理、权限控制、并发风险和测试缺口。
```

调用时默认只列清单：

```json
{
  "cwd": "/Users/you/projects/app",
  "mode": "review",
  "task": {
    "title": "审查登录模块",
    "goal": "找出阻塞上线的问题"
  }
}
```

如需内联指定 Skill：

```json
{
  "cwd": "/Users/you/projects/app",
  "skills": {
    "mode": "inline",
    "names": ["code-review"],
    "max_skill_chars": 8000
  },
  "task": {
    "title": "按 code-review Skill 审查登录模块",
    "goal": "输出阻塞问题和修复建议"
  }
}
```

关闭 Skill 注入：

```json
{
  "skills": { "mode": "off" },
  "task": { "title": "普通分析", "goal": "不使用 Skill 上下文" }
}
```

## MCP tools

| 工具 | 作用 |
|---|---|
| `subagent_list` | 列出可用子代理、默认子代理和 Skill 桥接状态。 |
| `subagent_run` | 同步运行一个子代理任务，等待结果后返回。 |
| `subagent_skills` | 列出可桥接给子代理的父代理 Skill 短清单。 |
| `subagent_start` | 异步启动一个任务，立即返回 `task_id`。 |
| `subagent_start_many` | 并行启动多个任务。 |
| `subagent_wait` | 按策略等待一个或多个任务。 |
| `subagent_result` | 查询任务状态、最终结果或部分输出。 |
| `subagent_continue` | 对 `keep_alive=true` 的任务继续发送一轮消息。 |
| `subagent_cancel` | 取消一个或多个任务。 |
| `subagent_close` | 关闭任务和保留的 session。 |
| `subagent_logs` | 读取脱敏且截断后的本地日志。 |

`agent_type` 是可选字段。省略时使用 `ACP_SUBAGENT_DEFAULT_AGENT`，默认是 `claude`。

## 调用示例

### 同步审查

```json
{
  "cwd": "/Users/you/projects/app",
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

### 异步启动并等待

```json
{
  "cwd": "/Users/you/projects/app",
  "keep_alive": true,
  "mode": "implement",
  "task": {
    "title": "修复 refresh token 过期时间",
    "goal": "修复逻辑并补充测试",
    "files": [
      { "path": "src/auth/session.ts", "role": "primary", "action": "edit" },
      { "path": "tests/auth.test.ts", "role": "test", "action": "edit" }
    ]
  }
}
```

随后调用：

```json
{
  "task_ids": ["task_xxx"],
  "return_when": "all_completed",
  "timeout_secs": 300
}
```

### 多轮修正

`subagent_continue` 只支持 `keep_alive=true` 的任务，并且同一个 session 同一时间只允许一个 active prompt turn：

```json
{
  "task_id": "task_xxx",
  "mode": "fix",
  "message": "你刚才只更新了 access token，没有更新 refresh token 的过期时间。请重新修复并补测试。",
  "correction": {
    "reason": "refresh token expiry was not updated",
    "expected_change": "同时更新 refresh token 过期时间，并添加测试覆盖。"
  }
}
```

### 并行启动

```json
{
  "conflict_policy": "allow_readonly_parallel",
  "on_task_failure": "keep_others_running",
  "tasks": [
    {
      "cwd": "/Users/you/projects/app",
      "mode": "review",
      "task": { "title": "第二意见", "goal": "审查整体设计风险" }
    },
    {
      "agent_type": "claude",
      "cwd": "/Users/you/projects/app",
      "mode": "review",
      "task": { "title": "代码审查", "goal": "检查实现缺陷" }
    }
  ]
}
```

## 减少主 agent token 的设计

默认输出是 `compact`，不会返回完整事件流、stderr、prompt、原始输出和完整 structured 副本。大内容写入 `.subagent-runs`，MCP 输出只返回摘要和路径。

需要更多细节时显式请求：

```json
{
  "output": {
    "mode": "full",
    "max_result_chars": 12000,
    "include_structured": true,
    "include_diagnostics": true
  }
}
```

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

### 用环境变量添加自定义 agent

```bash
ACP_SUBAGENT_AGENTS_JSON='{
  "codex": {
    "description": "Codex ACP 子代理",
    "command": "codex-acp",
    "args": [],
    "capabilities": ["code", "review", "edit"]
  }
}'
```

### 用环境变量添加 MCP profile

```bash
ACP_SUBAGENT_MCP_SERVERS_JSON='{
  "filesystem": {
    "enabled": true,
    "transport": "stdio",
    "command": "/absolute/path/to/filesystem-mcp",
    "args": ["--stdio"],
    "allowed_agents": ["claude"]
  }
}'
```

工具调用中只能引用 profile 名称：

```json
{
  "mcp_server_profiles": ["filesystem"],
  "task": { "title": "使用文件系统 profile", "goal": "完成指定分析" }
}
```

## 等待策略

`subagent_wait.return_when` 支持：

| 策略 | 行为 |
|---|---|
| `all_completed` | 等全部任务进入终态。 |
| `first_completed` | 任意任务进入终态就返回。 |
| `first_success` | 任意任务成功或部分成功就返回。 |
| `first_failure` | 任意任务失败、超时或取消就返回。 |
| `any_update` | 任意任务有新事件就返回。 |
| `timeout_partial` | 等到超时或全部完成，超时返回已有结果。 |

## 冲突策略

| 策略 | 行为 |
|---|---|
| `allow_readonly_parallel` | 允许只读任务并行；同 cwd 写任务互斥。 |
| `single_writer_per_cwd` | 默认策略；同 cwd 同时只允许一个潜在写任务。 |
| `sandbox_worktree` | 写任务使用独立 git worktree，完成后提取 patch 文件。 |

使用 `sandbox_worktree` 前必须开启：

```toml
[worktree]
enabled = true
base_dir = ".subagent-worktrees"
keep_on_failure = true
keep_on_success = false
max_patch_bytes = 2000000
include_untracked = false
```

`sandbox_worktree` 会返回 patch 文件路径，但不会自动合并 patch。

## 日志

每次运行生成一个目录：

```text
.subagent-runs/
  run_.../
    task.json
    rendered_prompt.md
    events.jsonl
    stderr.log
    result.json
```

默认日志会脱敏，并且 MCP 输出只返回路径。读取日志请使用 `subagent_logs`，该工具默认再次脱敏和截断。

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
- `subagent_wait`
- `subagent_continue`
- `subagent_result`
- `subagent_start_many`
- `subagent_close`

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

默认安全策略：

- `execute=deny`，不声明 ACP terminal capability。
- 动态 `mcp_servers` 禁用，只允许 `mcp_server_profiles`。
- `cwd` 必须位于 `allowed_cwd_roots`。
- 文件路径必须是相对路径，禁止路径穿越。
- inline/snippet、Skill inline 和 prompt 都有限制。
- 子进程使用最小化 env。
- 日志默认脱敏。
- 超时、取消、关闭都会清理子进程树。

## 已知边界

- Skill 桥接只能读取文件系统中的 Skill 定义，不能直接读取 MCP Host 私有运行时或 ChatGPT 内部 Skills。
- `sandbox_worktree` 只负责隔离和提取 patch，不负责自动合并。
- 网络禁用是策略声明，不是 OS 级防火墙。
- 真实 ACP agent 的兼容性仍需要逐个验证。
- MCP experimental Tasks 暂未接入；当前使用自定义 `subagent_start/wait/result/cancel` 工具面，兼容性更稳。

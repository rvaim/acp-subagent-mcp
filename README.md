# acp-subagent-mcp

通用 ACP 子代理 MCP Server。主 agent 通过 MCP tools 派发任务，本服务在内部拉起支持 ACP 的子代理，负责会话、并发、多轮、取消、超时、日志、安全校验、Skill 桥接和低 token 结果返回。

默认不需要 `agents.toml`。安装后可以直接通过 MCP Host 启动；默认子代理名称是 `claude`，默认尝试执行的命令是 `claude-agent-acp`。本包不会把 Claude、Codex、Gemini 或任何具体 ACP adapter 作为依赖自动安装。

## 重要边界

本项目只发布通用 MCP 调度层，不绑定任何具体子代理实现：

- 不依赖 Claude SDK、Codex SDK、Gemini SDK。
- 不依赖 `@agentclientprotocol/claude-agent-acp`、`codex-acp`、`gemini` 等具体 ACP adapter。
- 默认 agent 名称是 `claude`，但默认命令 `claude-agent-acp` 只会从用户环境的 `PATH` 中查找。
- 如果命令不存在，MCP tool 会返回可恢复错误和配置提示，不会在运行时自动安装。

本项目会依赖官方通用 ACP SDK：

```text
@agentclientprotocol/sdk
```

它不是 Claude、Codex、Gemini 的平台 SDK，也不是某个具体 agent adapter。它只提供 ACP 协议的 TypeScript 实现。本项目使用其中的 `ClientSideConnection` 和 `ndJsonStream` 作为 ACP Client，不手写 ACP JSON-RPC transport。

## 特性

- 默认 Claude 子代理：`agent_type` 可省略，自动使用 `claude`。
- 支持 npm / npx / Claude Desktop / Codex CLI / Codex 配置文件 / 通用 MCP Host 的 stdio 配置方式。
- 支持主 agent Skill 桥接：默认扫描项目级 `.claude/skills` 和用户级 `~/.claude/skills`，以低 token 清单形式注入给子代理。
- 支持同步、异步、并行、多轮、取消、关闭和日志读取。
- 默认 compact 输出，减少主 agent token 消耗。
- 默认环境变量策略是 `all`，子代理会继承 MCP Server 进程可见的全部环境变量；需要收紧时可改成 `allowlist` 或 `none`。
- 默认禁止动态 `mcp_servers`，只能引用配置或环境变量中受信的 profile。
- 默认 `execute=deny`，不向 ACP agent 声明 terminal capability。

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
ACP_SUBAGENT_DEFAULT_AGENT_COMMAND=/absolute/path/to/claude-agent-acp acp-subagent-mcp
```

## 快速使用：Claude Desktop

Claude Desktop 使用 `claude_desktop_config.json` 启动本地 MCP Server。

### 1. 打开配置文件

常见位置：

```text
macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json
Windows: %APPDATA%\Claude\claude_desktop_config.json
```

也可以在 Claude Desktop 中打开：

```text
Settings -> Developer -> Edit Config
```

### 2. 写入 MCP 配置

把下面片段加入 `mcpServers`：

```json
{
  "mcpServers": {
    "acp-subagent": {
      "command": "npx",
      "args": ["-y", "acp-subagent-mcp"],
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
npx -y acp-subagent-mcp --print-claude-desktop-config
```

### 3. 重启和验证

保存后完全退出并重启 Claude Desktop。重启后在聊天输入框附近查看 Connectors / MCP servers 状态。

如果工具没有出现，请检查：

```text
macOS:   ~/Library/Logs/Claude/mcp*.log
Windows: %APPDATA%\Claude\logs\mcp*.log
```

本 MCP Server 默认 `env_policy=all`，但它只能继承 Claude Desktop 实际传给 MCP Server 进程的环境变量。桌面应用启动的 stdio MCP 进程通常不会继承完整 shell 环境；如果你的子代理依赖 API key、代理、证书或自定义配置目录，请把这些变量显式写在上面的 `env` 里，或确保它能通过 `HOME`、`~/.claude` 等用户配置目录读取登录状态。

## 快速使用：Codex CLI

Codex 的 MCP 配置可以用命令添加，也可以直接编辑 `config.toml`。

### 方式一：用命令添加

```bash
codex mcp add acp-subagent -- npx -y acp-subagent-mcp
```

进入 Codex TUI 后，可以用：

```text
/mcp
```

查看 MCP Server 是否已连接。

如果你需要给 MCP Server 显式设置环境变量，建议使用下面的 `config.toml` 方式，因为它能同时设置 `env` 和 `env_vars`。

### 方式二：编辑 Codex config.toml

默认位置：

```text
~/.codex/config.toml
```

受信项目也可以使用项目级配置：

```text
.codex/config.toml
```

加入：

```toml
[mcp_servers.acp-subagent]
command = "npx"
args = ["-y", "acp-subagent-mcp"]
# Codex 启动 stdio MCP server 时，只有列在 env_vars 里的宿主变量会被转发。
# 如果你的子代理依赖本地登录、代理、证书或 API key，请把对应变量列在这里。
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

也可以生成示例：

```bash
npx -y acp-subagent-mcp --print-codex-config
```

## 快速使用：Codex Desktop / Codex IDE Extension

Codex 官方 MCP 文档明确说明：Codex CLI 和 Codex IDE Extension 共用同一份 MCP 配置。也就是说，IDE Extension 中可以打开或复用 `~/.codex/config.toml` / 项目级 `.codex/config.toml`。

如果你的 Codex Desktop 版本提供 MCP 设置入口，或提供 “Open config.toml” / “MCP settings” 之类入口，请使用上一节的 `[mcp_servers.acp-subagent]` 配置。

如果你的 Codex Desktop 版本没有公开 MCP 配置入口，先使用 Codex CLI 或 Codex IDE Extension 进行配置；Desktop 版本的配置入口可能随版本变化，以应用内设置为准。

## 快速使用：通用 MCP Host

任意支持 stdio MCP server 的 Host，一般都可以使用下面的 JSON 结构。部分 Host 不需要 `type` 字段；如果你的 Host 报 schema 错误，可以删掉 `"type": "stdio"`。

```json
{
  "mcpServers": {
    "acp-subagent": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "acp-subagent-mcp"],
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
npx -y acp-subagent-mcp --print-generic-mcp-config
```

## 环境变量继承策略

子代理能看到哪些环境变量，由两层决定：

1. MCP Host 先决定哪些环境变量传给 `acp-subagent-mcp` 进程。
2. `acp-subagent-mcp` 再根据 `env_policy` 决定传给子代理进程。

本项目默认：

```text
ACP_SUBAGENT_ENV_POLICY=all
```

含义：子代理继承 MCP Server 进程可见的全部环境变量，再叠加 agent 的显式 `env` 配置。

### 可选策略

| 策略 | 含义 | 适合场景 |
|---|---|---|
| `all` | 继承 MCP Server 进程可见的全部环境变量 | 默认；最容易复用 Claude Code / Codex / Gemini CLI 的登录、代理、证书和配置 |
| `allowlist` | 只继承允许列表命中的变量 | 生产环境或更严格的本地安全策略 |
| `none` | 不继承业务环境变量，只保留 PATH/HOME/TMP/PWD 等运行必需变量 | 高隔离任务、测试或不需要认证的子代理 |

### 全局配置

```bash
ACP_SUBAGENT_ENV_POLICY=all
```

### 只继承白名单变量

```bash
ACP_SUBAGENT_ENV_POLICY=allowlist
ACP_SUBAGENT_ENV_ALLOWLIST='HOME,PATH,ANTHROPIC_*,CLAUDE_*,OPENAI_API_KEY,HTTPS_PROXY,HTTP_PROXY,NO_PROXY'
```

`ACP_SUBAGENT_ENV_ALLOWLIST` 支持：

```text
ANTHROPIC_API_KEY  # 精确变量名
ANTHROPIC_*        # 前缀通配
```

### 按 agent 单独配置

环境变量层只保留通用入口：`ACP_SUBAGENT_ENV_POLICY` 和 `ACP_SUBAGENT_ENV_ALLOWLIST`。

如果某个子代理需要不同的继承策略，请在 `agents.toml` 或 `ACP_SUBAGENT_AGENTS_JSON` 中配置该 agent；项目不提供按具体 agent 名称拼接出来的专用环境变量。

```toml
[agents.claude]
env_policy = "all" # all | allowlist | none

env_allowlist = ["HOME", "PATH", "ANTHROPIC_*", "CLAUDE_*"]

[agents.claude.env]
# 显式覆盖变量；from_env 未设置时不会写入空字符串。
# ANTHROPIC_API_KEY = { from_env = "ANTHROPIC_API_KEY" }
```

也可以用 JSON 添加或覆盖 agent：

```bash
ACP_SUBAGENT_AGENTS_JSON='{"claude":{"command":"claude-agent-acp","args":[],"env_policy":"allowlist","env_allowlist":["HOME","PATH","ANTHROPIC_*","CLAUDE_*"]}}'
```

注意：`all` 更方便，但也意味着子代理进程能看到 MCP Server 进程里的密钥和代理配置。需要严格控制时，请改用 `allowlist`。

## 工作区根目录

普通用户不需要设置工作区根目录环境变量。默认行为是：

1. 主 agent 调用工具时传入 `cwd`，这个 `cwd` 就被视为当前工作区。
2. 如果工具调用没有传 `cwd`，会依次尝试 `CLAUDE_PROJECT_DIR`、`INIT_CWD`、`PWD`、MCP Server 进程当前目录。
3. 只有你要在生产环境做严格白名单限制时，才需要设置 `ACP_SUBAGENT_WORKSPACE_ROOTS`。

严格限制示例：

```bash
ACP_SUBAGENT_WORKSPACE_ROOTS=/Users/you/workspace
```

多个目录可以用逗号分隔，也可以用 JSON 数组：

```bash
ACP_SUBAGENT_WORKSPACE_ROOTS='/Users/you/workspace,/tmp'
ACP_SUBAGENT_WORKSPACE_ROOTS='["/Users/you/workspace","/tmp"]'
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
| `ACP_SUBAGENT_INACTIVITY_TIMEOUT_SECS` | 默认无活动超时 | `120` |
| `ACP_SUBAGENT_LOG_DIR` | 日志目录 | `.subagents/runs` |
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
  "cwd": "/Users/you/workspace/app",
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
  "cwd": "/Users/you/workspace/app",
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

### 异步启动并等待

```json
{
  "cwd": "/Users/you/workspace/app",
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

随后调用 `subagent_wait`：

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
      "cwd": "/Users/you/workspace/app",
      "mode": "review",
      "task": { "title": "第二意见", "goal": "审查整体设计风险" }
    },
    {
      "agent_type": "claude",
      "cwd": "/Users/you/workspace/app",
      "mode": "review",
      "task": { "title": "代码审查", "goal": "检查实现缺陷" }
    }
  ]
}
```

## 减少主 agent token 的设计

默认输出是 `compact`，不会返回完整事件流、stderr、prompt、原始输出和完整 structured 副本。大内容写入 `.subagents/runs`，MCP 输出只返回摘要和路径。

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
    "capabilities": ["code", "review", "edit"],
    "env_policy": "all"
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
base_dir = ".subagents/worktrees"
keep_on_failure = true
keep_on_success = false
max_patch_bytes = 2000000
include_untracked = false
```

`sandbox_worktree` 会返回 patch 文件路径，但不会自动合并 patch。

## 日志

每次运行生成一个目录：

```text
.subagents/runs/
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
- 默认信任 tool 传入的 `cwd` 作为当前工作区；如设置 `ACP_SUBAGENT_WORKSPACE_ROOTS` 或 `allowed_cwd_roots`，则必须位于这些根目录内。
- 文件路径必须是相对路径，禁止路径穿越。
- inline/snippet、Skill inline 和 prompt 都有限制。
- 子进程默认 `env_policy=all`，会继承 MCP Server 进程可见的全部环境变量；生产环境可改用 `allowlist`。
- 日志默认脱敏。
- 超时、取消、关闭都会清理子进程树。

## 已知边界

- Skill 桥接只能读取文件系统中的 Skill 定义，不能直接读取 MCP Host 私有运行时或 ChatGPT 内部 Skills。
- `sandbox_worktree` 只负责隔离和提取 patch，不负责自动合并。
- 网络禁用是策略声明，不是 OS 级防火墙。
- 真实 ACP agent 的兼容性仍需要逐个验证。
- MCP experimental Tasks 暂未接入；当前使用自定义 `subagent_start/wait/result/cancel` 工具面，兼容性更稳。

## 参考

- MCP 官方本地服务器连接教程：https://modelcontextprotocol.io/docs/develop/connect-local-servers
- MCP 官方调试说明：https://modelcontextprotocol.io/docs/tools/debugging
- OpenAI Codex MCP 文档：https://developers.openai.com/codex/mcp

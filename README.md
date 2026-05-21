# @rvaim/acp-subagent-mcp

这是一个用 TypeScript 实现的通用 ACP 子代理 MCP Server。它把一个或多个支持 ACP 的 coding agent 包装成 MCP 工具，供主代理调用。

本项目的职责边界很清楚：

- 对主代理暴露高层 MCP tools，例如 `subagent_run`、`subagent_start`、`subagent_wait`、`subagent_continue`。
- 对子代理实现通用 ACP client，通过 JSON-RPC over stdio 发送 `initialize`、`session/new`、`session/prompt`、`session/cancel`。
- 不直接依赖 Codex、Claude、Gemini 的私有 SDK。新增 agent 只需要修改 `agents.toml`。

## 已实现能力

第一版已经实现：

- `subagent_list`
- `subagent_run`
- `subagent_start`
- `subagent_start_many`
- `subagent_wait`
- `subagent_result`
- `subagent_continue`
- `subagent_cancel`
- `subagent_close`
- `subagent_logs`
- `agents.toml` 加载和校验
- JSON-RPC over stdio ACP client
- `initialize` / `session/new` / `session/prompt` / `session/cancel` / 可选 `session/close`
- 结构化任务 prompt 渲染
- 子代理 JSON 或自然语言结果解析
- wall-clock timeout
- inactivity timeout
- 默认 3 秒主动心跳：MCP Server 通过 JSON-RPC 向子代理包装器发送心跳，包装器回复后证明子代理仍可通信；3 秒内收不到主代理心跳会主动关闭自身
- 取消与进程树清理
- 日志目录：`task.json`、`rendered_prompt.md`、`events.jsonl`、`stderr.log`、`result.json`
- cwd 与文件路径安全校验
- 权限策略自动决策
- 输出压缩和 `detail_level`
- 与 `parent_agent_id` 绑定的基础会话池
- 中文文档和中文 TSDoc 注释

## 安装

```bash
npm install
npm run build
```

Node.js 版本要求：`>=20`。

## 本地连通性测试

项目自带一个示例 ACP agent：`examples/fake-acp-agent.mjs`。它不会调用模型，只用于验证 MCP Server 的 ACP 通信链路。

```bash
npm run build
node --input-type=module <<'JS'
import { loadConfig } from './dist/config/loadConfig.js';
import { SubagentRuntime } from './dist/runtime/subagentRuntime.js';

const config = await loadConfig('examples/agents.toml');
const runtime = new SubagentRuntime(config);
const output = await runtime.run({
  agent_type: 'fake',
  cwd: process.cwd(),
  task: {
    title: '连通性测试',
    goal: '确认 fake ACP agent 能返回结构化结果',
    expected_output: { format: 'structured' }
  },
  session_pool_policy: 'disable',
  detail_level: 'normal'
});
console.log(JSON.stringify(output, null, 2));
await runtime.shutdown();
JS
```

看到 `status: "completed"` 就说明 MCP Server 到 ACP agent 的基础链路已经跑通。

## 作为 MCP Server 启动

源码目录下可以先复制并修改配置：

```bash
cp examples/agents.toml agents.toml
npm run build
SUBAGENT_MCP_CONFIG=./agents.toml node dist/index.js
```

通常 MCP Host 会自己启动这个进程。可以参考 `examples/mcp-config.json`：

```json
{
  "mcpServers": {
    "@rvaim/acp-subagent-mcp": {
      "command": "node",
      "args": ["/path/to/acp-subagent-mcp/dist/index.js"],
      "env": {
        "SUBAGENT_MCP_CONFIG": "/path/to/acp-subagent-mcp/agents.toml"
      }
    }
  }
}
```

如果通过 npm 包安装或 `npx` 使用，推荐让 MCP Host 直接启动包内的 bin，并显式传入配置文件：

```json
{
  "mcpServers": {
    "@rvaim/acp-subagent-mcp": {
      "command": "npx",
      "args": ["-y", "@rvaim/acp-subagent-mcp"],
      "env": {
        "SUBAGENT_MCP_CONFIG": "/absolute/path/to/agents.toml"
      }
    }
  }
}
```

未显式设置 `SUBAGENT_MCP_CONFIG` 且当前目录没有 `agents.toml` 时，Server 会使用内置默认 agent 配置启动：

```toml
[agents.claude]
description = "默认 ACP coding agent。可通过 SUBAGENT_MCP_DEFAULT_AGENT_* 环境变量覆盖。"
command = "npx"
args = ["-y", "@agentclientprotocol/claude-agent-acp"]
capabilities = ["code", "review", "edit", "analysis"]
```

因此不写 `agents.toml` 也能在 `subagent_list` 里看到 `claude`。首次运行会通过 `npx` 启动 Claude ACP adapter；你仍需要按 adapter/Claude Agent SDK 的要求完成认证。

内置 agent 名字会自动补齐 ACP 启动命令：

| agent 名字 | 默认命令 |
| --- | --- |
| `claude` | `npx -y @agentclientprotocol/claude-agent-acp` |
| `codex` | `npx -y @zed-industries/codex-acp` |
| `gemini` | `gemini --acp` |

所以也可以只写 agent 名字：

```toml
[agents.gemini]
description = "Gemini CLI"

[agents.codex]
description = "Codex"
```

## 环境变量配置

不想写 `agents.toml` 时，可以用环境变量覆盖默认配置：

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SUBAGENT_MCP_DEFAULT_AGENT_TYPE` | `claude` | 默认 agent type |
| `SUBAGENT_MCP_DEFAULT_AGENT_COMMAND` | `npx` | 默认 agent 命令 |
| `SUBAGENT_MCP_DEFAULT_AGENT_ARGS` | `["-y","@agentclientprotocol/claude-agent-acp"]` | JSON 字符串数组或逗号分隔参数 |
| `SUBAGENT_MCP_DEFAULT_AGENT_CAPABILITIES` | `["code","review","edit","analysis"]` | JSON 字符串数组或逗号分隔能力 |
| `SUBAGENT_MCP_DEFAULT_AGENT_DESCRIPTION` | 内置描述 | `subagent_list` 展示描述 |
| `SUBAGENT_MCP_DEFAULT_AGENT_ENV` | `{}` | 传给默认 agent 的 JSON 字符串对象 |
| `SUBAGENT_MCP_TIMEOUT_SECS` | `600` | 默认任务超时 |
| `SUBAGENT_MCP_INACTIVITY_TIMEOUT_SECS` | `120` | 默认无进展超时 |
| `SUBAGENT_MCP_HEARTBEAT_TIMEOUT_SECS` | `60` | 默认父心跳失联自关闭窗口 |
| `SUBAGENT_MCP_ALLOWED_CWD_ROOTS` | 当前工作目录 | JSON 字符串数组或逗号分隔路径 |
| `SUBAGENT_MCP_ALLOW_NETWORK` | `false` | 是否允许联网，支持 `true` / `false` |
| `SUBAGENT_MCP_MAX_PARALLEL_TASKS` | `4` | 最大并行任务数 |

例如改用 Gemini；因为 `gemini` 是内置 agent 名字，只需要改 type：

```json
{
  "mcpServers": {
    "@rvaim/acp-subagent-mcp": {
      "command": "npx",
      "args": ["-y", "@rvaim/acp-subagent-mcp"],
      "env": {
        "SUBAGENT_MCP_DEFAULT_AGENT_TYPE": "gemini"
      }
    }
  }
}
```

## 配置真实 ACP agent

在 `agents.toml` 中新增 agent。示例：

```toml
[agents.gemini]
description = "适合大上下文分析、方案比较和第二意见。"
command = "gemini"
args = ["--acp"]
capabilities = ["analysis", "review"]

[agents.codex]
description = "适合代码实现、补丁、测试和代码审查。"
command = "codex-acp"
args = []
capabilities = ["code", "review", "edit"]
```

注意：工具调用者不能传 `command` 或 `args`。所有子代理启动命令必须写在配置文件里。

## 最小调用示例

主代理可以调用 `subagent_run`：

```json
{
  "agent_type": "fake",
  "cwd": "/absolute/path/to/project",
  "mode": "review",
  "task": {
    "title": "审查登录模块",
    "goal": "找出阻塞上线的问题",
    "files": [
      {
        "path": "src/auth/login.ts",
        "role": "primary",
        "action": "review",
        "content_mode": "path_only"
      }
    ],
    "constraints": ["不要修改文件", "只返回阻塞问题"],
    "expected_output": {
      "format": "structured",
      "required_sections": ["summary", "blocking_issues", "recommendation"]
    }
  },
  "detail_level": "summary"
}
```

默认只返回摘要、结构化结果、必要错误和日志路径。完整事件写入本地日志，不会默认塞回主代理上下文。

## 文档入口

详细文档都在 `doc/` 目录：

- `doc/API.md`：所有 MCP tools 的输入输出说明。
- `doc/配置说明.md`：`agents.toml` 每个配置项的含义。
- `doc/实现指南.md`：新手如何读代码、改代码、接真实 agent。
- `doc/原理说明.md`：MCP、ACP、JSON-RPC、stdio、心跳和会话池的原理。
- `doc/安全与日志.md`：cwd、文件路径、权限、日志脱敏和进程清理。
- `doc/目录结构.md`：源码目录和模块职责。
- `doc/常见问题.md`：常见错误和排查方法。

## 重要限制

- `sandbox_worktree` 目前仅保留配置入口，尚未实现真实 git worktree 隔离。
- 会话池是进程内内存池，MCP Server 重启后不会保留池化 session。
- ACP agent 的具体行为取决于对应 agent 的 ACP adapter。本项目只维护通用调度层。

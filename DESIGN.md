# 设计说明

## 目标

本项目实现一个通用 ACP 子代理 MCP Server。主代理通过 MCP tools 派发任务，本服务通过 ACP 协议拉起真实执行任务的子代理。

整体链路：

```text
主代理 / MCP Host
  ↓ tools/call
通用 ACP 子代理 MCP Server
  ↓ JSON-RPC over stdio
ACP Agent 子进程
  ↓
codex-acp / claude-agent-acp / gemini --acp / custom-agent --acp
```

## 设计边界

本项目只做通用调度层，不实现任何模型 SDK 适配：

- 不接 Codex SDK。
- 不接 Claude SDK。
- 不接 Gemini SDK。
- 不让 MCP tool 调用者传入任意命令。
- 只从 `agents.toml` 读取 agent 的 command、args、env。

这样可以把模型能力、agent adapter、调度层拆开维护。

## 核心原则

### MCP 工具面保持高层

主代理需要的是“派发任务和拿结果”，不是操作 ACP 协议栈。因此暴露：

- `subagent_list`
- `subagent_run`
- `subagent_start`
- `subagent_wait`
- `subagent_continue`
- `subagent_cancel`
- `subagent_close`
- `subagent_logs`

不暴露低层：

- `initialize`
- `session_new`
- `session_prompt`
- `session_update`

### 任务必须结构化

`SubagentTask` 明确描述任务标题、目标、文件、动作、约束、成功标准和输出格式。这样可以减少子代理越界读取、越界修改和输出跑偏。

### 输出默认压缩

MCP tool output 默认只返回主代理需要消费的信息。长日志、原始 ACP 事件、stderr 都写入本地日志。

### 强制 3 秒心跳

`heartbeat_timeout_secs` 默认是 3 秒。只要在该时间内没有任何可证明子代理存活的响应，就取消任务并终止子进程。

可判定存活的信号包括：

- JSON-RPC response
- ACP `session/update`
- stdout 协议消息
- stderr 输出
- 权限请求
- 工具调用更新

### 会话池按父代理隔离

会话池条目必须匹配：

- `parent_agent_id`
- `agent_type`
- `cwd`
- `mode`
- `mcp_servers` 签名
- 权限策略签名
- 当前 idle
- 上下文使用率低于阈值

这样可以复用缓存，同时避免不同主代理之间上下文串扰。

## 运行状态机

```text
created
  ↓
starting
  ↓
running
  ↓
completed / failed / timeout / heartbeat_timeout / cancelled
  ↓
closed
```

## 日志文件

每次运行会生成：

```text
.subagent-runs/run_xxx/
  task.json
  rendered_prompt.md
  events.jsonl
  stderr.log
  result.json
```

日志写入前会做脱敏处理。

## 当前实现阶段

当前代码实现了 MVP 和一部分完整编排能力：

- 同步任务
- 异步任务
- 并行启动
- wait 查询
- continue 多轮
- cancel / close
- logs
- 基础会话池
- 并发写冲突保护

后续可以继续补强：

- 真实 `sandbox_worktree`
- 更完整的 ACP terminal client 方法
- 更精细的权限请求分类
- 持久化会话池
- 更完整的事件摘要和工具调用结果结构化

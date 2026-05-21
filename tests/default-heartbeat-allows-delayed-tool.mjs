#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { SubagentRuntime } from "../dist/runtime/subagentRuntime.js";
import { loadConfig } from "../dist/config/loadConfig.js";

const projectRoot = process.cwd();
const tempDir = path.join(projectRoot, ".tmp-default-heartbeat-test");
const configPath = path.join(tempDir, "agents.toml");
const agentPath = path.join(projectRoot, "tests", "delayed-tool-acp-agent.mjs");

fs.rmSync(tempDir, { recursive: true, force: true });
fs.mkdirSync(tempDir, { recursive: true });
fs.writeFileSync(configPath, renderConfig(), "utf8");

const config = await loadConfig(configPath);
const runtime = new SubagentRuntime(config);

try {
  const result = await runtime.run({
    agent_type: "delayed",
    cwd: projectRoot,
    session_pool_policy: "disable",
    task: {
      title: "默认心跳允许安静工具调用",
      goal: "模拟 tool_call 后 4 秒无 stdout，再正常完成",
    },
  });

  if (result.status !== "completed") {
    throw new Error(`默认心跳不应误杀延迟工具调用：${JSON.stringify(result)}`);
  }
} finally {
  await runtime.shutdown();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function renderConfig() {
  const normalizedProjectRoot = projectRoot.replaceAll("\\", "/");
  const normalizedTempDir = tempDir.replaceAll("\\", "/");
  const normalizedAgentPath = agentPath.replaceAll("\\", "/");

  return `
[defaults]
timeout_secs = 30
inactivity_timeout_secs = 30
max_depth = 3
max_prompt_chars = 120000
max_inline_file_chars = 30000
max_tool_output_chars = 12000
default_detail_level = "summary"
log_dir = "${normalizedTempDir}/logs"
session_ttl_secs = 1800
completed_session_ttl_secs = 600
max_active_sessions = 8

[security]
allowed_cwd_roots = ["${normalizedProjectRoot}", "${normalizedTempDir}"]
allow_network = false

[concurrency]
max_parallel_tasks = 4
default_conflict_policy = "single_writer_per_cwd"

[session_pool]
enabled = false
max_pooled_sessions_per_parent = 1
max_context_usage_ratio = 0.9
idle_ttl_secs = 1800
reuse_policy = "disable"

[permissions.default]
read = "allow"
search = "allow"
edit = "allow"
execute = "allow"
network = "allow"

[agents.delayed]
description = "测试 tool_call 后短暂静默的 ACP agent"
command = "node"
args = ["${normalizedAgentPath}"]
capabilities = ["test"]
`;
}

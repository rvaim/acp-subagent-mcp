#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../dist/config/loadConfig.js";
import { SubagentRuntime } from "../dist/runtime/subagentRuntime.js";

const projectRoot = process.cwd();
const tempDir = path.join(projectRoot, ".tmp-session-pool-test");
const configPath = path.join(tempDir, "agents.toml");
const fakePath = path.join(projectRoot, "examples", "fake-acp-agent.mjs");

fs.rmSync(tempDir, { recursive: true, force: true });
fs.mkdirSync(tempDir, { recursive: true });
fs.writeFileSync(configPath, renderConfig(), "utf8");

const config = await loadConfig(configPath);
const runtime = new SubagentRuntime(config);

try {
  const first = await runtime.run({
    agent_type: "fake",
    cwd: projectRoot,
    parent_agent_id: "same-conversation",
    task: { title: "首轮", goal: "创建可池化 session" },
  });
  const second = await runtime.run({
    agent_type: "fake",
    cwd: projectRoot,
    parent_agent_id: "same-conversation",
    mode: "analyze",
    task: { title: "第二轮", goal: "应复用上一轮 session" },
  });

  if (first.session_id !== second.session_id || !second.reused_session) {
    throw new Error(`会话池未复用：first=${first.session_id}, second=${second.session_id}, reused=${second.reused_session}`);
  }

  console.log("会话池复用测试通过");
} finally {
  await runtime.shutdown();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function renderConfig() {
  const normalizedProjectRoot = projectRoot.replaceAll("\\", "/");
  const normalizedTempDir = tempDir.replaceAll("\\", "/");
  const normalizedFakePath = fakePath.replaceAll("\\", "/");

  return `
[defaults]
timeout_secs = 30
inactivity_timeout_secs = 30
heartbeat_timeout_secs = 3
log_dir = "${normalizedTempDir}/logs"

[security]
allowed_cwd_roots = ["${normalizedProjectRoot}", "${normalizedTempDir}"]
allow_network = false

[session_pool]
enabled = true
max_pooled_sessions_per_parent = 2
max_context_usage_ratio = 0.9
idle_ttl_secs = 1800
reuse_policy = "auto"

[agents.fake]
description = "会话池复用测试 ACP agent"
command = "node"
args = ["${normalizedFakePath}"]
capabilities = ["test"]
`;
}

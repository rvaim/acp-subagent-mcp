#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../dist/config/loadConfig.js";
import { SubagentRuntime } from "../dist/runtime/subagentRuntime.js";

const projectRoot = process.cwd();
const tempDir = path.join(projectRoot, ".tmp-default-permissions-test");
const configPath = path.join(tempDir, "agents.toml");
const agentPath = path.join(tempDir, "write-agent.mjs");
const outputPath = path.join(tempDir, "subagent-output.txt");

fs.rmSync(tempDir, { recursive: true, force: true });
fs.mkdirSync(tempDir, { recursive: true });
fs.writeFileSync(agentPath, renderWriteAgent(), "utf8");
fs.writeFileSync(configPath, renderConfig(), "utf8");

const config = await loadConfig(configPath);
const runtime = new SubagentRuntime(config);

try {
  const result = await runtime.run({
    agent_type: "writer",
    cwd: tempDir,
    session_pool_policy: "disable",
    task: { title: "默认写权限测试", goal: "通过 ACP fs/write_text_file 写入文件" },
  });

  if (result.status !== "completed") {
    throw new Error(`写权限测试未完成：${JSON.stringify(result)}`);
  }
  if (fs.readFileSync(outputPath, "utf8") !== "default permission write ok") {
    throw new Error("默认权限没有成功写入目标文件");
  }

  console.log("默认写权限测试通过");
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
heartbeat_timeout_secs = 3
log_dir = "${normalizedTempDir}/logs"

[security]
allowed_cwd_roots = ["${normalizedProjectRoot}", "${normalizedTempDir}"]
allow_network = false

[session_pool]
enabled = false
reuse_policy = "disable"

[agents.writer]
description = "默认写权限测试 ACP agent"
command = "node"
args = ["${normalizedAgentPath}"]
capabilities = ["test"]
`;
}

function renderWriteAgent() {
  return String.raw`#!/usr/bin/env node
import readline from "node:readline";

let sessionCounter = 0;
let nextRequestId = 1000;
const pending = new Map();
const rl = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);

  if (message.id !== undefined && ("result" in message || "error" in message)) {
    const resolve = pending.get(message.id);
    if (resolve) {
      pending.delete(message.id);
      resolve(message);
    }
    return;
  }

  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { promptCapabilities: { embeddedContext: true }, sessionCapabilities: { close: {} } },
        agentInfo: { name: "write-agent", title: "Write Agent", version: "0.1.0" },
        authMethods: [],
      },
    });
    return;
  }

  if (message.method === "session/new") {
    sessionCounter += 1;
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "writer_session_" + sessionCounter } });
    return;
  }

  if (message.method === "session/prompt") {
    void handlePrompt(message);
    return;
  }

  if (message.method === "session/close") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }

  if (message.id !== undefined) {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unknown method" } });
  }
});

async function request(method, params) {
  const id = nextRequestId++;
  const response = await new Promise((resolve) => {
    pending.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
  if (response.error) {
    throw new Error(response.error.message);
  }
  return response.result;
}

async function handlePrompt(message) {
  const sessionId = String(message.params?.sessionId ?? "writer_session_unknown");
  let result;
  try {
    await request("fs/write_text_file", {
      path: "subagent-output.txt",
      content: "default permission write ok",
    });
    result = { status: "completed", summary: "默认写权限已允许", result: "ok", findings: [], files_changed: [{ path: "subagent-output.txt", action: "created" }], risks: [], next_steps: [], errors: [] };
  } catch (error) {
    result = { status: "failed", summary: String(error.message ?? error), result: "failed", findings: [], files_changed: [], risks: [], next_steps: [], errors: [{ code: "WRITE_DENIED", message: String(error.message ?? error) }] };
  }

  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(result) } } },
  });
  send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
}
`;
}

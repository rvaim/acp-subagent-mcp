#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { execFileSync, spawn } from "node:child_process";

/** 项目根目录。 */
const projectRoot = process.cwd();

/** 测试临时目录。 */
const tempDir = path.join(projectRoot, ".tmp-cancel-heartbeat-test");

/** 测试 ACP agent 路径。 */
const hangingAgentPath = path.join(projectRoot, "tests", "hanging-acp-agent.mjs");

/** 测试配置文件路径。 */
const configPath = path.join(tempDir, "agents.toml");

/** 孙进程 PID 文件路径。 */
const pidFile = path.join(tempDir, "grandchild.pid");

fs.rmSync(tempDir, { recursive: true, force: true });
fs.mkdirSync(tempDir, { recursive: true });
fs.writeFileSync(configPath, renderConfig(), "utf8");

await testMcpCancellationKillsProcessTree();
await testHeartbeatTimeoutKillsProcessTree();
console.log("取消与心跳进程树清理测试通过");

/**
 * 测试 MCP notifications/cancelled 能否杀掉忽略 SIGTERM 的孙进程。
 */
async function testMcpCancellationKillsProcessTree() {
  fs.rmSync(pidFile, { force: true });
  const client = startMcpServer();
  try {
    await initializeMcp(client, "cancel-test");
    client.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "subagent_run",
        arguments: {
          agent_type: "hang",
          cwd: projectRoot,
          timeout_secs: 120,
          heartbeat_timeout_secs: 30,
          inactivity_timeout_secs: 120,
          session_pool_policy: "disable",
          task: { title: "取消测试", goal: "启动后等待 MCP cancellation" },
        },
      },
    });

    const grandchildPid = Number(await waitForFile(pidFile));
    client.send({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 2, reason: "测试 MCP cancellation" },
    });

    await sleep(3500);
    assertProcessDead(grandchildPid, "MCP cancellation 后孙进程仍然存活");
  } finally {
    await client.stop();
  }
}

/**
 * 测试 heartbeat timeout 能否杀掉忽略 SIGTERM 的孙进程。
 */
async function testHeartbeatTimeoutKillsProcessTree() {
  fs.rmSync(pidFile, { force: true });
  const client = startMcpServer();
  try {
    await initializeMcp(client, "heartbeat-test");
    client.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "subagent_run",
        arguments: {
          agent_type: "hang",
          cwd: projectRoot,
          timeout_secs: 30,
          heartbeat_timeout_secs: 1,
          inactivity_timeout_secs: 120,
          session_pool_policy: "disable",
          task: { title: "心跳测试", goal: "启动后保持沉默，等待心跳超时" },
        },
      },
    });

    const grandchildPid = Number(await waitForFile(pidFile));
    const response = await client.waitForResponse(2, 10000);
    const text = String(response.result?.content?.[0]?.text ?? "");
    if (!text.includes("heartbeat_timeout")) {
      throw new Error(`没有收到 heartbeat_timeout 结果：${text.slice(0, 300)}`);
    }

    await sleep(1000);
    assertProcessDead(grandchildPid, "心跳超时后孙进程仍然存活");
  } finally {
    await client.stop();
  }
}

/**
 * 启动当前项目的 MCP Server。
 *
 * @returns 简单 MCP stdio 客户端。
 */
function startMcpServer() {
  const child = spawn("node", ["dist/index.js"], {
    cwd: projectRoot,
    env: { ...process.env, SUBAGENT_MCP_CONFIG: configPath },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const responses = new Map();
  const lineReader = readline.createInterface({ input: child.stdout });

  lineReader.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id !== undefined) {
      responses.set(message.id, message);
    }
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk.toString("utf8")));

  return {
    send(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    async waitForResponse(id, timeoutMs = 5000) {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        if (responses.has(id)) {
          return responses.get(id);
        }
        await sleep(50);
      }
      throw new Error(`等待 MCP response 超时：${id}`);
    },
    async stop() {
      lineReader.close();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.kill("SIGTERM");
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 1000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve(undefined);
        });
      });
    },
  };
}

/**
 * 完成 MCP initialize 握手。
 *
 * @param client 简单 MCP stdio 客户端。
 * @param name 测试客户端名称。
 */
async function initializeMcp(client, name) {
  client.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name, version: "0" } },
  });
  await client.waitForResponse(1);
  client.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
}

/**
 * 等待文件出现并返回内容。
 *
 * @param filePath 文件路径。
 * @param timeoutMs 超时时间，单位毫秒。
 * @returns 文件内容。
 */
async function waitForFile(filePath, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, "utf8").trim();
    }
    await sleep(50);
  }
  throw new Error(`等待文件超时：${filePath}`);
}

/**
 * 断言指定进程已经不存在。
 *
 * @param pid 进程 PID。
 * @param message 失败消息。
 */
function assertProcessDead(pid, message) {
  if (isProcessAlive(pid)) {
    throw new Error(`${message}：${processLine(pid)}`);
  }
}

/**
 * 判断进程是否存在。
 *
 * @param pid 进程 PID。
 * @returns 存活时返回 true。
 */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 返回进程表中的单行信息，便于失败时排查。
 *
 * @param pid 进程 PID。
 * @returns ps 输出。
 */
function processLine(pid) {
  try {
    return execFileSync("ps", ["-o", "pid=,ppid=,pgid=,stat=,command=", "-p", String(pid)], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "";
  }
}

/**
 * 等待指定毫秒。
 *
 * @param ms 等待时间。
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 生成测试用 agents.toml。
 *
 * @returns TOML 文本。
 */
function renderConfig() {
  const normalizedProjectRoot = projectRoot.replaceAll("\\\\", "/");
  const normalizedTempDir = tempDir.replaceAll("\\\\", "/");
  const normalizedAgentPath = hangingAgentPath.replaceAll("\\\\", "/");
  const normalizedPidFile = pidFile.replaceAll("\\\\", "/");

  return `
[defaults]
timeout_secs = 120
inactivity_timeout_secs = 120
heartbeat_timeout_secs = 30
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
max_pooled_sessions_per_parent = 4
max_context_usage_ratio = 0.9
idle_ttl_secs = 1800
reuse_policy = "disable"

[permissions.default]
read = "allow"
search = "allow"
edit = "deny"
execute = "deny"
network = "deny"

[agents.hang]
description = "取消与心跳测试用挂起 ACP agent。"
command = "node"
args = ["${normalizedAgentPath}"]
capabilities = ["test"]

[agents.hang.env]
PID_FILE = "${normalizedPidFile}"
`;
}

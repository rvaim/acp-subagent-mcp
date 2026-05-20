#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";
import { spawn } from "node:child_process";

/**
 * 取消与心跳测试用 ACP agent。
 *
 * 这个 agent 会故意忽略 session/cancel 和 SIGTERM，并在 session/prompt 时拉起一个
 * 同样忽略 SIGTERM 的孙进程。测试脚本用它来验证 MCP Server 是否真的能杀掉进程树。
 */
process.on("SIGTERM", () => undefined);

/** 孙进程 PID 写入路径，由测试脚本通过环境变量传入。 */
const pidFile = process.env.PID_FILE;

/** 当前 fake ACP session 序号。 */
let sessionCounter = 0;

/** ACP stdio 按行读取 JSON-RPC 消息。 */
const lineReader = readline.createInterface({ input: process.stdin });

/**
 * 写出一条 JSON-RPC 消息。
 *
 * @param message 要写出的消息对象。
 */
function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

lineReader.on("line", (line) => {
  if (!line.trim()) {
    return;
  }

  /** @type {{ id?: string | number, method?: string, params?: Record<string, unknown> }} */
  const message = JSON.parse(line);

  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: { close: {} } },
        agentInfo: { name: "hanging-acp-agent", title: "挂起测试 ACP Agent", version: "0.1.1" },
        authMethods: [],
      },
    });
    return;
  }

  if (message.method === "session/new") {
    sessionCounter += 1;
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: `hang_session_${sessionCounter}` } });
    return;
  }

  if (message.method === "session/prompt") {
    const child = spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{}, 1000);"],
      { stdio: "ignore" },
    );
    child.unref();

    if (pidFile) {
      fs.writeFileSync(pidFile, String(child.pid));
    }

    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: String(message.params?.sessionId ?? "hang_session_unknown"),
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `已启动忽略 SIGTERM 的孙进程：${child.pid}` },
        },
      },
    });
    return;
  }

  if (message.method === "session/cancel") {
    // 故意忽略取消通知，用于验证 MCP Server 的进程树兜底清理是否可靠。
    return;
  }

  if (message.method === "session/close") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }

  if (message.id !== undefined) {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `未知方法：${message.method}` } });
  }
});

// 保持测试 agent 常驻，直到 MCP Server 的清理逻辑杀掉它。
setInterval(() => undefined, 1000);

#!/usr/bin/env node
import readline from "node:readline";

/** 当前示例 agent 的会话序号。 */
let sessionCounter = 0;

/** 标准输入按行读取器，ACP stdio 使用一行一个 JSON-RPC 消息。 */
const rl = readline.createInterface({ input: process.stdin });

/**
 * 写出一条 JSON-RPC 消息。
 *
 * @param {unknown} message 要写出的 JSON-RPC 消息。
 */
function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/**
 * 从 prompt content block 中提取文本。
 *
 * @param {unknown} prompt ACP prompt 数组。
 * @returns {string} 文本内容。
 */
function extractPromptText(prompt) {
  if (!Array.isArray(prompt)) {
    return "";
  }
  return prompt
    .map((item) => (item && typeof item === "object" && item.type === "text" ? item.text ?? "" : ""))
    .join("\n");
}

rl.on("line", (line) => {
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
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: { embeddedContext: true },
          sessionCapabilities: { close: {} },
        },
        agentInfo: { name: "fake-acp-agent", title: "示例 ACP Agent", version: "0.1.5" },
        authMethods: [],
      },
    });
    return;
  }

  if (message.method === "session/new") {
    sessionCounter += 1;
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: `fake_session_${sessionCounter}` } });
    return;
  }

  if (message.method === "session/prompt") {
    const sessionId = String(message.params?.sessionId ?? "fake_session_unknown");
    const promptText = extractPromptText(message.params?.prompt);
    const result = {
      status: "completed",
      summary: "示例 ACP agent 已完成任务",
      result: `收到任务，prompt 字符数：${promptText.length}`,
      findings: [],
      files_changed: [],
      risks: [],
      next_steps: ["把 examples/agents.toml 中的 fake 换成真实 ACP agent 配置"],
      errors: [],
    };

    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: JSON.stringify(result, null, 2) },
        },
      },
    });
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    return;
  }

  if (message.method === "session/close") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }

  if (message.method === "session/cancel") {
    return;
  }

  if (message.id !== undefined) {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `未知方法：${message.method}` } });
  }
});

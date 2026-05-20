#!/usr/bin/env node
import readline from "node:readline";

let sessionCounter = 0;
const rl = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

rl.on("line", (line) => {
  if (!line.trim()) {
    return;
  }

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
        agentInfo: { name: "delayed-tool-acp-agent", title: "Delayed Tool ACP Agent", version: "0.1.0" },
        authMethods: [],
      },
    });
    return;
  }

  if (message.method === "session/new") {
    sessionCounter += 1;
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: `delayed_session_${sessionCounter}` } });
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

  if (message.method === "session/cancel") {
    return;
  }

  if (message.id !== undefined) {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `未知方法：${message.method}` } });
  }
});

async function handlePrompt(message) {
  const sessionId = String(message.params?.sessionId ?? "delayed_session_unknown");
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "delayed_write",
        title: "Write",
        kind: "edit",
        status: "pending",
      },
    },
  });

  await sleep(4000);

  const result = {
    status: "completed",
    summary: "延迟工具调用后完成",
    result: "ok",
    findings: [],
    files_changed: [],
    risks: [],
    next_steps: [],
    errors: [],
  };
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: JSON.stringify(result) },
      },
    },
  });
  send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
}

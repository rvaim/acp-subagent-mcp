#!/usr/bin/env node
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

/**
 * 一个极简 ACP mock agent，用于本项目 smoke test。
 *
 * 该 fixture 也使用官方 `@agentclientprotocol/sdk`，避免测试代码手写 ACP JSON-RPC 协议栈。
 */
class MockAcpAgent implements acp.Agent {
  /** 当前 ACP 连接。 */
  private readonly connection: acp.AgentSideConnection;
  /** 当前 session id。 */
  private sessionId = "sess_mock_1";

  /**
   * 创建 mock agent。
   */
  constructor(connection: acp.AgentSideConnection) {
    this.connection = connection;
  }

  /**
   * 初始化 ACP agent。
   */
  async initialize(_params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        promptCapabilities: { embeddedContext: false },
        sessionCapabilities: { close: {} },
        loadSession: false
      },
      agentInfo: { name: "mock-acp-agent", version: "0.3.2" },
      authMethods: []
    };
  }

  /**
   * 创建新的 mock session。
   */
  async newSession(_params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    this.sessionId = `sess_mock_${Math.random().toString(16).slice(2)}`;
    return { sessionId: this.sessionId };
  }

  /**
   * 处理 prompt，并通过 session/update 返回结构化文本。
   */
  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    const result = {
      status: "completed",
      summary: "mock agent 已完成任务。",
      result: "这是 mock ACP agent 返回的结果。",
      findings: [],
      files_changed: [],
      risks: [],
      next_steps: [],
      errors: []
    };

    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: JSON.stringify(result) }
      }
    });

    return { stopReason: "end_turn" };
  }

  /**
   * mock agent 不需要认证。
   */
  async authenticate(_params: acp.AuthenticateRequest): Promise<acp.AuthenticateResponse> {
    return {};
  }

  /**
   * mock agent 支持 session/close。
   */
  async closeSession(_params: acp.CloseSessionRequest): Promise<acp.CloseSessionResponse> {
    return {};
  }

  /**
   * mock agent 接收取消通知。
   */
  async cancel(_params: acp.CancelNotification): Promise<void> {
    return;
  }
}

// ACP agent stdio 方向：写到 stdout，读自 stdin。
const outputToClient = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
const inputFromClient = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
const stream = acp.ndJsonStream(outputToClient, inputFromClient);
new acp.AgentSideConnection((connection) => new MockAcpAgent(connection), stream);

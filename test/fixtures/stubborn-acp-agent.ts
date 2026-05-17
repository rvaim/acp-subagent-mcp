#!/usr/bin/env node
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

/**
 * 故意忽略 cancel 的 ACP agent，用于验证本地取消不会被 ACP cancel 卡住。
 */
class StubbornAcpAgent implements acp.Agent {
  private sessionId = "sess_stubborn_1";

  async initialize(_params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        promptCapabilities: { embeddedContext: false },
        sessionCapabilities: { close: {} },
        loadSession: false
      },
      agentInfo: { name: "stubborn-acp-agent", version: "0.1.0" },
      authMethods: []
    };
  }

  async newSession(_params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    this.sessionId = `sess_stubborn_${Math.random().toString(16).slice(2)}`;
    return { sessionId: this.sessionId };
  }

  async prompt(_params: acp.PromptRequest): Promise<acp.PromptResponse> {
    await new Promise(() => undefined);
    return { stopReason: "cancelled" };
  }

  async authenticate(_params: acp.AuthenticateRequest): Promise<acp.AuthenticateResponse> {
    return {};
  }

  async closeSession(_params: acp.CloseSessionRequest): Promise<acp.CloseSessionResponse> {
    return {};
  }

  async cancel(_params: acp.CancelNotification): Promise<void> {
    await new Promise(() => undefined);
  }
}

const outputToClient = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
const inputFromClient = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
const stream = acp.ndJsonStream(outputToClient, inputFromClient);
new acp.AgentSideConnection(() => new StubbornAcpAgent(), stream);

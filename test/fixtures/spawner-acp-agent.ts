#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

/**
 * 会再启动一个顽固孙进程的 ACP agent，用于验证 Unix process tree 清理。
 */
class SpawnerAcpAgent implements acp.Agent {
  private sessionId = "sess_spawner_1";
  private child?: ChildProcess;

  async initialize(_params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        promptCapabilities: { embeddedContext: false },
        sessionCapabilities: { close: {} },
        loadSession: false
      },
      agentInfo: { name: "spawner-acp-agent", version: "0.1.0" },
      authMethods: []
    };
  }

  async newSession(_params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    this.sessionId = `sess_spawner_${Math.random().toString(16).slice(2)}`;
    return { sessionId: this.sessionId };
  }

  async prompt(_params: acp.PromptRequest): Promise<acp.PromptResponse> {
    if (!this.child) {
      this.child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);"], {
        detached: process.platform !== "win32",
        stdio: "ignore"
      });
      const childPid = this.child.pid;
      if (process.env.SPAWNER_PID_FILE && childPid) {
        writeFileSync(process.env.SPAWNER_PID_FILE, String(childPid), "utf8");
      }
      this.child.unref();
    }

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
new acp.AgentSideConnection(() => new SpawnerAcpAgent(), stream);

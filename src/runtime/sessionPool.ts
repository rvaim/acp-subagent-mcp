import { createHash, randomUUID } from "node:crypto";
import type { GenericAcpClient } from "../acp/AcpClient.js";
import type { ServerConfig } from "../config/types.js";

/**
 * 会话池中的一个可复用子代理会话。
 */
export interface PooledSubagentSession {
  /** 会话池条目 ID，供 MCP Server 内部追踪。 */
  poolEntryId: string;

  /** 绑定的主 agent 标识，禁止跨主 agent 复用。 */
  parentAgentId: string;

  /** 子代理类型。 */
  agentType: string;

  /** ACP session id。 */
  sessionId: string;

  /** 子代理进程 ID。 */
  processId?: number;

  /** 工作目录。 */
  cwd?: string;

  /** 任务模式。 */
  mode?: string;

  /** MCP servers 配置签名。 */
  mcpServersFingerprint?: string;

  /** 权限策略签名。 */
  permissionPolicyFingerprint?: string;

  /** 估算的上下文使用比例，范围 0 到 1。 */
  contextUsageRatio?: number;

  /** 最近一次使用时间。 */
  lastUsedAt: Date;

  /** 当前会话是否空闲。 */
  idle: boolean;

  /** 最近几轮对话的压缩摘要。 */
  conversationSummary?: string;

  /** 内部保存的 ACP client。 */
  client: GenericAcpClient;
}

/**
 * 会话池查找输入参数。
 */
export interface AcquireSessionInput {
  /** 父代理 ID。 */
  parentAgentId: string;

  /** 子代理类型。 */
  agentType: string;

  /** 工作目录。 */
  cwd?: string;

  /** 任务模式。 */
  mode?: string;

  /** MCP servers 配置。 */
  mcpServers?: unknown;

  /** 权限策略签名。 */
  permissionPolicyFingerprint: string;
}

/**
 * 会话池释放输入参数。
 */
export interface ReleaseSessionInput extends AcquireSessionInput {
  /** ACP session id。 */
  sessionId: string;

  /** 子代理进程 ID。 */
  processId?: number;

  /** ACP client。 */
  client: GenericAcpClient;

  /** 上下文使用比例。 */
  contextUsageRatio: number;

  /** 对话摘要。 */
  conversationSummary?: string;
}

/**
 * 与主 agent 绑定的 ACP 子代理会话池。
 */
export class SessionPool {
  /** 池化 session 存储。 */
  private readonly entries = new Map<string, PooledSubagentSession>();

  /**
   * 创建会话池。
   *
   * @param config 服务器配置。
   */
  constructor(private readonly config: ServerConfig) {}

  /**
   * 从会话池获取兼容且空闲的 session。
   *
   * @param input 查找输入。
   * @returns 池化 session；未命中时返回 undefined。
   */
  acquire(input: AcquireSessionInput): PooledSubagentSession | undefined {
    const entry = this.findCompatible(input);
    if (!entry) {
      return undefined;
    }

    entry.idle = false;
    entry.lastUsedAt = new Date();
    return entry;
  }

  /**
   * 查看一个兼容且空闲的 session，但不占用它。
   *
   * @param input 查找输入。
   * @returns 池化 session；未命中时返回 undefined。
   */
  peek(input: AcquireSessionInput): PooledSubagentSession | undefined {
    return this.findCompatible(input);
  }

  /**
   * 将 session 释放回池中。
   *
   * @param input 释放输入。
   * @returns true 表示已入池，false 表示因为策略或阈值未入池。
   */
  release(input: ReleaseSessionInput): boolean {
    if (!this.config.session_pool.enabled) {
      return false;
    }
    if (input.contextUsageRatio >= this.config.session_pool.max_context_usage_ratio) {
      return false;
    }

    this.removeExpired();
    this.evictIfNeeded(input.parentAgentId);

    const entry: PooledSubagentSession = {
      poolEntryId: `pool_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      parentAgentId: input.parentAgentId,
      agentType: input.agentType,
      sessionId: input.sessionId,
      processId: input.processId,
      cwd: input.cwd,
      mode: input.mode,
      mcpServersFingerprint: fingerprint(input.mcpServers ?? {}),
      permissionPolicyFingerprint: input.permissionPolicyFingerprint,
      contextUsageRatio: input.contextUsageRatio,
      lastUsedAt: new Date(),
      idle: true,
      conversationSummary: input.conversationSummary,
      client: input.client,
    };

    this.entries.set(entry.poolEntryId, entry);
    return true;
  }

  /**
   * 移除指定池条目。
   *
   * @param poolEntryId 池条目 ID。
   */
  remove(poolEntryId: string): void {
    this.entries.delete(poolEntryId);
  }

  /**
   * 清理所有已过期空闲 session。
   */
  removeExpired(): void {
    const now = Date.now();
    const idleTtlMs = this.config.session_pool.idle_ttl_secs * 1000;
    for (const [id, entry] of this.entries.entries()) {
      if (entry.idle && now - entry.lastUsedAt.getTime() > idleTtlMs) {
        void entry.client.shutdown();
        this.entries.delete(id);
      }
    }
  }

  /**
   * 关闭并清空所有池化 session。
   */
  async shutdownAll(): Promise<void> {
    const clients = Array.from(this.entries.values()).map((entry) => entry.client);
    this.entries.clear();
    await Promise.allSettled(clients.map((client) => client.shutdown()));
  }

  /**
   * 查找兼容且空闲的 session。
   *
   * @param input 查找输入。
   * @returns 命中的池化 session；未命中时返回 undefined。
   */
  private findCompatible(input: AcquireSessionInput): PooledSubagentSession | undefined {
    if (!this.config.session_pool.enabled) {
      return undefined;
    }

    this.removeExpired();
    const mcpFingerprint = fingerprint(input.mcpServers ?? {});

    for (const entry of this.entries.values()) {
      const compatible =
        entry.idle &&
        entry.parentAgentId === input.parentAgentId &&
        entry.agentType === input.agentType &&
        entry.cwd === input.cwd &&
        entry.mode === input.mode &&
        entry.mcpServersFingerprint === mcpFingerprint &&
        entry.permissionPolicyFingerprint === input.permissionPolicyFingerprint &&
        (entry.contextUsageRatio ?? 0) < this.config.session_pool.max_context_usage_ratio;

      if (compatible) {
        return entry;
      }
    }

    return undefined;
  }

  /**
   * 若某个父代理的池条目超过限制，则按 LRU 淘汰。
   *
   * @param parentAgentId 父代理 ID。
   */
  private evictIfNeeded(parentAgentId: string): void {
    const entries = Array.from(this.entries.values())
      .filter((entry) => entry.parentAgentId === parentAgentId)
      .sort((a, b) => a.lastUsedAt.getTime() - b.lastUsedAt.getTime());

    while (entries.length >= this.config.session_pool.max_pooled_sessions_per_parent) {
      const oldest = entries.shift();
      if (!oldest) {
        break;
      }
      void oldest.client.shutdown();
      this.entries.delete(oldest.poolEntryId);
    }
  }
}

/**
 * 对配置对象生成稳定签名。
 *
 * @param value 待签名值。
 * @returns sha256 签名。
 */
export function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

/**
 * 稳定 JSON 序列化，保证对象 key 顺序固定。
 *
 * @param value 待序列化值。
 * @returns 稳定 JSON 字符串。
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

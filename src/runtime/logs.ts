import { mkdir, writeFile, appendFile, chmod } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { LogsConfig } from "../config/types.js";
import { redactJson, redactText } from "./redact.js";

/**
 * 单次子代理运行的日志路径集合。
 */
export interface RunLogPaths {
  /** 运行目录。 */
  runDir: string;
  /** 任务 JSON。 */
  taskJson: string;
  /** 渲染后的 prompt。 */
  renderedPrompt: string;
  /** ACP 事件日志。 */
  eventsJsonl: string;
  /** 子进程 stderr。 */
  stderrLog: string;
  /** 最终结果 JSON。 */
  resultJson: string;
}

/**
 * 运行日志写入器。
 */
export class RunLogger {
  /** 日志路径。 */
  readonly paths: RunLogPaths;
  /** 日志配置。 */
  private readonly config: LogsConfig;
  /** 已写入事件字节数。 */
  private eventBytes = 0;
  /** 已写入 stderr 字节数。 */
  private stderrBytes = 0;

  /**
   * 创建日志写入器。
   */
  constructor(paths: RunLogPaths, config: LogsConfig) {
    this.paths = paths;
    this.config = config;
  }

  /**
   * 写入 JSON 文件。
   */
  async writeJson(relativeName: "task.json" | "result.json", value: unknown): Promise<void> {
    if (!this.config.enabled) return;
    const target = relativeName === "task.json" ? this.paths.taskJson : this.paths.resultJson;
    const safeValue = this.config.redact ? redactJson(value) : value;
    await writeFileSecure(target, `${JSON.stringify(safeValue, null, 2)}\n`);
  }

  /**
   * 写入渲染后的 prompt。
   */
  async writePrompt(prompt: string): Promise<void> {
    if (!this.config.enabled || this.config.save_rendered_prompt === "off") return;
    const content = this.config.save_rendered_prompt === "redacted" ? redactText(prompt) : prompt;
    await writeFileSecure(this.paths.renderedPrompt, content);
  }

  /**
   * 追加 ACP 事件。
   */
  async appendEvent(event: unknown): Promise<void> {
    if (!this.config.enabled || this.eventBytes >= this.config.max_event_bytes) return;
    const safeEvent = this.config.redact ? redactJson(event) : event;
    const line = `${JSON.stringify(safeEvent)}\n`;
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (this.eventBytes + lineBytes > this.config.max_event_bytes) return;
    this.eventBytes += lineBytes;
    await appendFile(this.paths.eventsJsonl, line, { mode: 0o600 });
  }

  /**
   * 追加子进程 stderr。
   */
  async appendStderr(chunk: string): Promise<void> {
    if (!this.config.enabled || this.stderrBytes >= this.config.max_stderr_bytes) return;
    const safeChunk = this.config.redact ? redactText(chunk) : chunk;
    const chunkBytes = Buffer.byteLength(safeChunk, "utf8");
    const remaining = this.config.max_stderr_bytes - this.stderrBytes;
    const finalChunk = chunkBytes > remaining ? safeChunk.slice(0, remaining) : safeChunk;
    this.stderrBytes += Buffer.byteLength(finalChunk, "utf8");
    await appendFile(this.paths.stderrLog, finalChunk, { mode: 0o600 });
  }
}

/**
 * 创建单次运行日志目录。
 */
export async function createRunLogger(options: {
  cwd: string;
  logDir: string;
  taskId: string;
  config: LogsConfig;
}): Promise<RunLogger> {
  const baseDir = path.isAbsolute(options.logDir) ? options.logDir : path.resolve(options.cwd, options.logDir);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(baseDir, `run_${timestamp}_${options.taskId}_${randomUUID().slice(0, 8)}`);

  if (options.config.enabled) {
    await mkdir(runDir, { recursive: true, mode: 0o700 });
    await chmod(runDir, 0o700).catch(() => undefined);
  }

  return new RunLogger({
    runDir,
    taskJson: path.join(runDir, "task.json"),
    renderedPrompt: path.join(runDir, "rendered_prompt.md"),
    eventsJsonl: path.join(runDir, "events.jsonl"),
    stderrLog: path.join(runDir, "stderr.log"),
    resultJson: path.join(runDir, "result.json")
  }, options.config);
}

/**
 * 使用 0600 权限安全写入文件。
 */
async function writeFileSecure(filePath: string, content: string): Promise<void> {
  await writeFile(filePath, content, { mode: 0o600 });
  await chmod(filePath, 0o600).catch(() => undefined);
}

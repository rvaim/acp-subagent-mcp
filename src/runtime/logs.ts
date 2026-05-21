import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { redactJsonString, redactText, redactValue } from "./redact.js";

/**
 * 单次子代理运行的日志路径集合。
 */
export interface RunLogPaths {
  /** 本次运行的日志目录。 */
  runDir: string;

  /** 脱敏后的结构化任务文件。 */
  taskPath: string;

  /** 实际发送给子代理的 prompt 文件。 */
  renderedPromptPath: string;

  /** 原始 ACP 事件 JSONL 文件。 */
  eventsPath: string;

  /** 子进程 stderr 日志文件。 */
  stderrPath: string;

  /** 最终结果文件。 */
  resultPath: string;

}

/**
 * 创建单次运行的日志目录。
 *
 * @param baseDir 配置中的日志根目录。
 * @returns 日志路径集合。
 */
export async function createRunLogs(baseDir: string): Promise<RunLogPaths> {
  const now = new Date();
  const safeTimestamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const suffix = randomBytes(4).toString("hex");
  const runDir = path.resolve(baseDir, `run_${safeTimestamp}_${suffix}`);

  await fs.mkdir(runDir, { recursive: true });

  return {
    runDir,
    taskPath: path.join(runDir, "task.json"),
    renderedPromptPath: path.join(runDir, "rendered_prompt.md"),
    eventsPath: path.join(runDir, "events.jsonl"),
    stderrPath: path.join(runDir, "stderr.log"),
    resultPath: path.join(runDir, "result.json"),
  };
}

/**
 * 写入脱敏 JSON 文件。
 *
 * @param filePath 文件路径。
 * @param value 要写入的数据。
 */
export async function writeRedactedJson(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, `${redactJsonString(value, 2)}\n`, "utf8");
}

/**
 * 写入脱敏文本文件。
 *
 * @param filePath 文件路径。
 * @param text 要写入的文本。
 */
export async function writeRedactedText(filePath: string, text: string): Promise<void> {
  await fs.writeFile(filePath, redactText(text), "utf8");
}

/**
 * 追加一条脱敏事件到 JSONL 日志。
 *
 * @param filePath 事件日志路径。
 * @param event 原始事件。
 */
export async function appendEventLog(filePath: string, event: unknown): Promise<void> {
  const line = JSON.stringify({ ts: new Date().toISOString(), event: redactValue(event) });
  await fs.appendFile(filePath, `${line}\n`, "utf8");
}

/**
 * 追加脱敏 stderr 文本。
 *
 * @param filePath stderr 日志路径。
 * @param chunk 原始 stderr 文本片段。
 */
export async function appendStderrLog(filePath: string, chunk: string): Promise<void> {
  await fs.appendFile(filePath, redactText(chunk), "utf8");
}

/**
 * 读取日志文件的尾部内容。
 *
 * @param filePath 日志文件路径。
 * @param maxChars 最大返回字符数。
 * @returns 日志尾部内容。
 */
export async function readLogTail(filePath: string, maxChars: number): Promise<string> {
  const raw = await fs.readFile(filePath, "utf8");
  if (raw.length <= maxChars) {
    return raw;
  }
  return raw.slice(raw.length - maxChars);
}

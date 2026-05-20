#!/usr/bin/env node
import { loadConfig } from "./config/loadConfig.js";
import { startStdioServer } from "./server.js";

/**
 * 程序入口。
 *
 * 该入口只负责加载配置并通过 stdio 启动 MCP Server。
 */
async function main(): Promise<void> {
  const config = await loadConfig();
  await startStdioServer(config);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});

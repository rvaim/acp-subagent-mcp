#!/usr/bin/env node
import { loadConfig, renderClaudeDesktopConfigJson, renderDefaultConfigToml, resolveConfigSourceFromArgs } from "./config/loadConfig.js";
import { startMcpServer } from "./server.js";

/**
 * 进程入口。正常 MCP stdio 模式下 stdout 只能写协议消息；只有显式 CLI
 * 辅助命令会在连接 MCP 前向 stdout 输出文本。
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write([
      "acp-subagent-mcp",
      "",
      "用法：",
      "  acp-subagent-mcp                       # 使用默认配置启动 MCP Server",
      "  acp-subagent-mcp --config agents.toml  # 使用高级配置文件",
      "  acp-subagent-mcp --print-claude-desktop-config",
      "  acp-subagent-mcp --print-default-config",
      "",
      "常用环境变量：",
      "  ACP_SUBAGENT_ALLOWED_ROOTS=/path/a,/path/b",
      "  ACP_SUBAGENT_CLAUDE_COMMAND=claude-agent-acp",
      "  ACP_SUBAGENT_DEFAULT_AGENT=claude",
      ""
    ].join("\n"));
    return;
  }

  if (argv.includes("--print-default-config")) {
    process.stdout.write(renderDefaultConfigToml());
    return;
  }

  if (argv.includes("--print-claude-desktop-config")) {
    process.stdout.write(renderClaudeDesktopConfigJson());
    return;
  }

  const configSource = await resolveConfigSourceFromArgs(argv);
  const config = await loadConfig(configSource);
  await startMcpServer(config);
}

main().catch((error) => {
  // MCP stdio 规定 stdout 只能写协议消息；启动失败只能写 stderr。
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});

#!/usr/bin/env node
import { loadConfig, renderClaudeDesktopConfigJson, renderCodexConfigToml, renderDefaultConfigToml, renderGenericMcpConfigJson, resolveConfigSourceFromArgs } from "./config/loadConfig.js";
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
      "  acp-subagent-mcp --print-codex-config",
      "  acp-subagent-mcp --print-generic-mcp-config",
      "  acp-subagent-mcp --print-default-config",
      "",
      "常用环境变量：",
      "  ACP_SUBAGENT_DEFAULT_AGENT_COMMAND=claude-agent-acp",
      "  ACP_SUBAGENT_DEFAULT_AGENT=claude",
      "  ACP_SUBAGENT_ENV_POLICY=all          # all | allowlist | none，默认 all",
      "  ACP_SUBAGENT_ENV_ALLOWLIST=ANTHROPIC_*,PATH,HOME  # policy=allowlist 时使用",
      "  ACP_SUBAGENT_WORKSPACE_ROOTS=/path/a,/path/b       # 可选；生产环境严格限制工作区",
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

  if (argv.includes("--print-codex-config")) {
    process.stdout.write(renderCodexConfigToml());
    return;
  }

  if (argv.includes("--print-generic-mcp-config")) {
    process.stdout.write(renderGenericMcpConfigJson());
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

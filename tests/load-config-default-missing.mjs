import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../dist/config/loadConfig.js";

const originalCwd = process.cwd();
const originalConfigEnv = process.env.SUBAGENT_MCP_CONFIG;
const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "acp-subagent-mcp-config-"));

try {
  delete process.env.SUBAGENT_MCP_CONFIG;
  process.chdir(tmpdir);
  const expectedConfigPath = path.resolve("agents.toml");

  const config = await loadConfig();

  assert.deepEqual(Object.keys(config.agents), ["claude"]);
  assert.deepEqual(config.agents.claude, {
    description: "默认 ACP coding agent。可通过 SUBAGENT_MCP_DEFAULT_AGENT_* 环境变量覆盖。",
    command: "npx",
    args: ["-y", "@agentclientprotocol/claude-agent-acp"],
    capabilities: ["code", "review", "edit", "analysis"],
    env: {},
  });
  assert.equal(config.configPath, expectedConfigPath);

  process.env.SUBAGENT_MCP_DEFAULT_AGENT_TYPE = "gemini";
  process.env.SUBAGENT_MCP_DEFAULT_AGENT_DESCRIPTION = "env configured agent";
  process.env.SUBAGENT_MCP_DEFAULT_AGENT_COMMAND = "gemini";
  process.env.SUBAGENT_MCP_DEFAULT_AGENT_ARGS = '["--acp"]';
  process.env.SUBAGENT_MCP_DEFAULT_AGENT_CAPABILITIES = '["analysis","review"]';
  process.env.SUBAGENT_MCP_TIMEOUT_SECS = "42";

  const envConfig = await loadConfig();
  assert.deepEqual(Object.keys(envConfig.agents), ["gemini"]);
  assert.equal(envConfig.agents.gemini.command, "gemini");
  assert.deepEqual(envConfig.agents.gemini.args, ["--acp"]);
  assert.deepEqual(envConfig.agents.gemini.capabilities, ["analysis", "review"]);
  assert.equal(envConfig.agents.gemini.description, "env configured agent");
  assert.equal(envConfig.defaults.timeout_secs, 42);

  process.env.SUBAGENT_MCP_CONFIG = path.join(tmpdir, "missing-explicit.toml");
  await assert.rejects(() => loadConfig(), { code: "ENOENT" });

  delete process.env.SUBAGENT_MCP_CONFIG;
  delete process.env.SUBAGENT_MCP_DEFAULT_AGENT_TYPE;
  delete process.env.SUBAGENT_MCP_DEFAULT_AGENT_DESCRIPTION;
  delete process.env.SUBAGENT_MCP_DEFAULT_AGENT_COMMAND;
  delete process.env.SUBAGENT_MCP_DEFAULT_AGENT_ARGS;
  delete process.env.SUBAGENT_MCP_DEFAULT_AGENT_CAPABILITIES;
  delete process.env.SUBAGENT_MCP_TIMEOUT_SECS;

  const commandlessToml = path.join(tmpdir, "commandless.toml");
  await fs.writeFile(
    commandlessToml,
    `
[agents.gemini]
description = "Gemini by name only"

[agents.codex]
description = "Codex by name only"
`,
  );
  const commandlessConfig = await loadConfig(commandlessToml);
  assert.equal(commandlessConfig.agents.gemini.command, "gemini");
  assert.deepEqual(commandlessConfig.agents.gemini.args, ["--acp"]);
  assert.equal(commandlessConfig.agents.codex.command, "npx");
  assert.deepEqual(commandlessConfig.agents.codex.args, ["-y", "@zed-industries/codex-acp"]);
} finally {
  process.chdir(originalCwd);
  if (originalConfigEnv === undefined) {
    delete process.env.SUBAGENT_MCP_CONFIG;
  } else {
    process.env.SUBAGENT_MCP_CONFIG = originalConfigEnv;
  }
  delete process.env.SUBAGENT_MCP_DEFAULT_AGENT_TYPE;
  delete process.env.SUBAGENT_MCP_DEFAULT_AGENT_DESCRIPTION;
  delete process.env.SUBAGENT_MCP_DEFAULT_AGENT_COMMAND;
  delete process.env.SUBAGENT_MCP_DEFAULT_AGENT_ARGS;
  delete process.env.SUBAGENT_MCP_DEFAULT_AGENT_CAPABILITIES;
  delete process.env.SUBAGENT_MCP_TIMEOUT_SECS;
  await fs.rm(tmpdir, { recursive: true, force: true });
}

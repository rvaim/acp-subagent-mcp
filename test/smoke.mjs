import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../dist/src/config/loadConfig.js';
import { ConcurrencyManager } from '../dist/src/runtime/concurrency.js';
import { TaskRegistry } from '../dist/src/runtime/taskRegistry.js';
import { handleSubagentRun } from '../dist/src/tools/subagentRun.js';
import { handleSubagentStart } from '../dist/src/tools/subagentStart.js';
import { handleSubagentStartMany } from '../dist/src/tools/subagentStartMany.js';
import { handleSubagentWait } from '../dist/src/tools/subagentWait.js';
import { handleSubagentResult } from '../dist/src/tools/subagentResult.js';
import { handleSubagentContinue } from '../dist/src/tools/subagentContinue.js';
import { handleSubagentClose } from '../dist/src/tools/subagentClose.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = await mkdtemp(path.join(os.tmpdir(), 'acp-subagent-smoke-'));
const configPath = path.join(tmp, 'agents.toml');
const mockAgent = path.join(root, 'dist/test/fixtures/mock-acp-agent.js');
await writeFile(configPath, `
[defaults]
timeout_secs = 20
inactivity_timeout_secs = 5
max_depth = 2
max_prompt_chars = 120000
max_inline_file_chars = 30000
log_dir = ".subagent-runs"
session_ttl_secs = 60
completed_session_ttl_secs = 10
max_active_sessions = 4
acp_cancel_grace_ms = 500
process_kill_grace_ms = 500

[security]
allowed_cwd_roots = ["${tmp}"]
allow_network = false
max_read_file_bytes = 1048576
require_absolute_agent_command = false

[concurrency]
max_parallel_tasks = 4
default_conflict_policy = "single_writer_per_cwd"

[logs]
enabled = true
redact = true
retention_days = 7
max_event_bytes = 10485760
max_stderr_bytes = 1048576
save_rendered_prompt = "redacted"
file_mode = "0600"

[worktree]
enabled = false
base_dir = ".subagent-worktrees"
keep_on_failure = true
keep_on_success = false
max_patch_bytes = 2000000
include_untracked = false

[permissions.default]
read = "allow"
search = "allow"
edit = "deny"
execute = "deny"
network = "deny"

[agents.mock]
description = "mock"
command = "node"
args = ["${mockAgent}"]
capabilities = ["analysis"]
`);

const config = await loadConfig(configPath);
const deps = { config, concurrency: new ConcurrencyManager(), registry: new TaskRegistry() };

const run = await handleSubagentRun({ agent_type: 'mock', cwd: tmp, task: { title: '同步', goal: '返回结果' } }, deps);
assert(run.status === 'completed', 'subagent_run 应成功');

const start = await handleSubagentStart({ agent_type: 'mock', cwd: tmp, keep_alive: true, task: { title: '异步', goal: '返回结果' } }, deps);
assert(start.status === 'started', 'subagent_start 应成功');

const wait = await handleSubagentWait({ task_ids: [start.task_id], return_when: 'all_completed', timeout_secs: 5 }, deps);
assert(wait.status === 'completed' && wait.completed.length === 1, 'subagent_wait 应拿到结果');

const continued = await handleSubagentContinue({ task_id: start.task_id, message: '请继续返回一次 JSON。' }, deps);
assert(continued.status === 'started', 'subagent_continue 应成功');

const wait2 = await handleSubagentWait({ task_ids: [start.task_id], return_when: 'all_completed', timeout_secs: 5 }, deps);
assert(wait2.status === 'completed', 'continue 后 wait 应成功');

const result = await handleSubagentResult({ task_id: start.task_id }, deps);
assert(result.status === 'completed' && result.result?.status === 'completed', 'subagent_result 应返回最终结果');

const many = await handleSubagentStartMany({
  conflict_policy: 'allow_readonly_parallel',
  tasks: [
    { agent_type: 'mock', cwd: tmp, task: { title: '并行 A', goal: '返回结果' } },
    { agent_type: 'mock', cwd: tmp, task: { title: '并行 B', goal: '返回结果' } }
  ]
}, deps);
assert(many.started.length === 2, 'subagent_start_many 应启动两个任务');
const manyWait = await handleSubagentWait({ task_ids: many.started.map((item) => item.task_id), return_when: 'all_completed', timeout_secs: 5 }, deps);
assert(manyWait.completed.length === 2, '并行任务应全部完成');

const close = await handleSubagentClose({ task_id: start.task_id }, deps);
assert(close.status === 'closed', 'subagent_close 应成功');

console.log('smoke ok');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

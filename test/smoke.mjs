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
import { handleSubagentRunMany } from '../dist/src/tools/subagentRunMany.js';
import { handleSubagentWait } from '../dist/src/tools/subagentWait.js';
import { handleSubagentResult } from '../dist/src/tools/subagentResult.js';
import { handleSubagentContinue } from '../dist/src/tools/subagentContinue.js';
import { handleSubagentClose } from '../dist/src/tools/subagentClose.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = await mkdtemp(path.join(os.tmpdir(), 'acp-subagent-smoke-'));
const configPath = path.join(tmp, 'agents.toml');
const mockAgent = path.join(root, 'dist/test/fixtures/mock-acp-agent.js');
const stubbornAgent = path.join(root, 'dist/test/fixtures/stubborn-acp-agent.js');
await writeFile(configPath, `
[defaults]
timeout_secs = 20
inactivity_timeout_secs = 5
max_depth = 2
max_prompt_chars = 120000
max_inline_file_chars = 30000
log_dir = ".subagents/runs"
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
base_dir = ".subagents/worktrees"
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

[agents.stubborn]
description = "stubborn"
command = "node"
args = ["${stubbornAgent}"]
capabilities = ["analysis"]
`);

const config = await loadConfig(configPath);
const deps = { config, concurrency: new ConcurrencyManager(), registry: new TaskRegistry() };

const run = await handleSubagentRun({ agent_type: 'mock', cwd: tmp, task: { title: '同步', goal: '返回结果' } }, deps);
assert(run.status === 'completed', 'subagent_run 应成功');

const cancelController = new AbortController();
const cancelDeps = { config, concurrency: new ConcurrencyManager(), registry: new TaskRegistry(), requestSignal: cancelController.signal };
const slowRunPromise = handleSubagentRun({
  agent_type: 'mock',
  cwd: tmp,
  timeout_secs: 20,
  task: { title: '取消测试', goal: '__SLOW__ 模拟长时间运行，随后由 MCP request signal 取消。' }
}, cancelDeps);
await waitUntil(() => cancelDeps.registry.list().some((task) => task.status === 'running'));
cancelController.abort(new Error('manual stop from MCP host'));
const cancelledRun = await slowRunPromise;
assert(cancelledRun.status === 'cancelled', 'request signal abort 后 subagent_run 应返回 cancelled');
assert(cancelDeps.registry.list().every((task) => task.cleanedUp), 'request signal abort 后子代理进程应被清理');
assert(cancelDeps.concurrency.getActiveTaskCount() === 0, 'request signal abort 后并发锁应释放');

const stubbornCancelController = new AbortController();
const stubbornCancelDeps = { config, concurrency: new ConcurrencyManager(), registry: new TaskRegistry(), requestSignal: stubbornCancelController.signal };
const stubbornRunPromise = handleSubagentRun({
  agent_type: 'stubborn',
  cwd: tmp,
  timeout_secs: 20,
  task: { title: '顽固取消测试', goal: '这个 agent 会忽略 ACP cancel，本地必须强制清理进程树。' }
}, stubbornCancelDeps);
await waitUntil(() => stubbornCancelDeps.registry.list().some((task) => task.status === 'running'));
const stubbornCancelStartedAt = Date.now();
stubbornCancelController.abort(new Error('manual stop stubborn agent'));
const stubbornCancelledRun = await stubbornRunPromise;
assert(stubbornCancelledRun.status === 'cancelled', '忽略 ACP cancel 的子代理也应被 request signal 取消');
assert(Date.now() - stubbornCancelStartedAt < 5000, '忽略 ACP cancel 时不应长时间卡住取消流程');
assert(stubbornCancelDeps.registry.list().every((task) => task.cleanedUp), '忽略 ACP cancel 的子代理进程应被清理');

const waitCancelDeps = { config, concurrency: new ConcurrencyManager(), registry: new TaskRegistry() };
const slowStart = await handleSubagentStart({
  agent_type: 'mock',
  cwd: tmp,
  keep_alive: true,
  timeout_secs: 20,
  task: { title: 'wait 取消测试', goal: '__SLOW__ 模拟长时间运行，随后取消 wait。' }
}, waitCancelDeps);
const waitCancelController = new AbortController();
const waitPromise = handleSubagentWait(
  { task_ids: [slowStart.task_id], return_when: 'all_completed', timeout_secs: 20 },
  { ...waitCancelDeps, requestSignal: waitCancelController.signal }
).catch((error) => error);
await waitUntil(() => waitCancelDeps.registry.get(slowStart.task_id)?.status === 'running');
waitCancelController.abort(new Error('manual stop wait'));
const waitCancelled = await waitPromise;
assert(waitCancelled instanceof Error, 'request signal abort 后 subagent_wait 应停止当前等待');
await waitCancelDeps.registry.get(slowStart.task_id)?.currentTurnPromise?.catch(() => undefined);
assert(waitCancelDeps.registry.get(slowStart.task_id)?.status === 'cancelled', '取消 wait 后关联子代理任务应取消');
assert(waitCancelDeps.registry.get(slowStart.task_id)?.cleanedUp === true, '取消 wait 后关联子代理进程应清理');

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

const runMany = await handleSubagentRunMany({
  conflict_policy: 'allow_readonly_parallel',
  tasks: [
    { agent_type: 'mock', cwd: tmp, task: { title: '同步批量 A', goal: '返回结果' } },
    { agent_type: 'mock', cwd: tmp, task: { title: '同步批量 B', goal: '返回结果' } }
  ],
  return_when: 'all_completed',
  wait_timeout_secs: 5
}, deps);
assert(runMany.status === 'completed' && runMany.completed.length === 2, 'subagent_run_many 应启动并等待两个任务完成');

const runManyCancelController = new AbortController();
const runManyCancelDeps = { config, concurrency: new ConcurrencyManager(), registry: new TaskRegistry(), requestSignal: runManyCancelController.signal };
const runManySlowPromise = handleSubagentRunMany({
  conflict_policy: 'allow_readonly_parallel',
  tasks: [
    { agent_type: 'mock', cwd: tmp, timeout_secs: 20, task: { title: '同步批量取消 A', goal: '__SLOW__ 模拟长时间运行。' } },
    { agent_type: 'mock', cwd: tmp, timeout_secs: 20, task: { title: '同步批量取消 B', goal: '__SLOW__ 模拟长时间运行。' } }
  ],
  return_when: 'all_completed',
  wait_timeout_secs: 20
}, runManyCancelDeps).catch((error) => error);
await waitUntil(() => runManyCancelDeps.registry.list().length === 2 && runManyCancelDeps.registry.list().every((task) => task.status === 'running'));
runManyCancelController.abort(new Error('manual stop run_many'));
const runManyCancelled = await runManySlowPromise;
assert(runManyCancelled instanceof Error, 'request signal abort 后 subagent_run_many 应停止当前等待');
await Promise.allSettled(runManyCancelDeps.registry.list().map((task) => task.currentTurnPromise));
assert(runManyCancelDeps.registry.list().every((task) => task.status === 'cancelled'), '取消 run_many 后所有子代理任务应取消');
assert(runManyCancelDeps.registry.list().every((task) => task.cleanedUp), '取消 run_many 后所有子代理进程应清理');

const close = await handleSubagentClose({ task_id: start.task_id }, deps);
assert(close.status === 'closed', 'subagent_close 应成功');

console.log('smoke ok');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitUntil(predicate, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('等待条件超时');
}

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../dist/src/config/loadConfig.js';
import { ConcurrencyManager } from '../dist/src/runtime/concurrency.js';
import { TaskRegistry } from '../dist/src/runtime/taskRegistry.js';
import { handleSubagentRun } from '../dist/src/tools/subagentRun.js';
import { handleSubagentRunMany } from '../dist/src/tools/subagentRunMany.js';
import { handleSubagentRevise } from '../dist/src/tools/subagentRevise.js';
import { handleSubagentReviseMany } from '../dist/src/tools/subagentReviseMany.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = await mkdtemp(path.join(os.tmpdir(), 'acp-subagent-smoke-'));
const configPath = path.join(tmp, 'agents.toml');
const mockAgent = path.join(root, 'dist/test/fixtures/mock-acp-agent.js');
const stubbornAgent = path.join(root, 'dist/test/fixtures/stubborn-acp-agent.js');
const spawnerAgent = path.join(root, 'dist/test/fixtures/spawner-acp-agent.js');
const spawnerPidFile = path.join(tmp, 'spawner-child.pid');
await writeFile(configPath, `
[defaults]
timeout_secs = 20
inactivity_timeout_secs = 5
max_depth = 2
max_prompt_chars = 120000
max_inline_file_chars = 30000
log_dir = ".subagents/runs"
acp_cancel_grace_ms = 500
process_kill_grace_ms = 500
mcp_request_heartbeat_ms = 0

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

[agents.spawner]
description = "spawner"
command = "node"
args = ["${spawnerAgent}"]
capabilities = ["analysis"]

[agents.spawner.env]
SPAWNER_PID_FILE = "${spawnerPidFile}"
`);

const config = await loadConfig(configPath);
const deps = { config, concurrency: new ConcurrencyManager(), registry: new TaskRegistry() };

const run = await handleSubagentRun({ agent_type: 'mock', cwd: tmp, task: { title: '同步', goal: '返回结果' } }, deps);
assert(run.status === 'completed', 'subagent_run 应成功');
assert(run.task_id, 'subagent_run 应返回 task_id 以支持后续 revise');
assert(deps.registry.get(run.task_id)?.cleanedUp === true, 'subagent_run 完成后应清理子代理进程');
assert(deps.registry.get(run.task_id)?.client === undefined, 'subagent_run 完成后不应保留 ACP client');

const revised = await handleSubagentRevise({
  task_id: run.task_id,
  correction: { reason: '主代理审核认为结果太短。', expected_change: '重新给出完整一点的结果。' },
  message: '请保持 JSON 输出契约。'
}, deps);
assert(revised.status === 'completed', 'subagent_revise 应成功');
assert(revised.revision_of_task_id === run.task_id, 'subagent_revise 应记录 revision_of_task_id');
assert(deps.registry.get(revised.task_id)?.cleanedUp === true, 'subagent_revise 完成后应清理子代理进程');

const reviseByPayload = await handleSubagentRevise({
  agent_type: 'mock',
  cwd: tmp,
  task: { title: '显式重写', goal: '返回结果' },
  previous_result: '上一轮结果不合格。',
  correction: { reason: '缺少关键内容。', expected_change: '补齐关键内容。' }
}, deps);
assert(reviseByPayload.status === 'completed', 'subagent_revise 应支持显式 task + previous_result');

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

const spawnerCancelController = new AbortController();
const spawnerCancelDeps = { config, concurrency: new ConcurrencyManager(), registry: new TaskRegistry(), requestSignal: spawnerCancelController.signal };
const spawnerRunPromise = handleSubagentRun({
  agent_type: 'spawner',
  cwd: tmp,
  timeout_secs: 20,
  task: { title: '孙进程清理测试', goal: '这个 agent 会启动一个单独 process group 的孙进程。' }
}, spawnerCancelDeps);
await waitUntil(async () => {
  try {
    const pid = Number(await readFile(spawnerPidFile, 'utf8'));
    return Number.isFinite(pid) && isPidAlive(pid);
  } catch {
    return false;
  }
});
const spawnedChildPid = Number(await readFile(spawnerPidFile, 'utf8'));
spawnerCancelController.abort(new Error('manual stop spawner agent'));
const spawnerCancelledRun = await spawnerRunPromise;
assert(spawnerCancelledRun.status === 'cancelled', '带孙进程的子代理应被取消');
await waitUntil(() => !isPidAlive(spawnedChildPid), 5000);
assert(spawnerCancelDeps.registry.list().every((task) => task.cleanedUp), '带孙进程的子代理进程树应清理');

const runMany = await handleSubagentRunMany({
  conflict_policy: 'allow_readonly_parallel',
  tasks: [
    { agent_type: 'mock', cwd: tmp, task: { title: '同步批量 A', goal: '返回结果' } },
    { agent_type: 'mock', cwd: tmp, task: { title: '同步批量 B', goal: '返回结果' } }
  ]
}, deps);
assert(runMany.status === 'completed' && runMany.completed.length === 2, 'subagent_run_many 应等待两个任务全部完成');
assert(!('pending_task_ids' in runMany), 'subagent_run_many 不应再返回 pending_task_ids');
assert(runMany.completed.every((item) => item.task_id), 'run_many 每个结果应有 task_id');
assert(runMany.completed.every((item) => deps.registry.get(item.task_id)?.cleanedUp === true), 'run_many 完成后所有子代理进程应清理');

const reviseMany = await handleSubagentReviseMany({
  conflict_policy: 'allow_readonly_parallel',
  revisions: runMany.completed.map((item) => ({
    task_id: item.task_id,
    correction: { reason: '主代理要求统一补充一句说明。', expected_change: '补充说明并重新返回完整结果。' }
  }))
}, deps);
assert(reviseMany.status === 'completed' && reviseMany.completed.length === 2, 'subagent_revise_many 应等待两个重写任务全部完成');
assert(reviseMany.completed.every((item) => item.revision_of_task_id), 'revise_many 每个结果应记录 revision_of_task_id');
assert(reviseMany.completed.every((item) => deps.registry.get(item.task_id)?.cleanedUp === true), 'revise_many 完成后所有子代理进程应清理');

const runManyCancelController = new AbortController();
const runManyCancelDeps = { config, concurrency: new ConcurrencyManager(), registry: new TaskRegistry(), requestSignal: runManyCancelController.signal };
const runManySlowPromise = handleSubagentRunMany({
  conflict_policy: 'allow_readonly_parallel',
  tasks: [
    { agent_type: 'mock', cwd: tmp, timeout_secs: 20, task: { title: '同步批量取消 A', goal: '__SLOW__ 模拟长时间运行。' } },
    { agent_type: 'mock', cwd: tmp, timeout_secs: 20, task: { title: '同步批量取消 B', goal: '__SLOW__ 模拟长时间运行。' } }
  ]
}, runManyCancelDeps).catch((error) => error);
await waitUntil(() => runManyCancelDeps.registry.list().length === 2 && runManyCancelDeps.registry.list().every((task) => task.status === 'running'));
runManyCancelController.abort(new Error('manual stop run_many'));
const runManyCancelled = await runManySlowPromise;
assert(runManyCancelled instanceof Error, 'request signal abort 后 subagent_run_many 应停止当前同步调用');
await Promise.allSettled(runManyCancelDeps.registry.list().map((task) => task.currentTurnPromise));
assert(runManyCancelDeps.registry.list().every((task) => task.status === 'cancelled'), '取消 run_many 后所有子代理任务应取消');
assert(runManyCancelDeps.registry.list().every((task) => task.cleanedUp), '取消 run_many 后所有子代理进程应清理');
assert(runManyCancelDeps.concurrency.getActiveTaskCount() === 0, '取消 run_many 后并发锁应释放');

console.log('smoke ok');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitUntil(predicate, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('等待条件超时');
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

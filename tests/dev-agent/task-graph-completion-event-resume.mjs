import assert from 'node:assert/strict';
import { IframeWorkerPool } from '../../js/userscript/dev/frame-mesh/iframe-worker-pool.js';
import { startParentDevWorkerRuntime } from '../../js/userscript/dev/parent-worker-runtime.js';
import { DevSupervisorV0 } from '../../js/ai/dev/supervisor/dev-supervisor-v0.js';
import { DevRunEventHost } from '../../js/ai/dev/events/dev-events.js';
import { DEV_RUN_STATUS } from '../../js/ai/dev/run/dev-run.js';

const NOW = '2026-08-26T10:30:00.000Z';
const RUN = 'run-graph-current';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function cryptoSequence() {
  let value = 1;
  return {
    getRandomValues(bytes) {
      bytes.fill(0);
      bytes[bytes.length - 1] = value++ & 0xff;
      return bytes;
    },
  };
}

function fakeClient() {
  const turns = [];
  return {
    turns,
    async claim({ runId, workerId }) { return { runId, workerId, claimed: true }; },
    async createChat({ runId, workerId }) { return { runId, workerId, created: true }; },
    send({ runId, workerId, instruction }) {
      const turn = { runId, workerId, instruction, deferred: deferred() };
      turns.push(turn);
      return turn.deferred.promise;
    },
    async release() { return { released: true }; },
    result() { return { status: 'available' }; },
    async stop() { return { stopped: true }; },
  };
}

function addReadySlot(pool, index) {
  const client = fakeClient();
  pool.slots.set(index, {
    index,
    href: 'https://chatgpt.com/',
    handle: null,
    runtime: null,
    runtimeDocument: null,
    client,
    ready: true,
    claimed: false,
    reserving: false,
    leaseId: null,
    workerId: null,
    runId: null,
    taskId: null,
    pending: null,
    lastResult: null,
    error: null,
    createdAt: `slot-${index}`,
  });
  return client;
}

function fakeController() {
  return {
    adapter: { document: null, location: { href: 'https://chatgpt.com/', origin: 'https://chatgpt.com' } },
    on() { return () => {}; },
    currentConversation() { return { id: 'supervisor-conversation' }; },
    observe() { return { state: 'available' }; },
    currentUserAnchors() { return []; },
    isActive() { return false; },
  };
}

function noOpPageInspector() { return { snapshot() {}, scripts() {}, scriptSource() {} }; }
function noOpSkillRegistry() { return { list() { return []; }, describe() {}, installCandidate() {}, validateCandidate() {}, activate() {}, rollback() {}, run() {} }; }

async function runtimeWithSlots(count = 3) {
  const pool = new IframeWorkerPool({ maxWorkers: count, cryptoRef: cryptoSequence(), now: () => NOW });
  const clients = [];
  for (let index = 1; index <= count; index += 1) clients.push(addReadySlot(pool, index));
  const runtime = await startParentDevWorkerRuntime({
    controller: fakeController(),
    workerPool: pool,
    pageInspector: noOpPageInspector(),
    skillRegistry: noOpSkillRegistry(),
    now: () => NOW,
    taskGraphPollMs: 1,
  });
  assert.equal(runtime.enabled, true);
  return { runtime, pool, clients };
}

function supervisorClient(runtime) {
  return {
    ...runtime,
    graphStart: (args) => runtime.taskGraphStart(args),
    graphStatus: (args) => runtime.taskGraphStatus(args),
    graphTaskResult: (args) => runtime.taskGraphTaskResult(args),
    graphCancel: (args) => runtime.taskGraphCancel(args),
  };
}

function activeRun(supervisor, runId = RUN) {
  return supervisor.activate(supervisor.createRun({ goal: 'graph completion resume regression', runId }));
}

async function startGraph(supervisor, run, graphId, taskIds) {
  return supervisor.executeToolDecision(run, {
    type: 'tool',
    tool: 'worker.graph.start',
    arguments: {
      graphId,
      maxConcurrency: taskIds.length,
      tasks: taskIds.map((id) => ({ id, dependencies: [], instruction: `do ${id}`, maxAttempts: 1 })),
    },
    purpose: 'run graph workers',
  });
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('Timed out waiting for test condition.');
}

async function withTimeout(promise, timeoutMs = 500) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('test-timeout')), timeoutMs)),
  ]);
}

async function testGraphCompletionResumesWaitingSupervisor() {
  const { runtime, clients } = await runtimeWithSlots(3);
  try {
    const supervisor = new DevSupervisorV0({ workerClient: supervisorClient(runtime), idFactory: (kind) => `${kind}-graph`, now: () => NOW });
    let run = activeRun(supervisor);
    const started = await startGraph(supervisor, run, 'graph-three', ['a', 'b', 'c']);
    run = started.run;
    await waitFor(() => clients.every((client) => client.turns.length === 1));

    const eventHost = new DevRunEventHost({ supervisor });
    const waiting = eventHost.waitForWorkerDecision(run, {
      type: 'wait', events: ['worker.completed'], reason: 'wait for graph worker completion',
    });
    clients[1].turns[0].deferred.resolve({ status: 'completed', responseText: 'B complete' });
    const resumed = await withTimeout(waiting);
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.run.runId, RUN);
    assert.equal(resumed.run.status, DEV_RUN_STATUS.ACTIVE);
    assert.equal(resumed.event.type, 'worker.completed');
    assert.equal(resumed.event.data.runId, RUN);
    assert.equal(resumed.event.data.graphId, 'graph-three');
    assert.equal(resumed.event.data.taskId, 'b');
    assert.equal(runtime.taskGraphTaskResult({ graphId: 'graph-three', taskId: 'b' }).state, 'SUCCEEDED', 'completion wake must not race ahead of the graph task terminal state');
  } finally { runtime.close(); }
}

async function testGraphCompletionSurvivesAutoReleaseAndQueueEviction() {
  const { runtime, pool, clients } = await runtimeWithSlots(1);
  try {
    const supervisor = new DevSupervisorV0({ workerClient: supervisorClient(runtime), idFactory: (kind) => `${kind}-graph`, now: () => NOW });
    let run = activeRun(supervisor, 'run-retained-graph');
    const started = await startGraph(supervisor, run, 'graph-retained', ['retained']);
    run = started.run;
    await waitFor(() => clients[0].turns.length === 1);
    clients[0].turns[0].deferred.resolve({ status: 'completed', responseText: 'retained complete' });
    await waitFor(() => runtime.taskGraphStatus({ graphId: 'graph-retained' }).state === 'SUCCEEDED');
    assert.equal(pool.status().claimedCount, 0, 'graph must auto-release the completed Worker lease before the wait');

    for (let index = 0; index < 129; index += 1) {
      runtime.coordinator.enqueue(Object.freeze({
        type: 'worker.progress',
        data: Object.freeze({ runId: 'run-retained-graph', index }),
        observedAt: NOW,
      }));
    }
    const eventHost = new DevRunEventHost({ supervisor });
    const resumed = await withTimeout(eventHost.waitForWorkerDecision(run, {
      type: 'wait', events: ['worker.completed'], reason: 'wait after graph cleanup',
    }));
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.event.data.runId, 'run-retained-graph');
    assert.equal(resumed.event.data.graphId, 'graph-retained');
    assert.equal(resumed.event.data.taskId, 'retained');
  } finally { runtime.close(); }
}

async function testSupervisorOwnsGraphRunIdentity() {
  const { runtime } = await runtimeWithSlots(1);
  try {
    const supervisor = new DevSupervisorV0({ workerClient: supervisorClient(runtime), idFactory: (kind) => `${kind}-graph`, now: () => NOW });
    const run = activeRun(supervisor, 'run-authoritative');
    await assert.rejects(
      () => supervisor.executeToolDecision(run, {
        type: 'tool',
        tool: 'worker.graph.start',
        arguments: {
          runId: 'run-forged',
          graphId: 'graph-forged',
          tasks: [{ id: 'forged', dependencies: [], instruction: 'should not start', maxAttempts: 1 }],
        },
        purpose: 'attempt to override graph run identity',
      }),
      /may not override runtime-owned runId/,
    );
  } finally { runtime.close(); }
}

await testSupervisorOwnsGraphRunIdentity();
await testGraphCompletionResumesWaitingSupervisor();
await testGraphCompletionSurvivesAutoReleaseAndQueueEviction();
console.log('task graph completion event resume regression: ok');

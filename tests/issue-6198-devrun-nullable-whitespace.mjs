import assert from 'node:assert/strict';
import test from 'node:test';
import { createDevRun, bindDevRunIdentity } from '../js/ai/dev/run/dev-run.js';
import { DevSupervisorV0 } from '../js/ai/dev/supervisor/dev-supervisor-v0.js';
import { DEV_WORKER_TOOL } from '../js/ai/dev/workers/tool-surface.js';

const base = { runId: 'run-1', supervisorSessionKey: 'session-1', goal: 'test' };

test('issue #6198 - whitespace workerId canonicalizes to null', () => {
  const run = createDevRun({ ...base, status: 'ACTIVE', workerId: '   ' });
  assert.equal(run.workerId, null);
});

test('issue #6198 - whitespace identities canonicalize to null via bind', () => {
  const run = createDevRun(base);
  const rebound = bindDevRunIdentity(run, { workerId: '   ' });
  assert.equal(rebound.workerId, null);
});

test('issue #6198 - all nullable identity fields treat whitespace as null', () => {
  const run = createDevRun({
    ...base,
    taskId: '   ',
    workerId: '\t\n ',
    tabNodeId: '  ',
    hexConversationId: ' ',
    chatgptConversationId: '   ',
  });
  assert.equal(run.taskId, null);
  assert.equal(run.workerId, null);
  assert.equal(run.tabNodeId, null);
  assert.equal(run.hexConversationId, null);
  assert.equal(run.chatgptConversationId, null);
});

test('issue #6198 - padded valid ID is trimmed', () => {
  const run = createDevRun({ ...base, workerId: ' worker-1 ' });
  assert.equal(run.workerId, 'worker-1');
});

test('issue #6198 - blank workerId does not block fallback (falsy check)', () => {
  const run = createDevRun({ ...base, status: 'ACTIVE', workerId: '   ' });
  assert.ok(!run.workerId, 'blank workerId must be falsy so idFactory fallback triggers');
});

test('issue #6198 - worker execution invokes the idFactory fallback', async () => {
  const calls = [];
  const supervisor = new DevSupervisorV0({
    idFactory: (kind) => `${kind}-generated`,
    workerTools: {
      toolNames: [DEV_WORKER_TOOL.SEND],
      has: (name) => name === DEV_WORKER_TOOL.SEND,
      execute: async (name, args) => {
        calls.push({ name, args });
        return {};
      },
    },
  });
  const run = createDevRun({ ...base, status: 'ACTIVE', workerId: '   ' });
  const executed = await supervisor.executeToolDecision(run, {
    type: 'tool',
    tool: DEV_WORKER_TOOL.SEND,
    arguments: { instruction: 'ping' },
    purpose: 'exercise worker identity fallback',
  });
  assert.equal(executed.run.workerId, 'worker-generated');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.workerId, 'worker-generated');
});

test('issue #6198 - required IDs keep trim semantics', () => {
  const run = createDevRun({ runId: '  run-1  ', supervisorSessionKey: '  session-1  ', goal: 'test' });
  assert.equal(run.runId, 'run-1');
  assert.equal(run.supervisorSessionKey, 'session-1');
});

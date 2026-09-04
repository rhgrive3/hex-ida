import assert from 'node:assert/strict';
import test from 'node:test';
import { createDevRun, bindDevRunIdentity } from '../js/ai/dev/run/dev-run.js';

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

test('issue #6198 - required IDs keep trim semantics', () => {
  const run = createDevRun({ runId: '  run-1  ', supervisorSessionKey: '  session-1  ', goal: 'test' });
  assert.equal(run.runId, 'run-1');
  assert.equal(run.supervisorSessionKey, 'session-1');
});

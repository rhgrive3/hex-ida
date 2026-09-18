import assert from 'node:assert/strict';
import test from 'node:test';

import { DebugSessionManager } from '../../../js/runtime/session.js';
import { bindDevRunIdentity, createDevRun } from '../../../js/ai/dev/run/dev-run.js';
import { DevSupervisorV0 } from '../../../js/ai/dev/supervisor/dev-supervisor-v0.js';
import { DEV_WORKER_TOOL } from '../../../js/ai/dev/workers/tool-surface.js';

function adapter(name) {
  return { kind: `stub-${name}`, capabilities: {}, disconnect() {} };
}

test('P10 #5959 canonicalizes explicit session IDs through manager identity operations', async () => {
  const manager = new DebugSessionManager({ maxSessions: 4 });
  const padded = manager.create(adapter('padded'), { id: ' session-5959 ' });

  assert.equal(padded.id, 'session-5959');
  assert.equal(manager.get('session-5959'), padded);
  assert.equal(manager.get(' session-5959\t'), padded);
  assert.equal(manager.get('   '), null, 'blank lookup must not address a session');
  assert.equal(manager.get(null), null, 'null lookup must remain a miss');

  manager.switch(' session-5959 ');
  assert.equal(manager.current, padded);
  assert.throws(
    () => manager.create(adapter('duplicate'), { id: 'session-5959' }),
    (error) => error?.code === 'duplicate-session-id',
    'whitespace-only differences must not create a second live session',
  );
  assert.throws(
    () => manager.create(adapter('blank'), { id: ' \t\n ' }),
    (error) => error?.code === 'session-id',
    'whitespace-only explicit IDs remain invalid',
  );

  assert.equal(await manager.close(' session-5959 '), true);
  assert.equal(manager.get('session-5959'), null);
  assert.equal(manager.current, null);

  const plain = manager.create(adapter('plain'), { id: 'plain-5959' });
  assert.equal(plain.id, 'plain-5959', 'ordinary explicit IDs retain existing behavior');
  await manager.close(plain.id);
});

test('P10 #5933 reserves manager-scoped automatic IDs around explicit IDs', async () => {
  const manager = new DebugSessionManager({ maxSessions: 6 });
  const seed = manager.create(adapter('seed'));
  const seedNumber = Number(seed.id.slice('debug:'.length));
  assert.ok(Number.isSafeInteger(seedNumber));

  const firstOccupied = manager.create(adapter('explicit-one'), { id: ` debug:${seedNumber + 1} ` });
  const secondOccupied = manager.create(adapter('explicit-two'), { id: `debug:${seedNumber + 2}` });
  const automatic = manager.create(adapter('automatic'));

  assert.equal(firstOccupied.id, `debug:${seedNumber + 1}`);
  assert.equal(secondOccupied.id, `debug:${seedNumber + 2}`);
  assert.equal(automatic.id, `debug:${seedNumber + 3}`, 'the automatic allocator must skip every live explicit ID');
  assert.equal(manager.get(firstOccupied.id), firstOccupied, 'skipping must never overwrite the first explicit session');
  assert.equal(manager.get(secondOccupied.id), secondOccupied, 'skipping must never overwrite the second explicit session');
  assert.equal(manager.sessions.size, 4, 'free manager capacity must allow the automatic create');

  assert.throws(
    () => manager.create(adapter('duplicate-auto'), { id: ` ${automatic.id} ` }),
    (error) => error?.code === 'duplicate-session-id',
    'a real explicit duplicate remains an error',
  );

  const limited = new DebugSessionManager({ maxSessions: 1 });
  limited.create(adapter('limited'), { id: 'limited' });
  assert.throws(
    () => limited.create(adapter('over-limit'), { id: 'available' }),
    (error) => error?.code === 'session-limit',
    'the existing manager capacity limit remains authoritative',
  );

  await manager.close(automatic.id);
  const afterClose = manager.create(adapter('after-close'));
  assert.notEqual(afterClose.id, automatic.id, 'automatic IDs are monotonic and are not reused after close');

  await Promise.all([...manager.sessions.keys()].map((id) => manager.close(id)));
  await limited.close('limited');
});

const devRunBase = { runId: 'run-6198', supervisorSessionKey: 'session-6198', goal: 'test' };

test('P10 #6198 canonicalizes whitespace nullable identities at creation', () => {
  const run = createDevRun({ ...devRunBase, status: 'ACTIVE', workerId: '   ' });
  assert.equal(run.workerId, null);
});

test('P10 #6198 canonicalizes whitespace nullable identities through bind', () => {
  const run = createDevRun(devRunBase);
  const rebound = bindDevRunIdentity(run, { workerId: '   ' });
  assert.equal(rebound.workerId, null);
});

test('P10 #6198 applies whitespace-null semantics to every nullable identity field', () => {
  const run = createDevRun({
    ...devRunBase,
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

test('P10 #6198 trims valid nullable identities without changing their value', () => {
  const run = createDevRun({ ...devRunBase, workerId: ' worker-1 ' });
  assert.equal(run.workerId, 'worker-1');
});

test('P10 #6198 makes a blank worker ID falsy for runtime fallback', () => {
  const run = createDevRun({ ...devRunBase, status: 'ACTIVE', workerId: '   ' });
  assert.ok(!run.workerId);
});

test('P10 #6198 invokes the worker ID factory after blank-ID normalization', async () => {
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
  const run = createDevRun({ ...devRunBase, status: 'ACTIVE', workerId: '   ' });
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

test('P10 #6198 retains trim semantics for required IDs', () => {
  const run = createDevRun({ runId: '  run-1  ', supervisorSessionKey: '  session-1  ', goal: 'test' });
  assert.equal(run.runId, 'run-1');
  assert.equal(run.supervisorSessionKey, 'session-1');
});

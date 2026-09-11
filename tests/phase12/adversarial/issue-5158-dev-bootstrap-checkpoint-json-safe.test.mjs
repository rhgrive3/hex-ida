import assert from 'node:assert/strict';
import {
  DEV_BOOTSTRAP_EXTENSION_VERSION,
  createDevBootstrapCheckpoint,
  createDevBootstrapHandoff,
} from '../../../js/ai/dev/bootstrap/dev-bootstrap-gate.js';

const base = Object.freeze({
  runId: 'run-5158',
  goal: 'resume bootstrap',
  decisionPolicy: 'normal',
  supervisorSessionKey: 'session-5158',
  chatgptConversationId: 'chat-5158',
  expectedCommit: 'a'.repeat(40),
  expectedBuildId: 'b'.repeat(24),
  expectedExtensionVersion: DEV_BOOTSTRAP_EXTENSION_VERSION,
});

function checkpointWith(pendingTask) {
  return createDevBootstrapCheckpoint({ ...base, pendingTask });
}

const cases = [];
function test(name, fn) {
  try {
    fn();
    cases.push({ name, ok: true });
  } catch (error) {
    cases.push({ name, ok: false, error });
  }
}

function mustRejectJsonUnsafe(pendingTask) {
  assert.throws(
    () => checkpointWith(pendingTask),
    (error) => error instanceof TypeError && /pendingTask must be JSON-safe/.test(error.message),
  );
}

test('production task round-trips without mutation', () => {
  const pendingTask = {
    type: 'round4-bootstrap',
    step: 'resume-proof',
    hexConversationId: 'hex-5158',
    details: { attempt: 2, flags: [true, false, null] },
  };
  const checkpoint = checkpointWith(pendingTask);
  assert.deepEqual(checkpoint.pendingTask, pendingTask);
  assert.notEqual(checkpoint.pendingTask, pendingTask);
  assert.notEqual(checkpoint.pendingTask.details, pendingTask.details);
  const handoff = createDevBootstrapHandoff(checkpoint);
  assert.deepEqual(handoff.checkpoint.pendingTask, pendingTask);
});

test('nested undefined is rejected instead of dropped', () => {
  mustRejectJsonUnsafe({ type: 'round4-bootstrap', hexConversationId: undefined });
});

test('array undefined is rejected instead of normalized to null', () => {
  mustRejectJsonUnsafe({ values: ['ok', undefined] });
});

test('non-finite numbers are rejected instead of normalized to null', () => {
  for (const value of [NaN, Infinity, -Infinity]) mustRejectJsonUnsafe({ value });
});

test('function Symbol and BigInt are rejected', () => {
  mustRejectJsonUnsafe({ value: () => 1 });
  mustRejectJsonUnsafe({ value: Symbol('x') });
  mustRejectJsonUnsafe({ value: 1n });
});

test('cyclic data is rejected', () => {
  const pendingTask = { type: 'round4-bootstrap' };
  pendingTask.self = pendingTask;
  mustRejectJsonUnsafe(pendingTask);
});

test('custom toJSON is rejected and never invoked', () => {
  let calls = 0;
  const pendingTask = {
    type: 'round4-bootstrap',
    toJSON() {
      calls += 1;
      return { type: 'changed' };
    },
  };
  mustRejectJsonUnsafe(pendingTask);
  assert.equal(calls, 0, 'JSON-safety validation must not execute caller serialization hooks');
});

test('custom prototypes are rejected', () => {
  const proto = { inherited: 'authority' };
  const pendingTask = Object.assign(Object.create(proto), { type: 'round4-bootstrap' });
  mustRejectJsonUnsafe(pendingTask);
});

test('sparse arrays are rejected instead of silently materializing holes', () => {
  const values = [];
  values.length = 2;
  values[1] = 'present';
  mustRejectJsonUnsafe({ values });
});

test('accessor properties are rejected without executing getters', () => {
  let calls = 0;
  const pendingTask = { type: 'round4-bootstrap' };
  Object.defineProperty(pendingTask, 'secret', {
    enumerable: true,
    get() {
      calls += 1;
      return 'value';
    },
  });
  mustRejectJsonUnsafe(pendingTask);
  assert.equal(calls, 0, 'JSON-safety validation must not execute caller accessors');
});

const failures = cases.filter((item) => !item.ok);
for (const item of cases) {
  console.log(`issue-5158 ${item.ok ? 'PASS' : 'FAIL'}: ${item.name}${item.ok ? '' : ` :: ${item.error?.message || item.error}`}`);
}
if (failures.length) {
  throw new AggregateError(failures.map((item) => item.error), `issue-5158: ${failures.length}/${cases.length} regression cases failed`);
}
console.log(`issue-5158-dev-bootstrap-checkpoint-json-safe: ${cases.length}/${cases.length} PASS`);

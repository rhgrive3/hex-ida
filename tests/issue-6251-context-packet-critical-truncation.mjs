/* Regression test for #6251: correctness-critical ContextPacket fields must fail
   closed on oversize input instead of silently truncating at 4096 chars. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDevContextPacket } from '../js/ai/dev/protocol/context-packet.js';
import { selectDevContext } from '../js/ai/dev/protocol/context-selection.js';

const TAIL = ' NEVER_DELETE_USER_DATA';

test('issue-6251: forbiddenActions at exactly 4096 chars is preserved fully', () => {
  const value = 'A'.repeat(4096);
  const packet = createDevContextPacket({ taskId: 't1', objective: 'audit', forbiddenActions: [value] });
  assert.equal(packet.forbiddenActions[0], value);
});

test('issue-6251: oversize forbiddenActions throws instead of silent truncation', () => {
  assert.throws(
    () => createDevContextPacket({
      taskId: 't1',
      objective: 'audit',
      forbiddenActions: ['A'.repeat(4096) + TAIL],
    }),
    TypeError,
  );
});

test('issue-6251: oversize objective throws instead of silent truncation', () => {
  assert.throws(
    () => createDevContextPacket({ taskId: 't1', objective: 'A'.repeat(4096) + ' ONLY_READ_FILES_DO_NOT_EDIT' }),
    TypeError,
  );
});

test('issue-6251: oversize constraints/stopConditions/unknowns/requiredEvidence throw', () => {
  for (const field of ['constraints', 'stopConditions', 'unknowns', 'requiredEvidence', 'successCriteria', 'knownFailures']) {
    assert.throws(
      () => createDevContextPacket({ taskId: 't1', objective: 'audit', [field]: ['B'.repeat(4097)] }),
      TypeError,
      `${field} must fail closed on oversize input`,
    );
  }
});

test('issue-6251: oversize scope and authoritativeFacts.statement throw', () => {
  assert.throws(
    () => createDevContextPacket({ taskId: 't1', objective: 'audit', scope: 'S'.repeat(4097) }),
    TypeError,
  );
  assert.throws(
    () => createDevContextPacket({
      taskId: 't1',
      objective: 'audit',
      authoritativeFacts: [{ statement: 'F'.repeat(4097) }],
    }),
    TypeError,
  );
});

test('issue-6251: bounded presentation fields keep truncating (excerpt)', () => {
  const packet = createDevContextPacket({
    taskId: 't1',
    objective: 'audit',
    artifactRefs: [{ ref: 'reports/x.json', excerpt: 'E'.repeat(5000) }],
  });
  assert.equal(packet.artifactRefs[0].excerpt.length, 4096);
});

test('issue-6251: max-size critical context still selects without a blocker', () => {
  const packet = createDevContextPacket({
    taskId: 't1',
    objective: 'audit',
    forbiddenActions: ['A'.repeat(4096)],
    constraints: ['C'.repeat(100)],
  });
  const selection = selectDevContext({ packet, budgetBytes: null });
  assert.equal(selection.blocker, null);
  assert.equal(selection.packet.forbiddenActions[0].length, 4096);
});

test('issue-6251: oversized critical context never becomes a valid packet', () => {
  let packet = null;
  try {
    packet = createDevContextPacket({
      taskId: 't1',
      objective: 'audit',
      forbiddenActions: ['A'.repeat(4096) + TAIL],
    });
  } catch {
    packet = null;
  }
  assert.equal(packet, null, 'oversize critical context must not yield a schema-valid packet');
});

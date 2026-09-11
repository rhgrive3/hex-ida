/**
 * #4442 regression: ChangeLog canonical operation ordering must be
 * locale-independent. Previously `localeCompare()` made replay digests
 * depend on the runtime locale (e.g. 'ä' vs 'z' orders differently in
 * en-US and sv-SE collations).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ChangeLog, createProjectOperation, orderOperations } from '../js/collaboration/index.js';

const mk = (id, payload) => createProjectOperation({
  projectIdentity: 'p',
  operationId: id,
  targetEntityId: 'e',
  factKind: 'name',
  action: 'set',
  payload,
});

const CODE_UNIT_ORDER = ['z', 'ä']; // 'z' (U+007A) < 'ä' (U+00E4) by code unit

test('#4442 orderOperations uses locale-independent code-unit order', () => {
  const { ordered } = orderOperations([mk('ä', 'A'), mk('z', 'B')]);
  assert.deepEqual(ordered.map((op) => op.operationId), CODE_UNIT_ORDER);
});

test('#4442 replay converges regardless of arrival order', () => {
  const left = new ChangeLog({ projectIdentity: 'p' });
  left.applyOperation(mk('ä', 'A'));
  left.applyOperation(mk('z', 'B'));

  const right = new ChangeLog({ projectIdentity: 'p' });
  right.applyOperation(mk('z', 'B'));
  right.applyOperation(mk('ä', 'A'));

  assert.deepEqual(
    left.snapshot().facts['e\x00name'].values.map((v) => v.operationId),
    CODE_UNIT_ORDER,
  );
  assert.deepEqual(
    right.snapshot().facts['e\x00name'].values.map((v) => v.operationId),
    CODE_UNIT_ORDER,
  );
  assert.equal(left.digest(), right.digest());
});

test('#4442 ordering is immune to localeCompare behavior', () => {
  // Simulate a locale whose collation disagrees with code-unit order
  // (sv-SE sorts 'ä' after 'z', opposite of en-US for this pair).
  const original = String.prototype.localeCompare;
  let calls = 0;
  String.prototype.localeCompare = function () { calls++; return 1; };
  try {
    const { ordered } = orderOperations([mk('ä', 'A'), mk('z', 'B')]);
    assert.deepEqual(ordered.map((op) => op.operationId), CODE_UNIT_ORDER);
  } finally {
    String.prototype.localeCompare = original;
  }
  assert.ok(calls === 0, `canonical ordering must not call localeCompare (called ${calls}x)`);
});

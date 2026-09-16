import assert from 'node:assert/strict';
import test from 'node:test';
import { AI_QUOTA, acquireQuotaState, normalizeQuotaSessionId } from '../js/ai/quota.js';

test('issue #5775: sessions with identical 128-character prefixes do not collide in quota', () => {
  const prefix = 'session-prefix-'.repeat(10); // > 128 chars or exact
  const idA = prefix.slice(0, 128) + 'A';
  const idB = prefix.slice(0, 128) + 'B';

  // Distinct IDs must have distinct normalized keys
  assert.notEqual(
    normalizeQuotaSessionId(idA),
    normalizeQuotaSessionId(idB),
    'session IDs differing after 128 chars must not normalize to the same quota key',
  );

  let state = null;
  const now = 1_000_000;

  // Exhaust sessionConcurrencyLimit for session A
  for (let i = 0; i < AI_QUOTA.sessionConcurrencyLimit; i++) {
    const res = acquireQuotaState(state, { now, token: `token-a-${i}`, sessionId: idA });
    assert.equal(res.result.allowed, true);
    state = res.state;
  }

  // Session A is at concurrency limit
  const deniedA = acquireQuotaState(state, { now, token: 'token-a-overflow', sessionId: idA });
  assert.equal(deniedA.result.allowed, false);
  assert.equal(deniedA.result.reason, 'concurrency');

  // Session B should still be allowed since ipConcurrencyLimit (4) > sessionConcurrencyLimit (2)
  const allowedB = acquireQuotaState(state, { now, token: 'token-b-0', sessionId: idB });
  assert.equal(allowedB.result.allowed, true, 'session B must not be blocked by session A concurrency exhaustion');
});

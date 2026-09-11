// Regression for #5429: quota rate/concurrency/lease authorities adopt only
// primitive finite numbers. Numeric strings, arrays, booleans, and objects
// never become the enforcement value, and structured persisted state is
// corrupt state (fresh counters), not laundered canonical state.
import assert from 'node:assert/strict';
import { acquireQuotaState, normalizeQuotaState, AI_QUOTA } from '../js/ai/quota.js';

// 1. Forged structured config falls back to the AI_QUOTA defaults.
{
  const { result, state } = acquireQuotaState(null, {
    now: 1000, sessionId: 's1', token: 'lease-1',
  }, {
    windowMs: ['60000'], ipRateLimit: ['1'], sessionRateLimit: ['1'],
    ipConcurrencyLimit: ['1'], sessionConcurrencyLimit: ['1'], leaseMs: ['500'],
  });
  assert.equal(result.allowed, true);
  assert.equal(result.remaining, AI_QUOTA.ipRateLimit - 1, 'the forged rate limit must not become the authority');
  assert.equal(state.leases['lease-1'].expiresAt, 1000 + AI_QUOTA.leaseMs, 'the forged lease duration must not become the authority');
}

// 2. Boolean/string config values are likewise never adopted.
{
  const { result } = acquireQuotaState(null, { now: 1000, sessionId: 's1', token: 't2' }, { ipRateLimit: true, sessionRateLimit: '0', ipConcurrencyLimit: true });
  assert.equal(result.allowed, true, 'non-number config must fall back, not coerce (Number(true)===1 would deny)');
}

// 3. Structured persisted state is corrupt: counters start fresh, structured
// leases never survive, and the canonical output is fully numeric.
{
  const restored = normalizeQuotaState({
    windowStarted: ['1000'],
    count: ['29'],
    sessions: { s1: { windowStarted: ['1000'], count: ['29'] } },
    leases: { lease1: { sessionId: 's1', expiresAt: ['121000'] } },
  }, 1000);
  assert.equal(restored.count, 0, 'a structured persisted count must not launder into the canonical state');
  assert.deepEqual(restored.sessions.s1, { windowStarted: 1000, count: 0 });
  assert.deepEqual(restored.leases, {}, 'structured lease expiry must not survive');
  assert.equal(Number.isFinite(restored.windowStarted), true);
}

// 4. Genuine primitive persisted state round-trips unchanged.
{
  const restored = normalizeQuotaState({
    windowStarted: 1000,
    count: 29,
    sessions: { s1: { windowStarted: 1000, count: 7 } },
    leases: { lease1: { sessionId: 's1', expiresAt: 121000 } },
  }, 1000);
  assert.equal(restored.count, 29);
  assert.deepEqual(restored.sessions.s1, { windowStarted: 1000, count: 7 });
  assert.equal(restored.leases.lease1.expiresAt, 121000);
}

// 5. Primitive valid config keeps its exact semantics.
{
  const config = { ipRateLimit: 1, sessionRateLimit: 1 };
  const first = acquireQuotaState(null, { now: 1000, sessionId: 's1', token: 't3' }, config);
  assert.equal(first.result.allowed, true);
  assert.equal(first.result.remaining, 0, 'a valid primitive 1-rate limit is still the authority');
  const second = acquireQuotaState(first.state, { now: 1000, sessionId: 's2', token: 't4' }, config);
  assert.equal(second.result.allowed, false, 'the primitive limit still enforces');
}

console.log('issue #5429 quota numeric authority regressions PASS');

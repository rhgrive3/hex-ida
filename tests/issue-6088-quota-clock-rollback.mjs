import assert from 'node:assert/strict';
import { AI_QUOTA, acquireQuotaState, normalizeQuotaState } from '../js/ai/quota.js';

const saturated = {
  windowStarted: 10_000,
  count: AI_QUOTA.ipRateLimit,
  sessions: { s: { windowStarted: 10_000, count: AI_QUOTA.sessionRateLimit } },
  leases: { old: { sessionId: 's', expiresAt: 120_000 } },
};
const rolled = acquireQuotaState(saturated, { now: 0, sessionId: 's', token: 'new' }, AI_QUOTA);
assert.equal(rolled.result.allowed, false);
assert.equal(rolled.result.reason, 'rate');
assert.equal(rolled.state.windowStarted, 10_000);
assert.equal(rolled.state.count, AI_QUOTA.ipRateLimit);
assert.ok(rolled.state.leases.old);
assert.ok(rolled.state.leases.old.expiresAt <= AI_QUOTA.leaseMs);
assert.equal(rolled.result.retryAfterMs, 60_000);

const expired = acquireQuotaState(
  { windowStarted: 0, count: AI_QUOTA.ipRateLimit, sessions: {}, leases: {} },
  { now: AI_QUOTA.windowMs + 1, sessionId: 's', token: 'fresh' }, AI_QUOTA,
);
assert.equal(expired.result.allowed, true);

const capped = normalizeQuotaState(
  { windowStarted: 10_000, count: 0, sessions: {}, leases: { a: { sessionId: 's', expiresAt: 130_000 } } },
  0, AI_QUOTA,
);
assert.equal(capped.leases.a.expiresAt, 120_000);

const fwd = normalizeQuotaState(
  { windowStarted: 0, count: 5, sessions: {}, leases: { a: { sessionId: 's', expiresAt: 5_000 } } },
  6_000, AI_QUOTA,
);
assert.deepEqual(fwd.leases, {});
console.log('issue #6088 quota clock-rollback regressions PASS');

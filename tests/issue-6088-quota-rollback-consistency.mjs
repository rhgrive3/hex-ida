// Regression for #6088: a wall-clock rollback reset the rate window (re-granting
// exhausted rate budget) while leaving concurrency leases at their absolute
// expiry (extending their real lifetime by the rollback width) — opposite time
// semantics for the two halves of the same quota state. A rollback now applies
// one consistent policy: consumed rate budget stays consumed, session counters
// stay consumed, and lease lifetimes are rebased by the same correction so a
// rollback can neither re-grant budget nor extend a lock.
import assert from 'node:assert/strict';
import { acquireQuotaState, releaseQuotaState, AI_QUOTA } from '../js/ai/quota.js';

const exhausted = {
  windowStarted: 10_000,
  count: AI_QUOTA.ipRateLimit,
  sessions: { s: { windowStarted: 10_000, count: AI_QUOTA.sessionRateLimit } },
  leases: { old: { sessionId: 's', expiresAt: 120_000 } },
};

{
  const { state, result } = acquireQuotaState(exhausted, { now: 0, sessionId: 's', token: 'new' });
  assert.equal(result.allowed, false, 'a rollback must not re-grant exhausted rate budget');
  assert.equal(result.reason, 'rate');
  assert.equal(state.count, AI_QUOTA.ipRateLimit, 'ip rate counters survive the rollback');
  assert.equal(state.sessions.s.count, AI_QUOTA.sessionRateLimit, 'session rate counters survive the rollback');
  assert.equal(state.leases.old.expiresAt, 110_000, 'lease lifetimes rebase by the rollback width instead of extending');
}

{
  // A lease whose remaining lifetime cannot survive the rollback correction
  // (stale persisted state: expiry already below the rollback reference) is
  // dropped instead of being re-armed into the future.
  const { state } = acquireQuotaState({
    windowStarted: 500_000,
    count: 1,
    sessions: {},
    leases: { old: { sessionId: 's', expiresAt: 400_000 } },
  }, { now: 0, sessionId: 's', token: 'new' });
  assert.equal(state.leases.old, undefined, 'a lease whose rebased lifetime has passed is dropped');
}

{
  // Without a rollback, quota semantics are unchanged.
  const { state, result } = acquireQuotaState({
    windowStarted: 10_000,
    count: 1,
    sessions: { s: { windowStarted: 10_000, count: 1 } },
    leases: { old: { sessionId: 's', expiresAt: 120_000 } },
  }, { now: 20_000, sessionId: 's', token: 'new' });
  assert.equal(state.leases.old.expiresAt, 120_000, 'no rollback: leases keep their absolute expiry');
  assert.equal(result.allowed, true, 'no rollback: normal acquisition still works');
  assert.equal(state.count, 2);
}

{
  // A genuine forward window expiry still resets the counters.
  const { state, result } = acquireQuotaState({
    windowStarted: 0,
    count: AI_QUOTA.ipRateLimit,
    sessions: { s: { windowStarted: 0, count: AI_QUOTA.sessionRateLimit } },
    leases: {},
  }, { now: AI_QUOTA.windowMs + 1_000, sessionId: 's', token: 'new' });
  assert.equal(result.allowed, true, 'normal window expiry resets the rate budget');
  assert.equal(state.count, 1);
}

{
  // Release keeps working across a rollback (rebased state stays consistent).
  const base = {
    windowStarted: 10_000,
    count: 1,
    sessions: { s: { windowStarted: 10_000, count: 1 } },
    leases: { old: { sessionId: 's', expiresAt: 120_000 } },
  };
  const released = releaseQuotaState(base, 'old', 0);
  assert.equal(released.released, true, 'release still finds the lease after a rollback');
  assert.equal(released.state.leases.old, undefined);
  assert.equal(released.state.count, 1, 'release does not reset rate counters');
}

// Regression for #5775: normalizeQuotaSessionId() truncated session ids to
// their first 128 characters, so two distinct sessions sharing a long prefix
// aliased into one quota principal and exhausted each other's per-session
// rate/concurrency budget. Long ids now keep a collision-resistant digest of
// the full identity; short ids are unchanged.
import assert from 'node:assert/strict';
import { acquireQuotaState, normalizeQuotaSessionId, AI_QUOTA } from '../js/ai/quota.js';
import { createInvestigationSession } from '../js/ai/session-core/index.js';

const prefix = 'a'.repeat(128);
const idA = prefix + 'A';
const idB = prefix + 'B';

// Session-core keeps both as distinct identities.
assert.notEqual(createInvestigationSession({ id: idA }).id, createInvestigationSession({ id: idB }).id);

// The quota layer must too.
assert.notEqual(normalizeQuotaSessionId(idA), normalizeQuotaSessionId(idB), 'distinct long session ids must not alias');
assert.ok(normalizeQuotaSessionId(idA).length <= 160, 'the quota key stays bounded');
assert.equal(normalizeQuotaSessionId(idA), normalizeQuotaSessionId(idA), 'normalization stays stable');
assert.equal(normalizeQuotaSessionId('short-id'), 'short-id', 'short ids are unchanged');
assert.equal(normalizeQuotaSessionId('  spaced  '), 'spaced', 'trimming is unchanged');

{
  const config = { ...AI_QUOTA, sessionConcurrencyLimit: 1, sessionRateLimit: 100, ipRateLimit: 100, ipConcurrencyLimit: 10 };
  const first = acquireQuotaState(null, { now: 1_000, sessionId: idA, token: 'lease-a' }, config);
  const second = acquireQuotaState(first.state, { now: 1_001, sessionId: idB, token: 'lease-b' }, config);
  assert.equal(first.result.allowed, true);
  assert.equal(second.result.allowed, true, 'distinct long-id sessions must not consume each other\'s concurrency budget');
  assert.notEqual(second.result.reason, 'concurrency');
}

{
  const config = { ...AI_QUOTA, sessionRateLimit: 1, sessionConcurrencyLimit: 10, ipRateLimit: 100, ipConcurrencyLimit: 10 };
  const first = acquireQuotaState(null, { now: 1_000, sessionId: idA, token: 'r1' }, config);
  const second = acquireQuotaState(first.state, { now: 1_001, sessionId: idB, token: 'r2' }, config);
  assert.equal(second.result.allowed, true, 'per-session rate counters stay separate for distinct long ids');
  const sameAgain = acquireQuotaState(second.state, { now: 1_002, sessionId: idA, token: 'r3' }, config);
  assert.equal(sameAgain.result.allowed, false, 'the real same-session rate limit still applies');
}

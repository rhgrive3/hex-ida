import assert from 'node:assert/strict';
import { publishRebuildOutput } from '../js/rebuild/index.js';
import { publishRebuildTransaction } from '../js/rebuild/transaction-v2.js';

const materialized = { status: 'materialized', outputHash: 'bytes:x', bytes: new Uint8Array([1]) };
const validation = { status: 'valid' };

function publishWith(promote) {
  return publishRebuildOutput(materialized, validation, { promote });
}

function assertCoherent(result) {
  if (result.status === 'published') {
    const inner = result.result;
    if (inner && typeof inner === 'object') {
      assert.equal(inner.committed, true, `published contradicts promoter result: ${JSON.stringify(inner)}`);
      assert.notEqual(String(inner.status || '').toLowerCase(), 'rejected');
    }
  }
}

const committed = await publishWith(async () => ({ committed: true }));
assert.equal(committed.status, 'published');
assert.equal(committed.result.committed, true);
assertCoherent(committed);

const uncommitted = await publishWith(async () => ({ committed: false }));
assert.notEqual(uncommitted.status, 'published');
assertCoherent(uncommitted);

const rejected = await publishWith(async () => ({ status: 'rejected', committed: false, reason: 'disk-full' }));
assert.notEqual(rejected.status, 'published');
assertCoherent(rejected);

for (const hollow of [null, undefined, false, {}]) {
  const result = await publishWith(async () => hollow);
  assert.notEqual(result.status, 'published', `must not publish for promoter result ${JSON.stringify(hollow) ?? String(hollow)}`);
  assertCoherent(result);
}

const threw = await publishWith(async () => { throw new Error('promoter-crashed'); });
assert.equal(threw.status, 'rejected');
assert.match(String(threw.detail), /promoter-crashed/);
assertCoherent(threw);

const mismatched = await publishWith(async () => ({ committed: true, outputHash: 'bytes:other' }));
assert.notEqual(mismatched.status, 'published');
assertCoherent(mismatched);

const legacyToken = await publishWith((bytes) => { assert.equal(bytes[0], 1); return 'ok'; });
assert.equal(legacyToken.status, 'published');
assertCoherent(legacyToken);

assert.equal((await publishRebuildOutput(materialized, validation)).status, 'not-published');
assert.equal((await publishRebuildOutput({ status: 'failed' }, validation, { promote: async () => ({ committed: true }) })).status, 'rejected');
assert.equal((await publishRebuildOutput(materialized, { status: 'invalid' }, { promote: async () => ({ committed: true }) })).status, 'rejected');

assert.equal((await publishRebuildTransaction(null, null)).status, 'rejected');
assert.equal((await publishRebuildTransaction(materialized, validation)).status, 'rejected');

console.log('issue-4990 legacy publish promotion commit proof: PASS');

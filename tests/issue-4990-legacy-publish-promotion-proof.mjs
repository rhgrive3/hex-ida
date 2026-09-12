import assert from 'node:assert/strict';
import {
  createRebuildPlan,
  materializeRebuildPlan,
  publishRebuildOutput,
  validateRebuildOutput,
} from '../js/rebuild/index.js';
import { publishRebuildTransaction } from '../js/rebuild/transaction-v2.js';
import { stableDigest } from '../js/core/identity/index.js';

// #4990 requires a positive commit proof from a legacy promote() before the
// publication path reports 'published'. Publication is separately bound (in
// main) to a canonical, untampered validation artifact, so the fixtures below
// build a real canonical validation the same way issue-4516 does; the commit-
// proof assertions are unchanged.
function sourceHash(source) {
  return `bytes:${stableDigest(Array.from(source))}`;
}

async function canonicalFixture() {
  const source = Uint8Array.from([1]);
  const plan = createRebuildPlan({
    binaryId: 'issue-4990-test',
    sourceHash: sourceHash(source),
    loaderVersion: 'issue-4990-test-loader',
    operations: [],
  });
  const materialized = await materializeRebuildPlan(plan, source);
  const validation = await validateRebuildOutput(plan, materialized, {
    original: Uint8Array.from(materialized.bytes),
    loaderReparse: () => ({ ok: true }),
    validators: { evidence: () => ({ ok: true }) },
  });
  return { materialized, validation };
}

async function publishWith(promote) {
  const { materialized, validation } = await canonicalFixture();
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

{
  const { materialized, validation } = await canonicalFixture();
  assert.equal((await publishRebuildOutput(materialized, validation)).status, 'not-published');
  assert.equal((await publishRebuildOutput({ status: 'failed' }, validation, { promote: async () => ({ committed: true }) })).status, 'rejected');
  assert.equal((await publishRebuildOutput(materialized, { status: 'invalid' }, { promote: async () => ({ committed: true }) })).status, 'rejected');
}

assert.equal((await publishRebuildTransaction(null, null)).status, 'rejected');
const { materialized, validation } = await canonicalFixture();
assert.equal((await publishRebuildTransaction(materialized, validation)).status, 'rejected');

console.log('issue-4990 legacy publish promotion commit proof: PASS');

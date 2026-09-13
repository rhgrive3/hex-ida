import assert from 'node:assert/strict';
import { matchFunctions } from '../js/recognition/matcher.js';
import { diffFunctions } from '../js/diff/index.js';

const code = new Uint8Array([0x1f, 0x20, 0x03, 0xd5]);
const fn = (address) => ({ address, architecture:'arm64', bytes:code });

// 1 before : 2 identical after. A selected exact match still carries a
// near-confidence alternative, so aggregate ambiguity must propagate and the
// alternative must never be published as a confidence-1 new.
{
  const before = [fn(0x1000n)];
  const after = [fn(0x2000n), fn(0x3000n)];
  const matched = matchFunctions(before, after, { mode:'full', allowSimilar:true });
  assert.equal(matched.matches.length, 1);
  assert.equal(matched.matches[0].ambiguous, true, 'selected match must be ambiguous');
  assert.equal(matched.truncated, false, 'solver completed without truncation');
  assert.equal(matched.ambiguous, true, 'aggregate must reflect per-match ambiguity');

  const diff = diffFunctions(before, after, { mode:'full', allowSimilar:true });
  assert.equal(diff.ambiguous, true);
  assert.equal(diff.complete, false);
  assert.equal(diff.new.length, 0, 'alternative after must not be a definitive new');
  assert.equal(diff.deleted.length, 0);
  assert.ok(
    diff.unresolved.some((x) => x.side === 'after' && x.after.address === 0x3000n && x.confidence === 0),
    'alternative after must demote to unresolved'
  );
}

// 2 before : 1 identical after. Symmetric defect: the surplus before function
// must not become a definitive deleted claim.
{
  const before = [fn(0x2000n), fn(0x3000n)];
  const after = [fn(0x1000n)];
  const matched = matchFunctions(before, after, { mode:'full', allowSimilar:true });
  assert.equal(matched.matches.length, 1);
  assert.equal(matched.ambiguous, true);

  const diff = diffFunctions(before, after, { mode:'full', allowSimilar:true });
  assert.equal(diff.deleted.length, 0, 'alternative before must not be a definitive deleted');
  assert.ok(
    diff.unresolved.some((x) => x.side === 'before' && x.before.address === 0x3000n && x.confidence === 0)
  );
}

// A unique exact match keeps aggregate and per-match ambiguity false and the
// diff stays complete with no unresolved churn.
{
  const matched = matchFunctions([fn(0x1000n)], [fn(0x2000n)], { mode:'full', allowSimilar:true });
  assert.equal(matched.matches[0].ambiguous, false);
  assert.equal(matched.ambiguous, false);

  const diff = diffFunctions([fn(0x1000n)], [fn(0x2000n)], { mode:'full', allowSimilar:true });
  assert.equal(diff.complete, true);
  assert.equal(diff.ambiguous, false);
  assert.equal(diff.unresolved.length, 0);
}

// Solver truncation retains its existing conservative behaviour.
{
  const base = { address:0n, architecture:'arm64', bytes:Uint8Array.from([1,2,3,4,5,6,7,8]), cfg:{blocks:2,edges:1,exits:1}, strings:['same'], imports:['memcpy'] };
  const before = Array.from({ length:4 }, (_x, i) => ({ ...base, address:0x10000n + BigInt(i * 0x20) }));
  const after = Array.from({ length:4 }, (_x, i) => ({ ...base, address:0x20000n + BigInt(i * 0x20) }));
  const partial = diffFunctions(before, after, {
    maxCandidates:4, maxBucketScan:4,
    matchBudget:{ maxCandidateEvaluations:1, maxCandidateEdges:32, maxWallMs:10_000 },
  });
  assert.equal(partial.truncated, true);
  assert.equal(partial.ambiguous, true);
  assert.equal(partial.complete, false);
  assert.equal(partial.new.length, 0);
  assert.equal(partial.deleted.length, 0);
  assert.equal(partial.unresolved.length, 8);
}

console.log('issue-4831-aggregate-match-ambiguity: PASS');

import test from 'node:test';
import assert from 'node:assert/strict';

import { __investigationInternalsForTests } from '../../js/analysis/investigation-service.js';

const { typedRankedCandidates } = __investigationInternalsForTests;

function context(complete = true) {
  return {
    snapshotId:'snapshot-3672',
    completeness:complete
      ? { complete:true, reasons:[] }
      : { complete:false, reasons:['program-partial'] },
  };
}

function project(candidate, complete = true) {
  return typedRankedCandidates({ candidates:[candidate] }, context(complete));
}

test('#3672 canonical primitive address forms preserve the same function identity', () => {
  for (const address of [0x1000n, 4096, '4096', '0x1000']) {
    const result = project({ addr:address, verdict:'supported', reasons:[{ evidenceId:'ev-1' }] });
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].candidateId, 'snapshot-3672:candidate:1000');
    assert.equal(result.candidates[0].entityId, 'function:1000');
    assert.deepEqual(result.candidates[0].evidenceIds, ['ev-1']);
    assert.equal(result.candidates[0].verdict, 'supported');
    assert.equal(result.candidates[0].completeness, 'complete');
  }
});

test('#3672 malformed addresses remain ordered but cannot mint function identity', () => {
  let coercions = 0;
  const coercible = {
    [Symbol.toPrimitive]() { coercions++; return 4096; },
    valueOf() { coercions++; return 4096; },
    toString() { coercions++; return '4096'; },
  };
  for (const address of [
    [4096],
    ['4096'],
    true,
    false,
    {},
    new Number(4096),
    coercible,
    Number.MAX_SAFE_INTEGER + 1,
    -1,
    -1n,
    '',
    'not-an-address',
  ]) {
    const result = project({ addr:address, reasons:[{ evidenceId:'ev-1' }] });
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].candidateId, 'snapshot-3672:candidate:invalid:0');
    assert.equal(result.candidates[0].entityId, null);
    assert.deepEqual(result.candidates[0].evidenceIds, ['ev-1']);
  }
  assert.equal(coercions, 0);
});

test('#3672 malformed address identity cannot collide with a canonical function at the same index', () => {
  const canonical = project({ addr:0n }).candidates[0];
  const malformed = project({ addr:[0] }).candidates[0];
  assert.equal(canonical.candidateId, 'snapshot-3672:candidate:0');
  assert.equal(canonical.entityId, 'function:0');
  assert.equal(malformed.candidateId, 'snapshot-3672:candidate:invalid:0');
  assert.equal(malformed.entityId, null);
  assert.notEqual(malformed.candidateId, canonical.candidateId);
});

test('#3672 malformed address preserves candidate ordering, verdict, and completeness state', () => {
  const result = typedRankedCandidates({
    total:3,
    candidates:[
      { addr:0x1000n, label:'first', verdict:'supported' },
      { addr:[0x1800], label:'malformed', verdict:'rejected' },
      { addr:0x2000n, label:'third', verdict:'ambiguous' },
    ],
  }, context(false));

  assert.equal(result.total, 3);
  assert.deepEqual(result.candidates.map((candidate) => candidate.label), ['first', 'malformed', 'third']);
  assert.deepEqual(result.candidates.map((candidate) => candidate.candidateId), [
    'snapshot-3672:candidate:1000',
    'snapshot-3672:candidate:invalid:1',
    'snapshot-3672:candidate:2000',
  ]);
  assert.deepEqual(result.candidates.map((candidate) => candidate.entityId), [
    'function:1000',
    null,
    'function:2000',
  ]);
  assert.deepEqual(result.candidates.map((candidate) => candidate.verdict), ['supported', 'rejected', 'ambiguous']);
  for (const candidate of result.candidates) {
    assert.equal(candidate.completeness, 'partial');
    assert.deepEqual(candidate.missing, ['program-partial']);
  }
});

test('#3672 evidence identity accepts only non-empty primitive strings without coercion', () => {
  let coercions = 0;
  const coercible = {
    toString() { coercions++; return 'ev-object'; },
    [Symbol.toPrimitive]() { coercions++; return 'ev-object'; },
  };
  const result = project({
    addr:0x1000n,
    reasons:[
      { evidenceId:'ev-1', id:['ev-1'] },
      { evidenceId:['ev-2'], id:'ev-2' },
      { evidenceId:0, id:false },
      { evidenceId:coercible, id:'' },
      { evidenceId:'ev-1', id:null },
    ],
  });

  assert.deepEqual(result.candidates[0].evidenceIds, ['ev-1', 'ev-2']);
  assert.equal(coercions, 0);
});

test('#3672 genuinely absent address keeps the existing index fallback without entity authority', () => {
  const result = typedRankedCandidates({
    candidates:[
      { addr:0x1000n },
      { label:'unbound', reasons:[{ evidenceId:'ev-1' }] },
    ],
  }, context());

  assert.equal(result.candidates[1].candidateId, 'snapshot-3672:candidate:1');
  assert.equal(result.candidates[1].entityId, null);
  assert.deepEqual(result.candidates[1].evidenceIds, ['ev-1']);
});

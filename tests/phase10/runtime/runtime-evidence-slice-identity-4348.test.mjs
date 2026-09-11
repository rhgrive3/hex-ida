import assert from 'node:assert/strict';
import { createRuntimeEvidenceRecord, fuseStaticDynamic } from '../../../js/runtime-evidence/index.js';

const candidate = (sliceIdentity = 'slice:A') => ({
  binaryHash: 'fat-bin',
  sliceIdentity,
  functionAddress: 0x1000n,
  confidence: 0.5,
});

const evidence = ({
  id = 'ev',
  sliceIdentity,
  verdict = 'supported',
  binaryHash = 'fat-bin',
  fn = 0x1000n,
} = {}) => ({
  id,
  source: 'runtime',
  binaryHash,
  ...(sliceIdentity !== undefined ? { sliceIdentity } : {}),
  function: fn,
  verdict,
  provenance: { group: 'runtime', observationGroup: `group:${id}` },
});

// A slice-bound static candidate may only consume evidence bound to exactly
// the same slice. Missing slice provenance is not a wildcard.
{
  const same = fuseStaticDynamic(candidate(), [evidence({ id:'same', sliceIdentity:'slice:A' })]);
  assert.equal(same.status, 'supported');
  assert.equal(same.support, 1);
  assert.equal(same.runtimeGroups, 1);
  assert.equal(same.ignoredEvidence, 0);

  for (const row of [
    evidence({ id:'other-slice', sliceIdentity:'slice:B' }),
    evidence({ id:'null-slice', sliceIdentity:null }),
    evidence({ id:'missing-slice' }),
  ]) {
    const result = fuseStaticDynamic(candidate(), [row]);
    assert.equal(result.status, 'inconclusive', `${row.id} must not affect a slice-bound candidate`);
    assert.equal(result.support, 0);
    assert.equal(result.contradictions, 0);
    assert.equal(result.runtimeGroups, 0);
    assert.equal(result.ignoredEvidence, 1);
    assert.equal(result.confidence, 0.5);
  }
}

// The canonical runtime-evidence producer also emits an unbound slice when
// no slice authority is supplied; that record must remain untrusted for a
// slice-bound candidate.
{
  const produced = createRuntimeEvidenceRecord({
    id:'produced-unbound', backend:'fake', binaryHash:'fat-bin', sessionId:'session',
    experimentId:'experiment', caseId:'case', function:0x1000n, verdict:'supported',
    provenanceGroup:'group:produced',
  });
  const result = fuseStaticDynamic(candidate(), [produced]);
  assert.equal(result.status, 'inconclusive');
  assert.equal(result.runtimeGroups, 0);
  assert.equal(result.ignoredEvidence, 1);
}

// A missing-slice contradiction cannot defeat valid same-slice support even
// when binary hash and function address are otherwise identical. Reordering
// evidence cannot change that identity decision.
{
  const same = evidence({ id:'same-support', sliceIdentity:'slice:A', verdict:'supported' });
  const unbound = evidence({ id:'unbound-contradiction', sliceIdentity:null, verdict:'contradicted' });
  for (const rows of [[same, unbound], [unbound, same]]) {
    const result = fuseStaticDynamic(candidate(), rows);
    assert.equal(result.status, 'supported');
    assert.equal(result.support, 1);
    assert.equal(result.contradictions, 0);
    assert.equal(result.runtimeGroups, 1);
    assert.equal(result.ignoredEvidence, 1);
    assert.deepEqual(result.evidence, ['same-support']);
  }
}

// Preserve the conservative legacy policy in both directions: a candidate
// without slice identity rejects slice-bound evidence, while two unbound
// identities remain compatible whether the optional field is null or absent.
{
  const boundEvidence = fuseStaticDynamic(candidate(null), [evidence({ id:'bound', sliceIdentity:'slice:A' })]);
  assert.equal(boundEvidence.status, 'inconclusive');
  assert.equal(boundEvidence.runtimeGroups, 0);
  assert.equal(boundEvidence.ignoredEvidence, 1);

  for (const legacyCandidate of [candidate(null), {
    binaryHash:'fat-bin', functionAddress:0x1000n, confidence:0.5,
  }]) {
    const legacy = fuseStaticDynamic(legacyCandidate, [evidence({ id:'legacy', sliceIdentity:null })]);
    assert.equal(legacy.status, 'supported');
    assert.equal(legacy.support, 1);
    assert.equal(legacy.runtimeGroups, 1);
    assert.equal(legacy.ignoredEvidence, 0);
  }
}

// Existing binary/function identity gates remain authoritative.
{
  const binaryMismatch = fuseStaticDynamic(candidate(), [evidence({ id:'bin', sliceIdentity:'slice:A', binaryHash:'other-bin' })]);
  assert.equal(binaryMismatch.runtimeGroups, 0);
  assert.equal(binaryMismatch.ignoredEvidence, 1);

  const functionMismatch = fuseStaticDynamic(candidate(), [evidence({ id:'fn', sliceIdentity:'slice:A', fn:0x2000n })]);
  assert.equal(functionMismatch.runtimeGroups, 0);
  assert.equal(functionMismatch.ignoredEvidence, 1);
}

// Snapshot the evidence-side slice authority once per compatibility check.
// A stateful getter cannot present "missing" for validation and then become
// authoritative later in the same decision.
{
  let reads = 0;
  const row = evidence({ id:'stateful', sliceIdentity:'slice:A' });
  Object.defineProperty(row, 'sliceIdentity', {
    enumerable: true,
    get() {
      reads++;
      return reads === 1 ? null : 'slice:A';
    },
  });
  const result = fuseStaticDynamic(candidate(), [row]);
  assert.equal(result.status, 'inconclusive');
  assert.equal(result.runtimeGroups, 0);
  assert.equal(result.ignoredEvidence, 1);
  assert.equal(reads, 1);
}

console.log('runtime evidence slice identity #4348: ok');

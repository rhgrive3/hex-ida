// Regression for #5546 + #5495 (runtime evidence identity), reconciled with
// #4737's fail-closed provenance contract on main:
// #5546 — re-running the same experiment case with different observations
// minted the same evidence id (provenance group + kind only), so the
// canonical EvidenceGraph rejected the second run as evidence-id-conflict.
// Content-bearing records now carry a deterministic digest of their
// observation content; identical observations keep identical ids and
// content-free records keep the canonical 4327 format.
// #5495 — idPart() sanitized identity components irreversibly ('a/b' and
// 'a?b' both became 'a_b', ids differing only past the 160-char budget
// collided), collapsing distinct observations during fusion dedupe.
// Components are now injective: clean components pass through; anything
// else keeps a readable prefix plus a stableDigest of the full value.
// Validated provenance fields (sessionId/experimentId/caseId/provenanceGroup)
// fail closed on non-canonical or over-budget ids per #4737, so the
// injectivity contract is exercised on the unvalidated component paths
// (kind / function) where sanitization used to collapse identities.
import assert from 'node:assert/strict';
import { createRuntimeEvidenceRecord } from '../../../js/runtime-evidence/index.js';
import { legacyEvidenceToCanonicalGraph } from '../../../js/core/evidence/compat.js';

// #4327 canonical format must survive for content-free records
assert.equal(
  createRuntimeEvidenceRecord({ sessionId: 'session', experimentId: 'experiment', caseId: 'case', kind: 'observation' }).id,
  'runtime:session:experiment:case:observation',
);

// #5546: a re-run with different observedState/verdict must not collide
const base = {
  sessionId: 's', experimentId: 'e', caseId: 'c', kind: 'experiment',
  binaryHash: 'bin', function: 0x1000n, provenanceGroup: 'runtime:s:e:c',
};
const first = createRuntimeEvidenceRecord({
  ...base, timestamp: '2026-09-03T00:00:00.000Z', observedState: { returnValue: 1 }, verdict: 'supported',
});
const second = createRuntimeEvidenceRecord({
  ...base, timestamp: '2026-09-03T00:00:01.000Z', observedState: { returnValue: 2 }, verdict: 'contradicted',
});
assert.notEqual(first.id, second.id, 're-run observations must own distinct evidence ids');
legacyEvidenceToCanonicalGraph({ runtimeEvidence: [first, second] });
assert.ok(true, 'canonical graph accepts both runs without evidence-id-conflict');

// identical observation content keeps one identity (content-addressed)
const third = createRuntimeEvidenceRecord({ ...base, observedState: { returnValue: 1 }, verdict: 'supported' });
assert.equal(first.id, third.id);

// #4737: validated provenance components fail closed instead of being
// sanitized — 'a/b' and 'a?b' must not mint ids at all
for (const sessionId of ['a/b', 'a?b', `${'x'.repeat(160)}A`]) {
  assert.throws(
    () => createRuntimeEvidenceRecord({ sessionId, kind: 'observation' }),
    (error) => error instanceof TypeError
      && error.message === 'runtime provenance sessionId must be a non-empty string',
  );
}

// #5495: on unvalidated component paths (kind), sanitized-away characters
// can no longer collapse identities
const slash = createRuntimeEvidenceRecord({ sessionId: 's', kind: 'a/b' });
const query = createRuntimeEvidenceRecord({ sessionId: 's', kind: 'a?b' });
assert.notEqual(slash.id, query.id, "'a/b' and 'a?b' kinds must not share one identity");

// ids differing only past the 160-component budget stay distinct
const long1 = createRuntimeEvidenceRecord({ sessionId: 's', kind: 'x'.repeat(200) + '1' });
const long2 = createRuntimeEvidenceRecord({ sessionId: 's', kind: 'x'.repeat(200) + '2' });
assert.notEqual(long1.id, long2.id, 'truncation must not collapse long identities');

console.log('issues #5546/#5495 runtime evidence identity injectivity regression: PASS');

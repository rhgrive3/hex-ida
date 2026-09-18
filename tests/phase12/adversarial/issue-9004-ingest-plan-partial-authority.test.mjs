/*
 * Issue #9004 regression — EvidenceStore.ingestPlan must not launder a partial
 * planner proof into terminal `verified` final-answer authority.
 *
 * #8673 established that a locally valid positive candidate verification cannot
 * be widened into global/terminal authority while the planner reports partial
 * coverage. ingestPlan is a different authority consumer that did not consult
 * that shared decision: it promoted `candidate.verification.verified` for the
 * best address-matched candidate straight into a canonical
 * `kind:'candidate-verification', status:'verified'` record minted with the
 * private DETERMINISTIC_VERIFICATION authority, even when the same plan
 * declared `complete:false` / `partial:true`. A provider turn can then bind
 * that record and finalize a confidence-1 global claim with no citations.
 *
 * The fix routes ingestPlan's terminal promotion through
 * globalCandidateAuthority(plan): an incomplete/partial plan keeps the
 * candidate-local verification as a non-terminal `supported` record; a
 * genuinely complete plan (or a non-planner producer with no coverage metadata)
 * keeps the existing verified authority.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { EvidenceStore } from '../../../js/ai/evidence.js';

const candidate = () => ({
  address: '0x1000',
  name: 'best candidate',
  score: 1,
  evidence: ['ev-real'],
  verification: { verified: true, evidenceIds: ['ev-real'], verifiedEvidenceIds: ['ev-real'] },
});

function seedStore() {
  const store = new EvidenceStore();
  store.add({ id: 'ev-real', kind: 'observation', title: 'real verification' });
  return store;
}

test('#9004 partial/incomplete planner coverage cannot be laundered into verified plan authority', () => {
  const store = seedStore();
  store.ingestPlan({
    best: { address: '0x1000' },
    completeness: { complete: false, partial: true },
    candidates: [candidate()],
  });
  const verified = store.all().filter((r) => r.status === 'verified');
  assert.equal(verified.length, 0, 'an incomplete plan must not mint any terminal verified record');
  const local = store.all().find((r) => r.kind === 'candidate-verification');
  assert.ok(local, 'the candidate-local verification provenance is still recorded');
  assert.equal(local.status, 'supported', 'a locally-verified best candidate stays non-terminal under partial coverage');
  assert.equal(local.sourceData?.globalCandidateAuthority?.authoritative, false);
});

test('#9004 a best-complete:false marker disqualifies terminal authority even with a bare partial flag', () => {
  const store = seedStore();
  store.ingestPlan({
    best: { address: '0x1000', complete: false },
    partial: true,
    candidates: [candidate()],
  });
  assert.equal(store.all().filter((r) => r.status === 'verified').length, 0);
  assert.ok(store.all().some((r) => r.kind === 'candidate-source' && r.status === 'supported'), 'source rows are supported, not verified');
});

test('#9004 control: a genuinely complete plan still mints terminal verified authority', () => {
  const store = seedStore();
  store.ingestPlan({
    best: { address: '0x1000', complete: true },
    completeness: { complete: true, partial: false, searchComplete: true, unanalyzedFunctions: 0 },
    candidates: [candidate()],
  });
  const verified = store.all().filter((r) => r.status === 'verified');
  assert.ok(verified.some((r) => r.kind === 'candidate-verification'), 'a complete plan must keep the verified candidate-verification record');
  assert.ok(verified.some((r) => r.kind === 'candidate-source'), 'a complete plan must keep the verified candidate-source record');
});

test('#9004 control: a non-planner producer with no coverage metadata keeps prior behavior', () => {
  const store = seedStore();
  store.ingestPlan({
    best: { address: '0x1000' },
    candidates: [candidate()],
  });
  assert.ok(store.all().some((r) => r.status === 'verified' && r.kind === 'candidate-verification'), 'absent coverage metadata is not a failure');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createProductSurfaceQueries } from '../../js/analysis/query/product-surface.js';

const SNAPSHOT = Object.freeze({ snapshotId:'snap-3492', analysisEpoch:1 });

function queriesFor(report) {
  const app = {
    analysisQueries:{ snapshot:async () => SNAPSHOT },
    autoReport:{ report },
  };
  return createProductSurfaceQueries(app);
}

test('structured claim identity, confidence, and evidence cannot launder into canonical values', async () => {
  const query = queriesFor({
    findings:[{
      claimId:['claim-A'],
      confidence:['0.9'],
      evidenceIds:[['ev-1']],
      verdict:'confirmed',
    }],
  });

  const result = await query.claims(SNAPSHOT, {}, { offset:0, limit:20 });
  assert.deepEqual(result.value, []);
  assert.equal(result.completeness, 'partial');
  assert.equal(result.status.reason, 'claim-source-invalid');
  assert.equal(result.page.total, null);

  const filtered = await query.claims(SNAPSHOT, { claimId:'claim-A' }, { offset:0, limit:20 });
  assert.deepEqual(filtered.value, []);
  assert.equal(filtered.completeness, 'partial');
});

test('each malformed authority field invalidates only its source row', async () => {
  const query = queriesFor({ findings:[
    { claimId:'valid', confidence:0.5, evidenceIds:['ev-valid'], verdict:'supported' },
    { claimId:['bad-id'], confidence:0.5, evidenceIds:['ev-1'] },
    { claimId:'bad-confidence', confidence:'0.9', evidenceIds:['ev-2'] },
    { claimId:'bad-evidence', confidence:0.5, evidenceIds:[['ev-3']] },
    { claimId:'bad-container', confidence:0.5, evidenceIds:{ 0:'ev-4' } },
    { claimId:'bad-range', confidence:1.01, evidenceIds:['ev-5'] },
  ] });

  const result = await query.claims(SNAPSHOT, {}, { offset:0, limit:20 });
  assert.deepEqual(result.value.map((row) => row.claimId), ['valid']);
  assert.equal(result.value[0].confidence, 0.5);
  assert.deepEqual(result.value[0].evidenceIds, ['ev-valid']);
  assert.equal(result.completeness, 'partial');
  assert.equal(result.status.reason, 'claim-source-invalid');
});

test('claim projection does not invoke user-controlled coercion hooks', async () => {
  let coercions = 0;
  const poison = {
    toString() { coercions++; throw new Error('toString must not run'); },
    valueOf() { coercions++; throw new Error('valueOf must not run'); },
  };
  const query = queriesFor({ findings:[
    { claimId:poison, confidence:0.5, evidenceIds:['ev-1'] },
    { claimId:'confidence', confidence:poison, evidenceIds:['ev-2'] },
    { claimId:'evidence', confidence:0.5, evidenceIds:[poison] },
  ] });

  const result = await query.claims(SNAPSHOT, {}, { offset:0, limit:20 });
  assert.deepEqual(result.value, []);
  assert.equal(result.completeness, 'partial');
  assert.equal(coercions, 0);
});

test('canonical primitive claims and legacy generated IDs retain their semantics', async () => {
  const query = queriesFor({ findings:[
    { claimId:' claim-A ', confidence:0, evidenceIds:[' ev-1 '], verdict:'supported' },
    { confidence:1, evidenceIds:[], verdict:'unverified' },
  ] });

  const result = await query.claims(SNAPSHOT, {}, { offset:0, limit:20 });
  assert.equal(result.completeness, 'complete');
  assert.equal(result.page.total, 2);
  assert.equal(result.value[0].claimId, 'claim-A');
  assert.equal(result.value[0].confidence, 0);
  assert.deepEqual(result.value[0].evidenceIds, ['ev-1']);
  assert.equal(result.value[1].claimId, 'claim-1');
  assert.equal(result.value[1].confidence, 1);
});

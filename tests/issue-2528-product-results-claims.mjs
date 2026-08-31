import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createProductSurfaceQueries } from '../js/analysis/query/product-surface.js';

const snapshot = Object.freeze({
  snapshotId:'snapshot-2528',
  analysisEpoch:7,
  binaryId:'binary-2528',
  projectRevision:3,
});

const app = {
  analysisQueries:{ snapshot:async () => snapshot },
  autoReport:{
    report:{
      findings:[
        { claimId:'high-score-no-proof', title:'High score', confidence:0.99 },
        { claimId:'proof-backed', title:'Proof backed', confidence:0.2, verdict:'confirmed', evidenceIds:['ev-1'] },
        { claimId:'contradicted', title:'Contradicted', confidence:1, verdict:'contradicted', contradictions:['ev-2'] },
      ],
    },
  },
};

const queries = createProductSurfaceQueries(app);
const first = await queries.claims(snapshot, {}, { offset:0, limit:1 });
assert.equal(first.value.length, 1);
assert.equal(first.value[0].claimId, 'high-score-no-proof');
assert.equal(first.value[0].verdict, 'unverified', 'confidence must not mint a verdict');
assert.equal(first.page.next, 1, 'claims must be producer-paged');
assert.equal(first.snapshotId, snapshot.snapshotId);

const exact = await queries.claims(snapshot, { claimId:'proof-backed' }, { offset:0, limit:1 });
assert.equal(exact.value.length, 1);
assert.equal(exact.value[0].verdict, 'confirmed');
assert.deepEqual(exact.value[0].evidenceIds, ['ev-1']);
assert.equal(exact.value[0].snapshotId, snapshot.snapshotId);

const contradicted = await queries.claims(snapshot, { verdict:['contradicted'] }, { offset:0, limit:10 });
assert.deepEqual(contradicted.value.map((claim) => claim.claimId), ['contradicted']);

const resultsSource = fs.readFileSync(fileURLToPath(new URL('../js/ui/product-results.js', import.meta.url)), 'utf8');
assert.doesNotMatch(resultsSource, /app\.autoReport/);
assert.doesNotMatch(resultsSource, /confidence\s*>\s*0\.7/);
assert.match(resultsSource, /queries\.claims\(/);
assert.match(resultsSource, /claim\.verdict/);

const productEntry = fs.readFileSync(fileURLToPath(new URL('../js/ui/product.js', import.meta.url)), 'utf8');
assert.match(productEntry, /renderProductResultsRoute/);
assert.match(productEntry, /route\?\.route\?\.id === 'results'/);
assert.match(productEntry, /route\?\.route\?\.id === 'finding'/);
assert.doesNotMatch(productEntry, /app\.autoReport/);

console.log('issue-2528-product-results-claims: ok');

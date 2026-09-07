import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { stableDigest } from '../../../js/core/identity/index.js';
import { measureTieredSolver, tieredPerformanceFailures, PROFILE_DIGEST } from '../../../tools/validation/phase9/tiered-solver-metrics.mjs';
import { validateEvidence, SCHEMA_VERSION } from '../../../tools/validation/phase9/verify.mjs';
const profile=JSON.parse(fs.readFileSync(new URL('../../../tools/validation/phase9/profile.json',import.meta.url)));

test('canonical migrated profile checks actual wide measurements and all four resource ceilings',async()=>{
  const metrics=await measureTieredSolver();
  assert.deepEqual(tieredPerformanceFailures(metrics),[]);
  for(const metric of ['cnfVariables','cnfClauses','decisions','propagations']) {
    const threshold=profile.performance.blockingThresholds.find(row=>row.metric===metric).threshold;
    for(const value of [undefined,NaN,-1,threshold+1]) {
      const changed={...metrics,solves:metrics.solves.map((row,i)=>i===0?{...row,[metric]:value}:row)};
      assert.ok(tieredPerformanceFailures(changed).includes(`resource:${metric}`));
    }
  }
  assert.ok(tieredPerformanceFailures({...metrics,profileDigest:profile.migration.previousProfileDigest}).includes('profile-identity-mismatch'));
  assert.ok(tieredPerformanceFailures({...metrics,solves:[metrics.solves[0],metrics.solves[0]]}).length);
});

test('migration invalidates old evidence while full immutable-source denominator is preserved',()=>{
  assert.equal(profile.migration.inputClassification,'PARTIAL');assert.equal(profile.migration.decision,'migrate');
  assert.notEqual(PROFILE_DIGEST,profile.migration.previousProfileDigest);
  const g=profile.performance.differentialGenerator;
  assert.equal(stableDigest(g.descriptor),g.stableDigest);
  // The original source covers all values at widths 1–4, plus boundary values at 5–8.
  assert.deepEqual(g.descriptor.corpusCardinalityByWidth,[2,4,8,16,7,7,7,7]);
  let deterministic=0;
  for(const [i,n] of g.descriptor.corpusCardinalityByWidth.entries()) {
    const w=i+1;deterministic+=2*((13+10)*n*n+2*n+Math.min(n,4)*(2+(w>1?2:0)+(w<8?2:0)));
  }
  deterministic+=2*(4*7+2);
  assert.equal(g.descriptor.deterministicQueryCount,deterministic);
  assert.equal(g.descriptor.totalQueryCount,deterministic+192);
  assert.equal(g.descriptor.backendResultCount,(deterministic+192)*2);
  const old={schemaVersion:SCHEMA_VERSION,profileDigest:profile.migration.previousProfileDigest,verdict:'BLOCKING',gates:[],browserRuntime:{},deterministicDigest:'x',evidenceDigest:'x'};
  assert.ok(validateEvidence(old).some(error=>error.includes('profile identity mismatch')));
});

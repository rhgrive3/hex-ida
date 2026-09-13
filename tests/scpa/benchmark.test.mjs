import test from 'node:test';
import assert from 'node:assert/strict';
import {workFor} from './helpers.mjs';
import {H,protocolInput,benchmarkFixture,rowsFor,testAdmission,testVerifiers} from './benchmark-fixture.mjs';
import {createCompetitiveProtocol,assertCompetitiveProtocol,admitCompetitiveProtocol,normalizeCompetitiveMeasurement,competitiveReleasePreflight} from '../../js/analysis/benchmark/competitive-protocol.js';
import {createCompetitiveMetricMatrix,auditCompetitiveMeasurements} from '../../js/analysis/benchmark/competitive-matrix.js';
test('declared protocol cannot acquire admission through serialization',()=>{
  const {protocol:p}=benchmarkFixture(); assert.equal(p.qualified,false); assert.equal(p.status,'DECLARED');
  assert.throws(()=>assertCompetitiveProtocol(structuredClone(p)),/not-normalized/);
});
for(const [name,change] of [
  ['different Astra',p=>p.participants[1].astra.modelRevision='different'],
  ['missing competitor',p=>p.participants.pop()],
  ['duplicate competitor',p=>p.participants[1].id=p.participants[0].id],
  ['duplicate corpus case',p=>p.cases[1].caseId=p.cases[0].caseId],
  ['invalid freeze',p=>p.baselineCommit='main'],
  ['unknown metric',p=>p.metrics=['marketing']],
  ['missing case',p=>p.cases=[]],
]) test(`protocol rejects ${name}`,()=>{const p=protocolInput();change(p);assert.throws(()=>createCompetitiveProtocol(p));});
test('absence of independent verifiers retains every admission obligation',async t=>{
  const {protocol:p}=benchmarkFixture(); const a=await admitCompetitiveProtocol(p,{work:workFor(t)});
  assert.equal(a.status,'NOT-ADMITTED'); assert.equal(a.obligations.length,6); assert.equal(a.victoryEstablished,false);
});
for(const state of ['UNAVAILABLE','UNMEASURED','FAILED']) test(`${state} cells cannot be turned into zero-valued observations`,()=>{
  const {protocol:p}=benchmarkFixture(),r=rowsFor(p)[0]; r.state=state;
  assert.throws(()=>normalizeCompetitiveMeasurement(p,r),/unmeasured-must-not-report-data/);
  for(const key of ['value','recall','unknownRate','exactErrors','oracleReceiptId','executionReceiptId','correctnessReceiptId','sampleTraceSha256'])delete r[key];
  assert.equal(normalizeCompetitiveMeasurement(p,r).value,null);
});
for(const [name,change] of [
  ['NaN timing',r=>r.value=NaN],['negative timing',r=>r.value=-1],['missing recall qualification',r=>delete r.recall],
  ['counter overflow',r=>r.exactErrors['wrong-exact-facts']=Number.MAX_SAFE_INTEGER+1],
  ['wrong binary',r=>r.binarySha256='cd'.repeat(32)],['wrong repetition',r=>r.repetition=1],
])test(`measurement rejects ${name}`,()=>{const {protocol:p}=benchmarkFixture(),r=rowsFor(p)[0];change(r);assert.throws(()=>normalizeCompetitiveMeasurement(p,r));});
test('matrix cannot silently drop hard strata or mix cache modes',()=>{
  const {protocol:p,matrixInput:input}=benchmarkFixture();
  assert.throws(()=>createCompetitiveMetricMatrix(p,{...input,caseStrata:input.caseStrata.slice(0,1)}),/complete-definition/);
  input.metrics[0].cacheStates=['cold','not-applicable'];assert.throws(()=>createCompetitiveMetricMatrix(p,input),/cache-state-mix/);
});
test('empty audit retains the complete Cartesian denominator and all missing cells',async t=>{
  const {protocol:p,matrix:m}=benchmarkFixture(),a=await admitCompetitiveProtocol(p,{work:workFor(t)});
  const r=await auditCompetitiveMeasurements(p,a,m,[],{work:workFor(t)});
  assert.equal(r.expectedCells,6);assert.equal(r.suppliedCells,0);
  for(const c of Object.values(r.counters)){assert.equal(c.expected,2);assert.equal(c.missing,2);}
  assert.equal(r.verdict,'NOT-YET');assert.equal(r.experimentsExecuted,0);
});
test('receiptVerified request flag cannot acquire verification authority',async t=>{
  const {protocol:p,matrix:m}=benchmarkFixture(),a=await testAdmission(p,workFor(t));
  const r=await auditCompetitiveMeasurements(p,a,m,rowsFor(p).map(x=>({...x,receiptVerified:true})),{work:workFor(t)});
  assert.equal(r.counters['hex-astra'].measuredUnverified,2);
  assert.equal(r.groups[0].comparisons['ida-astra'].own.median,null);
});
test('complete test-double receipts enable descriptive pairing but never award victory',async t=>{
  const {protocol:p,matrix:m}=benchmarkFixture(),a=await testAdmission(p,workFor(t));
  const r=await auditCompetitiveMeasurements(p,a,m,rowsFor(p),{work:workFor(t),...testVerifiers(p,m)});
  assert.equal(r.definitionChecked,true);assert.equal(r.counters['hex-astra'].receiptChecked,2);
  const pair=r.groups[0].comparisons['ida-astra'];assert.equal(pair.matrixComplete,true);assert.notEqual(pair.own.median,null);assert.equal(pair.winner,null);
  assert.equal(r.victoryEstablished,false);assert.equal(r.experimentsExecuted,0);
});
test('dropping a hard competitor cell withholds the whole paired summary',async t=>{
  const {protocol:p,matrix:m}=benchmarkFixture(),a=await testAdmission(p,workFor(t));
  const rows=rowsFor(p).filter(r=>!(r.caseId==='hard'&&r.participantId==='ida-astra'));
  const r=await auditCompetitiveMeasurements(p,a,m,rows,{work:workFor(t),...testVerifiers(p,m)});
  const pair=r.groups[0].comparisons['ida-astra'];assert.equal(pair.observedPairedCells,1);assert.equal(pair.expectedPairedCells,2);
  assert.equal(pair.own.median,null);assert.equal(pair.medianRatioCompetitorOverHex,null);
});
test('wrong exact facts veto release even with replayed timing receipts',async t=>{
  const {protocol:p,matrix:m}=benchmarkFixture(),a=await testAdmission(p,workFor(t)),rows=rowsFor(p);
  rows.find(r=>r.participantId==='hex-astra').exactErrors['wrong-exact-facts']=1;
  const r=await auditCompetitiveMeasurements(p,a,m,rows,{work:workFor(t),...testVerifiers(p,m)});
  assert.ok(r.releaseVetoes.includes('hex-exact-error-veto:wrong-exact-facts'));
  assert.equal(competitiveReleasePreflight(p,a,rows).verdict,'NOT-YET');
});
test('duplicates, units and sparse arrays cannot corrupt the measurement denominator',async t=>{
  const {protocol:p,matrix:m}=benchmarkFixture(),a=await testAdmission(p,workFor(t)),rows=rowsFor(p);
  for(const [bad,reason]of [[[rows[0],rows[0]],/duplicate-cell/],[[{...rows[0],unit:'seconds'}],/unit-mismatch/],[new Array(1),/non-data-row|plain-array-required/]])
    await assert.rejects(auditCompetitiveMeasurements(p,a,m,bad,{work:workFor(t)}),reason);
});
test('late verifier invalidation prevents mixed-generation audit publication',async t=>{
  const {protocol:p,matrix:m}=benchmarkFixture(),a=await testAdmission(p,workFor(t));let current=true;
  const v=testVerifiers(p,m,()=>current),verify=v.verifyMeasurement;let count=0;
  v.verifyMeasurement=(...args)=>{if(++count===6)current=false;return verify(...args);};
  await assert.rejects(auditCompetitiveMeasurements(p,a,m,rowsFor(p),{work:workFor(t),...v}),/current|stale/);
});
test('undefined zero timing ratio stays null, not Infinity or an automatic win',async t=>{
  const {protocol:p,matrix:m}=benchmarkFixture(),a=await testAdmission(p,workFor(t)),rows=rowsFor(p);
  for(const r of rows)if(r.participantId==='hex-astra')r.value=0;
  const r=await auditCompetitiveMeasurements(p,a,m,rows,{work:workFor(t),...testVerifiers(p,m)});
  assert.equal(r.groups[0].comparisons['ida-astra'].medianRatioCompetitorOverHex,null);
});

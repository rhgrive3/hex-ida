import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { stableDigest } from '../../../js/core/identity/index.js';
import { queryTaint,createTaintModels,verifyDeobfuscationCandidate,expr as E } from '../../../js/symbolic/index.js';
import { identity,scalarFixture,integrationFixture } from '../taint/fixtures.mjs';
import { aggregateTrials } from '../memory/fixtures.mjs';
const locks=JSON.parse(fs.readFileSync(new URL('../fixtures/memory-taint-performance-locks.json',import.meta.url),'utf8'));
const simpleModels=extra=>createTaintModels({id:'perf',version:'1',provenance:'owned:locked-fixtures',sources:[{id:'external',valueId:'input'}],sinks:[{id:'sink',valueId:'out'}],...extra});
async function measureCase(caseId) {
  const started=performance.now(),trials=[];let proof=null;
  const run=(ir,options)=>{const result=queryTaint(ir,{identity,...options});trials.push(result);return result;};
  if(['implicit-control-flow','byte-memory-flow','may-alias-store'].includes(caseId)) {
    const ir=integrationFixture();
    if(caseId==='may-alias-store') ir.blocks[0].insts[1].addr.base={id:'other',kind:'arg',index:3,reg:'x3',bits:8};
    const models=createTaintModels({id:'byte-flow',version:'1',provenance:'owned:locked-fixtures',sources:[{id:'external',valueId:'byte'}],sinks:[{id:'sink',valueId:caseId==='implicit-control-flow'?'no':'final'}]});
    const r=run(ir,{models,memory:{addressBits:8,wrapping:'modular'}});
    assert.equal(r.status,'complete',r.reason);assert.notEqual(r.sinks[0].taint.kind,'untainted');assert.ok(r.evidence);
    if(caseId==='implicit-control-flow') assert.ok(r.edges.some(edge=>edge.kind==='control'));
  } else if(caseId==='known-sanitizer'||caseId==='unknown-sanitizer') {
    const known=caseId==='known-sanitizer';
    const models=simpleModels({sanitizers:[{id:'sanitize',valueId:'out',scope:known?'value':'unreviewed',removeSources:['external'],clean:true}]});
    const r=run(scalarFixture(),{models,memory:{addressBits:8}});assert.equal(r.status,'complete',r.reason);
    assert.equal(r.sinks[0].taint.kind,known?'untainted':'sources');
  } else if(caseId==='cancel-replay') {
    const models=simpleModels();let checks=0;
    const r=run(scalarFixture(),{models,memory:{addressBits:8},isCancelled:()=>++checks>20});
    assert.equal(r.status,'partial');assert.equal(r.reason,'cancelled');assert.equal(r.evidence,null);
    const replay=run(scalarFixture(),{models,memory:{addressBits:8}});assert.equal(replay.status,'complete');assert.ok(replay.evidence);
  } else if(['explicit-data-flow','proof-timeout','proven-deobfuscation'].includes(caseId)) {
    const r=run(scalarFixture(),{models:simpleModels(),memory:{addressBits:8}});
    assert.equal(r.status,'complete');assert.deepEqual(r.sinks[0].taint.sources,['external']);
    if(caseId!=='explicit-data-flow') {
      const x=E.createFreshSymbol(E.bvSort(4),'proof-input');
      const proofStart=performance.now();
      const result=await verifyDeobfuscationCandidate({candidateId:caseId,beforeValueId:'before',afterValueId:'after',identity,
        before:E.createBinary('add',x,x),after:E.createBinary('shl',x,E.createBv(4,1)),memoryObservables:[],effectObservables:[],taintResult:r,
        timeoutMs:caseId==='proof-timeout'?0:120});
      proof={eligible:result.eligible,verdict:result.verdict,reason:result.reason,elapsedMilliseconds:performance.now()-proofStart,proofAuthority:result.evidence?.proofAuthority??null};
      assert.equal(result.eligible,caseId==='proven-deobfuscation');
      if(caseId==='proof-timeout') assert.equal(result.reason,'deadline');
    }
  } else throw new Error(`unimplemented locked case: ${caseId}`);
  return {caseId,metrics:{...aggregateTrials(trials),phase8OptimizeStage:null},ownedCaseMilliseconds:performance.now()-started,
    proof,trials:trials.map(r=>({status:r.status,reason:r.reason,metrics:r.metrics})),assertions:'executed'};
}
test('P-TAINT: locked nine cases and actual counts; phase8OptimizeStage explicitly NOT RUN',async()=>{
  const lock=locks.profiles['P-TAINT'];assert.equal(stableDigest(lock.fixtureSet.descriptor),lock.fixtureSet.stableDigest);
  assert.equal(lock.fixtureSet.descriptor.caseCount,9);
  const cases=[];for(const caseId of lock.fixtureSet.descriptor.cases) cases.push(await measureCase(caseId));
  for(const row of cases) for(const threshold of lock.blockingThresholds) {
    if(threshold.metric==='phase8OptimizeStage') {assert.equal(row.metrics.phase8OptimizeStage,null);continue;}
    assert.equal(threshold.operator,'<=');
    assert.ok(Number.isFinite(row.metrics[threshold.metric]),`${row.caseId}: missing ${threshold.metric}`);
    assert.ok(row.metrics[threshold.metric]<=threshold.threshold,`${row.caseId}: ${threshold.metric}=${row.metrics[threshold.metric]}`);
  }
  const record={profile:'P-TAINT',fixtureSet:lock.fixtureSet,thresholds:lock.blockingThresholds,environment:{runtime:process.version,platform:process.platform,architecture:process.arch},
    metricAggregation:'maximum counter per constituent query; ownedCaseMilliseconds is NOT phase8OptimizeStage',
    notRun:{phase8OptimizeStage:'No phase8 optimizer callsite is modified by this owned patch',officialCollector:'NOT RUN',iPadWebKit:'NOT RUN'},cases};
  if(process.env.HEX_002_METRICS_DIR) {
    fs.mkdirSync(process.env.HEX_002_METRICS_DIR,{recursive:true});
    fs.writeFileSync(path.join(process.env.HEX_002_METRICS_DIR,'P-TAINT.node.json'),JSON.stringify(record,null,2)+'\n');
  }
  console.log(`P-TAINT_NODE ${JSON.stringify(cases.map(row=>({caseId:row.caseId,metrics:row.metrics,ownedCaseMilliseconds:row.ownedCaseMilliseconds,proof:row.proof})))}`);
});

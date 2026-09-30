#!/usr/bin/env node
// Offline verification is independent of the live runner and makes no calls.
import fs from 'node:fs';
import {readJevEvidence} from './read-jev-evidence.mjs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {sha256,structuralMatch,funnel,percentiles} from './jev-realgame-final-contract.mjs';
import {recoveryRequestBody,deterministicRecoveryPick} from './jev-realgame-recovery-contract.mjs';
import {validateChoice} from './jev-realgame-final-client.mjs';
import {summarize} from './evaluate-jev-realgame-final.mjs';

export function verifyRecoveryEvidence({caseBytes,policyBytes,snapshots,rows,summary}) {
  const cases=JSON.parse(caseBytes),policy=JSON.parse(policyBytes);
  const inputs=new Map(snapshots.flatMap(s=>s.rows.map(r=>[r.id,r])));
  assert.equal(new Set(cases.map(c=>c.id)).size,cases.length);
  assert.equal(inputs.size,cases.length);assert.equal(rows.length,cases.length);
  assert.equal(summary.caseSha256,sha256(caseBytes));assert.equal(summary.policySha256,sha256(policyBytes));
  for(const s of snapshots) {
    assert.equal(s.complete,true);assert.equal(s.productSha,summary.productSha);
    assert.equal(s.policySha256,sha256(policyBytes));assert.deepEqual(s.sourceHashes,summary.sourceHashes);
    assert.equal(s.collection.keyCollisions,0);
    for(const r of s.rows) {
      assert.equal(r.binary,s.binaryKey);assert.equal(r.binarySha256,s.binarySha256);
      for(const c of [...r.candidates,...r.published,...r.recovered])assert.equal(c.binarySha256,s.binarySha256);
    }
  }
  let calls=0;
  for(const c of cases) {
    const input=inputs.get(c.id),row=rows.find(r=>r.id===c.id),verified=c.status==='verified';
    assert.ok(input&&row);assert.equal(input.query,c.query);assert.equal(row.query,c.query);
    assert.equal(row.binary,c.binary);assert.equal(row.status,c.status);assert.deepEqual(row.gold,c);
    if(verified) {assert.ok(c.identities.length);for(const g of c.identities)assert.equal(g.binarySha256,input.binarySha256);}
    assert.deepEqual(row.funnel,funnel({...input,candidates:input.published},c));
    const hex=input.candidates.find(s=>s.key===input.topKey)??null;
    const det=input.routed?deterministicRecoveryPick(c.query,input.candidates):hex;
    assert.equal(row.arms.A.key,hex?.key??null);assert.equal(row.arms.DET.key,det?.key??null);
    assert.equal(row.hexCorrect,verified?structuralMatch(hex,c):null);
    assert.ok(input.shortlist.length<=255);
    assert.equal(new Set(input.candidates.map(s=>s.key)).size,input.candidates.length);
    assert.ok(input.shortlist.every(s=>input.candidates.some(x=>x.key===s.key)));
    for(const [arm,a] of Object.entries(row.arms)) {
      assert.equal(a.correct,verified?structuralMatch(input.candidates.find(s=>s.key===a.key),c):null);
      if(!['B','E'].includes(arm))continue;
      assert.equal(a.repeatedKeys.length,policy.repeats);assert.equal(a.key,a.repeatedKeys[0]);
      assert.deepEqual(a.repeatedCorrect,a.repeatedKeys.map(key=>verified?structuralMatch(input.candidates.find(s=>s.key===key),c):null));
      assert.equal(a.calls.length,input.routed?policy.repeats:0);
      for(const call of a.calls) {
        calls++;assert.equal(call.query,c.query);assert.equal(call.arm,arm);
        const body=recoveryRequestBody(c.query,input.shortlist,arm);
        assert.deepEqual(call.criteria,body.questions.pick.criteria,'oracle leakage or payload drift');
        assert.equal(call.bodyHash,sha256(JSON.stringify(body)));
        if(call.error)assert.equal(a.repeatedKeys[call.repeat],input.topKey);
        else {
          assert.equal(validateChoice(call.response,input.shortlist.length),null);
          const i=Number(call.response.answers.pick.choice.slice(1));
          assert.equal(call.choiceIndex,i);assert.equal(call.selectedKey,input.shortlist[i].key);
          assert.equal(a.repeatedKeys[call.repeat],call.selectedKey);
        }
      }
    }
  }
  for(const arm of ['A','DET','B','E']) {
    assert.deepEqual(summary.summaries[arm],summarize(rows,arm));
    for(const game of ['openttd','openmw'])assert.deepEqual(summary.perGame[game][arm],summarize(rows.filter(r=>r.binary===game),arm));
  }
  assert.deepEqual(summary.coldRecoveryLatency,percentiles(rows.map(r=>r.recoveryLatencyMs)));
  return {cases:cases.length,verified:cases.filter(c=>c.status==='verified').length,calls,valid:true};
}

function main() {
  const [caseFile,snapshotsDir,resultsDir]=process.argv.slice(2);
  if(!resultsDir)throw new Error('usage: CASES SNAPSHOTS RESULTS');
  const summary=JSON.parse(fs.readFileSync(path.join(resultsDir,'summary.json')));
  const experiment=JSON.parse(fs.readFileSync(new URL('../reports/investigations/jev-realgame-final/recovery-experiment-freeze.json',import.meta.url)));
  assert.equal(sha256(fs.readFileSync(caseFile)),experiment.corpora[summary.role].caseSha256);
  assert.equal(summary.policySha256,experiment.policySha256);
  const snapshots=['openttd','openmw'].map(k=>{
    const bytes=readJevEvidence(path.join(snapshotsDir,`${k}.json`));
    assert.equal(summary.snapshotHashes[k],sha256(bytes));return JSON.parse(bytes);
  });
  const result=verifyRecoveryEvidence({caseBytes:fs.readFileSync(caseFile),
    policyBytes:fs.readFileSync(new URL('../reports/investigations/jev-realgame-final/recovery-policy-freeze.json',import.meta.url)),
    snapshots,summary,rows:readJevEvidence(path.join(resultsDir,'raw-results.jsonl'),'utf8').trim().split('\n').map(JSON.parse)});
  console.log(JSON.stringify(result));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main();

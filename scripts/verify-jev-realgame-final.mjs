#!/usr/bin/env node
// Independent offline replay of retained evidence; never calls a service.
import fs from 'node:fs';
import {readJevEvidence} from './read-jev-evidence.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { ARMS, requestBody, verifyCases, sha256, structuralMatch, funnel } from './jev-realgame-final-contract.mjs';
import { summarize } from './evaluate-jev-realgame-final.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export function verifyEvidence({casesBytes,gold,policyBytes,snapshots,rows,summary}) {
  const policy=JSON.parse(policyBytes);
  const cases=verifyCases(casesBytes);const inputs=new Map(snapshots.flatMap(s=>s.rows.map(r=>[r.id,r])));
  const golds=new Map(gold.cases.map(g=>[g.id,g]));
  assert.equal(rows.length,70);assert.equal(inputs.size,70);assert.equal(golds.size,70);
  assert.equal(summary.caseSha256,sha256(casesBytes));assert.equal(summary.policySha256,sha256(policyBytes));
  assert.equal(gold.caseSha256,sha256(casesBytes));
  assert.equal(new Set(snapshots.map(s=>s.productSha)).size,1);
  for(const s of snapshots) {
    assert.equal(s.productSha,summary.productSha);
    assert.equal(s.caseSha256,sha256(casesBytes));
    assert.equal(s.policySha256,sha256(policyBytes));
    assert.equal(s.binarySha256,gold.authority[s.binaryKey].binarySha256);
    assert.ok(s.rows.every(r=>r.candidates.every(c=>c.binarySha256===s.binarySha256)));
  }
  let calls=0;
  for(const c of cases) {
    const row=rows.find(r=>r.id===c.id);const input=inputs.get(c.id);const g=golds.get(c.id);
    assert.equal(row.query,c.query);assert.equal(input.query,c.query);assert.equal(row.binary,c.binary);
    assert.equal(row.status,g.status);assert.deepEqual(row.gold,g);
    assert.deepEqual(Object.keys(row.arms).sort(),['A','DET',...ARMS].sort());
    assert.deepEqual(row.funnel,funnel(input,g));
    assert.equal(row.hexCorrect,g.status==='verified'?structuralMatch(input.candidates.find(s=>s.key===input.topKey),g):null);
    assert.ok(input.shortlist.length<=255);
    assert.ok(input.shortlist.every(s=>input.candidates.some(c=>c.key===s.key)));
    for(const [arm,a] of Object.entries(row.arms)) {
      if(ARMS.includes(arm)) {
        assert.equal(a.repeatedKeys.length,policy.repeats);
        assert.equal(a.key,a.repeatedKeys[0]);
        assert.deepEqual(a.repeatedCorrect,a.repeatedKeys.map(key=>g.status==='verified'
          ?structuralMatch(input.candidates.find(s=>s.key===key),g):null));
        assert.equal(a.calls.length,input.routed?policy.repeats:0);
      }
      for(const call of a.calls??[]) {
        calls++;
        assert.equal(call.query,c.query);assert.equal(call.arm,arm);
        const body=requestBody(c.query,input.shortlist,arm);
        assert.deepEqual(call.criteria,body.questions.pick.criteria,'no oracle description leakage');
        assert.equal(call.bodyHash,sha256(JSON.stringify(body)));
        if(!call.error) {
          assert.ok(input.shortlist.some(s=>s.key===call.selectedKey));
          assert.equal(a.repeatedKeys[call.repeat],call.selectedKey);
        } else assert.equal(a.repeatedKeys[call.repeat],input.topKey);
      }
      assert.equal(a.correct,g.status==='verified'?structuralMatch(input.candidates.find(s=>s.key===a.key),g):null);
    }
  }
  for(const arm of Object.keys(summary.summaries))assert.deepEqual(summary.summaries[arm],summarize(rows,arm));
  for(const game of ['openttd','openmw'])for(const arm of Object.keys(summary.perGame[game])) {
    assert.deepEqual(summary.perGame[game][arm],summarize(rows.filter(r=>r.binary===game),arm));
  }
  return {cases:cases.length,verified:gold.cases.filter(g=>g.status==='verified').length,calls,valid:true};
}

function main() {
  const [snapshotsDir,resultsDir]=process.argv.slice(2);
  if(!snapshotsDir||!resultsDir)throw new Error('usage: SNAPSHOTS_DIR RESULTS_DIR');
  const report=path.join(ROOT,'reports/investigations/jev-realgame-final');
  const gold=JSON.parse(fs.readFileSync(path.join(report,'structural-gold.json')));
  const summary=JSON.parse(fs.readFileSync(path.join(resultsDir,'summary.json')));
  const goldBytes=fs.readFileSync(path.join(report,'structural-gold.json'));
  assert.equal(summary.goldSha256,sha256(goldBytes));
  const snapshots=['openttd','openmw'].map(k=>{
    const bytes=readJevEvidence(path.join(snapshotsDir,`${k}.json`));
    assert.equal(summary.snapshotHashes[k],sha256(bytes));return JSON.parse(bytes);
  });
  const result=verifyEvidence({casesBytes:fs.readFileSync(path.join(ROOT,'reports/investigations/jev-real-game-freeform-holdout/holdout-cases.json')),
    gold,policyBytes:fs.readFileSync(path.join(report,'policy-freeze.json')),snapshots,
    rows:readJevEvidence(path.join(resultsDir,'raw-results.jsonl'),'utf8').trim().split('\n').map(JSON.parse),summary});
  console.log(JSON.stringify(result));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main();

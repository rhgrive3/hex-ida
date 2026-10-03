#!/usr/bin/env node
// Independent offline replay of candidate identities and recorded preferences.
// No network client is used; an API response cannot extend the actual lattice.
import fs from 'node:fs';
import path from 'node:path';
import {jevShortlist} from '../js/pinpoint.js';
import {jevValueFlowRequest,jevSemanticRoute,jevMemberContextSignature} from '../js/analysis/query/jev-advisory.js';
import {stabilityRequestBody} from './jev-realgame-stability-contract.mjs';
import {sha256} from './jev-realgame-final-contract.mjs';
import {assertDefaultExecution,DEFAULT_V3_ARMS} from './evaluate-jev-default-v3.mjs';
import {validateChoice} from './jev-realgame-final-client.mjs';
import assert from 'node:assert/strict';

const [snapshotDir,resultDir,freezeFile]=process.argv.slice(2);
if(!snapshotDir||!resultDir||!freezeFile)throw new Error('usage: SNAPSHOTS RESULTS EXECUTION_FREEZE');
const snapshots=['openttd','openmw'].map(game=>JSON.parse(fs.readFileSync(path.join(snapshotDir,`${game}.json`))));
const policy=assertDefaultExecution(snapshots,freezeFile);
const inputs=new Map(snapshots.flatMap(snapshot=>snapshot.rows.map(row=>[row.id,row])));
const report=new URL('../reports/investigations/jev-realgame-final/default-v3/',import.meta.url);
const golds=JSON.parse(fs.readFileSync(new URL('structural-cases.json',report))),byId=new Map(golds.map(gold=>[gold.id,gold]));
const rows=fs.readFileSync(path.join(resultDir,'raw-results.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
const summary=JSON.parse(fs.readFileSync(path.join(resultDir,'summary.json')));
assert.equal(rows.length,50);assert.equal(new Set(rows.map(row=>row.id)).size,50);assert.equal(summary.complete,true);
let calls=0,verified=0;
const matches=(candidate,gold)=>!!candidate&&!candidate.conflict&&gold.identities.some(identity=>
  identity.className===candidate.className&&identity.binarySha256===candidate.binarySha256
  &&identity.offset===candidate.offset&&identity.size===candidate.size);
for(const row of rows) {
  const gold=byId.get(row.id),input=inputs.get(row.id);assert.ok(gold&&input);
  assert.equal(row.query,gold.query);assert.equal(row.status,gold.status);
  const candidates=input.candidates,byKey=new Map(candidates.map(candidate=>[candidate.key,candidate]));
  if(gold.status==='verified') {
    verified++;assert.equal(row.funnel.recovered,input.recovered.some(candidate=>matches(candidate,gold)));
    assert.equal(row.funnel.lattice,input.published.some(candidate=>matches(candidate,gold)));
    assert.equal(row.funnel.shortlist,input.shortlist.some(candidate=>matches(candidate,gold)));
  }
  for(const arm of DEFAULT_V3_ARMS) {
    const recorded=row.arms[arm],selective=arm==='S';
    assert.ok(recorded);const baseline=selective?input.stableTopKey:input.topKey;
    const pool=selective?candidates.filter(candidate=>!candidate.conflict):candidates;
    const shortlist=jevShortlist(pool,{max:255});
    const route=selective?jevSemanticRoute(row.query,pool,{verdict:input.verdict,topKey:input.stableTopKey}):null;
    const repeatCount=['A','R1'].includes(arm)?1:policy.repeats;
    assert.equal(recorded.repeatedKeys.length,repeatCount);
    for(let repeat=0;repeat<repeatCount;repeat++) {
      const call=recorded.calls.find(call=>call.repeat===repeat);let expected=['A','R1'].includes(arm)?(arm==='A'?input.topKey:input.stableTopKey):baseline;
      if(call) {
        calls++;assert.ok(input.routed);if(selective)assert.ok(route.call);
        const body=['V3','S'].includes(arm)?jevValueFlowRequest(row.query,shortlist):stabilityRequestBody(row.query,shortlist,arm);
        assert.equal(call.bodyHash,sha256(JSON.stringify(body)));assert.deepEqual(call.criteria,body.questions.pick.criteria);
        assert.equal(call.attempts.length,1);assert.equal(call.attempts[0].number,1);
        if(!call.error) {
          assert.equal(validateChoice(call.response,shortlist.length),null);
          const index=Number(call.response.answers.pick.choice.slice(1)),selected=shortlist[index];
          assert.equal(call.selectedKey,selected.key);assert.equal(call.choiceIndex,index);
          expected=selected.key;
          if(['V3','S'].includes(arm)&&selected.conflict)expected=baseline;
          if(selective&&pool.some(candidate=>candidate.key!==selected.key
            &&jevMemberContextSignature(candidate)===jevMemberContextSignature(selected)))expected=baseline;
        }
      }
      assert.equal(recorded.repeatedKeys[repeat],expected);
      assert.equal(recorded.repeatedCorrect[repeat],gold.status==='verified'?matches(byKey.get(expected),gold):null);
    }
    assert.equal(recorded.key,recorded.repeatedKeys[0]);assert.equal(recorded.correct,recorded.repeatedCorrect[0]);
  }
}
assert.equal(verified,40);
for(const arm of DEFAULT_V3_ARMS) {
  const verifiedRows=rows.filter(row=>row.status==='verified'),s=summary.summaries[arm],local=summary.vsR1[arm];
  assert.equal(s.top1,verifiedRows.filter(row=>row.arms[arm].correct).length);
  assert.equal(s.rescue,verifiedRows.filter(row=>!row.arms.A.correct&&row.arms[arm].correct).length);
  assert.equal(s.regression,verifiedRows.filter(row=>row.arms.A.correct&&!row.arms[arm].correct).length);
  assert.equal(local.rescue,verifiedRows.filter(row=>!row.arms.R1.correct&&row.arms[arm].correct).length);
  assert.equal(local.regression,verifiedRows.filter(row=>row.arms.R1.correct&&!row.arms[arm].correct).length);
  assert.equal(local.net,local.rescue-local.regression);
}
console.log(JSON.stringify({independentReplay:'PASS',queries:50,verified:40,recordedCalls:calls,
  sourceAndManifestBinding:true,structuralScoring:true,actualCandidateOnly:true}));

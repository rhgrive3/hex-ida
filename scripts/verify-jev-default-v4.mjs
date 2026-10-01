#!/usr/bin/env node
// Offline independent replay: recorded responses may never add binary facts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {jevShortlist} from '../js/pinpoint.js';
import {jevArgumentFlowRequest,jevSemanticRoute,jevVisibleArgumentContextSignature} from '../js/analysis/query/jev-advisory.js';
import {cxxObjectSemanticScores,compareCxxSemanticScores} from '../js/analysis/query/cxx-semantic-preference.js';
import {stabilityRequestBody} from './jev-realgame-stability-contract.mjs';
import {assertV4Execution,V4_ARMS} from './jev-default-v4-contract.mjs';
import {validateChoice} from './jev-realgame-final-client.mjs';
import {sha256} from './jev-realgame-final-contract.mjs';

const [snapshotDir,resultDir,freezeFile]=process.argv.slice(2);
if(!snapshotDir||!resultDir||!freezeFile)throw new Error('usage: SNAPSHOTS RESULTS EXECUTION_FREEZE');
const {policy,snapshots,cases}=assertV4Execution(snapshotDir,freezeFile);
const inputs=new Map(snapshots.flatMap(s=>s.rows.map(row=>[row.id,row]))),golds=new Map(cases.map(g=>[g.id,g]));
const rows=fs.readFileSync(path.join(resultDir,'raw-results.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
const summary=JSON.parse(fs.readFileSync(path.join(resultDir,'summary.json')));
assert.equal(rows.length,50);assert.equal(new Set(rows.map(row=>row.id)).size,50);assert.equal(summary.complete,true);
assert.equal(policy.repeats,3);assert.equal(summary.repeats,3);
assert.equal(summary.primaryRepeat,0);assert.equal(summary.majorityVoting,false);
assert.equal(summary.finalPolicy,'PENDING_PRESERVATION_AND_EXACT_HEAD_GATES');
assert.equal(summary.collectionRevision,snapshots[0].productSha);
assert.equal(summary.policySha256,JSON.parse(fs.readFileSync(freezeFile)).policySha256);
assert.equal(summary.executionFreezeSha256,sha256(fs.readFileSync(freezeFile)));
const pcts=values=>{
  const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b);
  const at=fraction=>sorted.length?sorted[Math.max(0,Math.ceil(sorted.length*fraction)-1)]:null;
  return {count:sorted.length,p50:at(.5),p95:at(.95),p99:at(.99)};
};
assert.deepEqual(summary.coldRecoveryLatency,pcts(rows.map(row=>row.recovery.elapsedMs)));
const matches=(candidate,gold)=>!!candidate&&!candidate.conflict&&gold.status==='verified'&&gold.identities.some(i=>
  candidate.className===i.className&&candidate.binarySha256===i.binarySha256&&candidate.offset===i.offset&&candidate.size===i.size
  &&!(candidate.recoveredType?.proven===true&&i.allowedCategories?.length&&!i.allowedCategories.includes(candidate.recoveredType.category)));
let callCount=0;
for(const row of rows) {
  const input=inputs.get(row.id),gold=golds.get(row.id);assert.ok(input&&gold);
  assert.equal(row.query,gold.query);assert.equal(row.status,gold.status);assert.equal(row.binary,gold.binary);
  const byKey=new Map(input.candidates.map(c=>[c.key,c]));
  const scored=cxxObjectSemanticScores(input.query,input.candidates).sort(compareCxxSemanticScores);
  assert.equal(input.candidates.length,byKey.size);
  assert.equal(row.arms.O4.key,scored[0]?.score>0||scored[0]?.objectMatches>0?scored[0].key:input.topKey);
  if(gold.status==='verified') {
    assert.equal(row.funnel.recovered,input.recovered.some(c=>matches(c,gold)));
    assert.equal(row.funnel.lattice,input.published.some(c=>matches(c,gold)));
    assert.equal(row.funnel.shortlist,input.shortlist.some(c=>matches(c,gold)));
  }
  assert.equal(row.arms.A.key,input.topKey);assert.equal(row.arms.A0.key,input.recovery.baseline?.topKey??null);
  assert.equal(row.arms.R1.key,input.stableTopKey);
  for(const arm of V4_ARMS) {
    const result=row.arms[arm],local=['A0','A','R1','O4'].includes(arm),selective=arm==='S4';
    const pool=selective?input.candidates.filter(c=>!c.conflict):input.candidates,shortlist=jevShortlist(pool,{max:255});
    const route=selective?jevSemanticRoute(row.query,pool,{topKey:input.topKey,verdict:input.verdict,policy:'object-context-v4'}):null;
    assert.equal(result.repeatedKeys.length,local?1:policy.repeats);
    for(let repeat=0;repeat<result.repeatedKeys.length;repeat++) {
      const call=result.calls.find(call=>call.repeat===repeat);let expected=local?result.key:input.topKey;
      if(call) {
        callCount++;assert.ok(input.routed);if(selective)assert.ok(route.call);
        assert.equal(call.rawCorrect,gold.status==='verified'?matches(byKey.get(call.selectedKey),gold):null);
        const body=['V4','S4'].includes(arm)?jevArgumentFlowRequest(row.query,shortlist):stabilityRequestBody(row.query,shortlist,arm);
        assert.equal(call.bodyHash,sha256(JSON.stringify(body)));assert.deepEqual(call.criteria,body.questions.pick.criteria);
        assert.equal(call.attempts.length,1);assert.equal(call.attempts[0].number,1);
        if(!call.error) {
          assert.equal(validateChoice(call.response,shortlist.length),null);
          const index=Number(call.response.answers.pick.choice.slice(1)),selected=shortlist[index];
          assert.equal(call.selectedKey,selected.key);assert.equal(call.choiceIndex,index);
          const contextUnsafe=selected.conflict||selected.functionContexts?.some(c=>c.writtenArgumentBitsTruncated===true);
          const equivalent=selective&&pool.some(peer=>peer.key!==selected.key&&peer.className===selected.className
            &&jevVisibleArgumentContextSignature(row.query,peer)===jevVisibleArgumentContextSignature(row.query,selected));
          if(!['V4','S4'].includes(arm)||!contextUnsafe&&!equivalent)expected=selected.key;
        }
        assert.equal(call.committedKey,expected);
      } else if(!local&&input.routed&&(!selective||route.call)) {
        // Production's deterministic strong/shortlist paths can avoid a call.
        assert.ok(shortlist.length<2||['confirmed','likely'].includes(input.verdict));
      }
      assert.equal(result.repeatedKeys[repeat],expected);
      assert.equal(result.repeatedCorrect[repeat],gold.status==='verified'?matches(byKey.get(expected),gold):null);
    }
    assert.equal(result.key,result.repeatedKeys[0]);assert.equal(result.correct,result.repeatedCorrect[0]);
  }
}
for(const [section,baseline] of [['summaries','A'],['vsBeforeExtension','A0'],['vsBestDeterministic','O4']]) {
  const answerable=rows.filter(row=>row.status==='verified');
  for(const arm of V4_ARMS) {
    const s=summary[section][arm];
    assert.equal(s.answerable,40);assert.equal(s.hexTop1,answerable.filter(row=>row.arms[baseline].correct).length);
    assert.equal(s.top1,answerable.filter(row=>row.arms[arm].correct).length);
    assert.equal(s.rescue,answerable.filter(row=>!row.arms[baseline].correct&&row.arms[arm].correct).length);
    assert.equal(s.regression,answerable.filter(row=>row.arms[baseline].correct&&!row.arms[arm].correct).length);
    assert.equal(s.net,s.rescue-s.regression);
    assert.equal(s.baselineDestructionRate,s.hexTop1?s.regression/s.hexTop1:null);
    const calls=rows.flatMap(row=>row.arms[arm].calls),attempts=calls.flatMap(call=>call.attempts);
    assert.equal(s.apiCalls,calls.length);assert.equal(s.apiAttempts,attempts.length);
    assert.equal(s.apiFailures,calls.filter(call=>call.error).length);
    assert.equal(s.apiErrorRate,calls.length?s.apiFailures/calls.length:null);
    assert.equal(s.timeouts,attempts.filter(attempt=>attempt.error==='timeout').length);
    assert.equal(s.retries,attempts.filter(attempt=>attempt.number>1).length);
    assert.deepEqual(s.apiAddedLatency,pcts(calls.map(call=>call.addedLatencyMs)));
    assert.deepEqual(s.hexLatency,pcts(rows.map(row=>row.hexLatencyMs)));
    assert.equal(s.structurallyRecovered,answerable.filter(row=>row.funnel.recovered).length);
    assert.equal(s.goldInLattice,answerable.filter(row=>row.funnel.lattice).length);
    assert.equal(s.goldInShortlist,answerable.filter(row=>row.funnel.shortlist).length);
    assert.equal(s.unreachableBecauseNotRecovered,answerable.filter(row=>!row.funnel.recovered).length);
    assert.equal(s.recoveredButNotPublished,answerable.filter(row=>row.funnel.recovered&&!row.funnel.lattice).length);
    assert.equal(s.publishedButOutsideShortlist,answerable.filter(row=>row.funnel.lattice&&!row.funnel.shortlist).length);
    assert.deepEqual(s.unstableCases,rows.filter(row=>new Set(row.arms[arm].repeatedKeys).size>1).map(row=>row.id));
    assert.deepEqual(s.destructiveUnstableCases,answerable.filter(row=>row.arms[baseline].correct
      &&row.arms[arm].repeatedCorrect.includes(false)).map(row=>row.id));
    for(const game of ['openttd','openmw']) {
      const group=answerable.filter(row=>row.binary===game),g=summary.perGame[game][baseline][arm];
      assert.equal(g.answerable,20);assert.equal(g.top1,group.filter(row=>row.arms[arm].correct).length);
      assert.equal(g.regression,group.filter(row=>row.arms[baseline].correct&&!row.arms[arm].correct).length);
      assert.equal(g.rescue,group.filter(row=>!row.arms[baseline].correct&&row.arms[arm].correct).length);
    }
  }
}
assert.equal(summary.rawRemoteHighConfidenceErrors,rows.reduce((count,row)=>count+row.arms.V4.calls.filter(call=>
  row.status==='verified'&&call.rawCorrect===false&&call.response?.answers?.pick?.confidence>=.9
  &&call.response?.answers?.unique?.noul>=.9).length,0));
console.log(JSON.stringify({independentReplay:'PASS',queries:50,verified:40,recordedCalls:callCount,
  sourceAndManifestBinding:true,actualCandidateOnly:true,originalHexBaselinePreserved:true}));

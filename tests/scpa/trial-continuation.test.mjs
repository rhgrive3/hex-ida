// Persistence is transport, never independent competitor admission.
import test from 'node:test';
import assert from 'node:assert/strict';
import { trialFixture as fixture, trialHosts as hosts } from './trial-fixture.mjs';
import { workFor } from './helpers.mjs';
import { runAstraTrials, packAstraTrialContinuation, validateAstraTrialContinuation, createAstraTrialPlan, reviewAstraTrialReadiness } from '../../js/analysis/benchmark/scoped-trials.js';
import { createCompetitiveProtocol } from '../../js/analysis/benchmark/competitive-protocol.js';
import { protocolInput, rowsFor } from './benchmark-fixture.mjs';
import { stableDigest, stableStringify, lossyTypeWitness } from '../../js/core/identity/index.js';
const wire = value => JSON.parse(JSON.stringify(value));
function reseal(result) { const { integrityDigest, ...progress } = result.progress;
  const value = { ...result, progress }; result.progress.integrityDigest = stableDigest({value,typed:lossyTypeWitness(value)}); return result; }
async function run(t, f, h, options = {}) { return runAstraTrials(f.plan, f.protocols, { ...h, work:workFor(t,{calls:4096,workUnits:100000,residentBytes:16777216,deadlineMs:20000}), ...options }); }
test('serialized continuation finishes the full denominator once without replaying consumed cells', async t => {
  const f = fixture(), h = hosts(f), first = await run(t,f,h,{maximumTrials:7});
  assert.equal(first.progress.nextOrdinal,7); assert.equal(first.attempted,7);
  const frozenInput = JSON.stringify(first), imported = wire(first);
  const second = await run(t,f,h,{maximumTrials:9,resumeFrom:imported});
  assert.equal(second.progress.nextOrdinal,16); assert.equal(second.progress.attemptedTotal,16);
  assert.equal(second.progress.historyProvenance,'imported-unadmitted');
  assert.equal(JSON.stringify(imported),frozenInput);
  const last = await run(t,f,h,{maximumTrials:8,resumeFrom:wire(second)});
  assert.equal(last.denominator,24); assert.equal(last.trials.length,24);
  assert.equal(last.progress.nextOrdinal,24); assert.equal(last.progress.attemptedTotal,24);
  assert.equal(h.stats().queries,24); assert.equal(h.stats().closes,24);
  assert.ok(last.trials.every(row=>row.executionState==='executed-unadjudicated'));
  const noop = await run(t,f,h,{resumeFrom:wire(last)});
  assert.equal(noop.attempted,0); assert.equal(h.stats().queries,24);
  assert.equal(reviewAstraTrialReadiness(f.plan,noop).verdict,'NOT-YET');
  assert.equal(last.releaseQualified,false);
});
test('more than the 256-cell invocation cap is completed in separate bounded batches', async t => {
  const protocols = Object.fromEntries(['T0','T1','T2','T3'].map(mode=>{
    const raw=protocolInput();raw.repetitions=6;
    raw.track={T0:'scripted-substrate',T1:'native-best',T2:'knowledge-equalized',T3:'native-best'}[mode];
    return [mode,createCompetitiveProtocol(raw)];
  }));
  const config={...fixture().config,cacheStates:['cold','warm']}, plan=createAstraTrialPlan(protocols,config), f={plan,protocols}, h=hosts(f);
  assert.equal(plan.denominator,288);
  const first=await run(t,f,h,{maximumTrials:256});assert.equal(first.progress.nextOrdinal,256);
  const last=await run(t,f,h,{maximumTrials:256,resumeFrom:wire(first)});
  assert.equal(last.progress.nextOrdinal,288);assert.equal(last.attempted,32);assert.equal(h.stats().queries,288);
  assert.equal(new Set(last.trials.map(r=>r.id)).size,288);assert.equal(last.minimumRepetitionsExecuted,true);
  assert.equal(last.victoryEstablished,false);
});
test('cross-batch namespace reuse is refused before another query', async t => {
  const f=fixture(), first=await run(t,f,hosts(f),{maximumTrials:1});
  const h=hosts(f),second=await run(t,f,h,{maximumTrials:1,resumeFrom:wire(first)});
  assert.match(second.trials[1].reason,/namespace-reuse/);assert.equal(h.stats().queries,0);
  assert.equal(second.progress.nextOrdinal,2);
});
test('a T2 knowledge mismatch in a later batch retracts earlier candidate measurements', async t => {
  const f=fixture();
  const h=hosts(f,(context,trial)=>{if(trial.ordinal===7){const prepare=context.prepare;context.prepare=async()=>{
    const p=await prepare();p.knowledge.manifestSha256='f'.repeat(64);return p;
  };}});
  const adjudicate=({trial},{protocol})=>rowsFor(protocol).filter(r=>r.caseId===trial.caseId&&r.participantId===trial.participantId&&r.repetition===trial.repetition&&r.cacheState===trial.cacheState);
  const first=await run(t,f,{...h,adjudicate},{maximumTrials:7});
  assert.equal(first.trials[6].mode,'T2');assert.ok(first.trials[6].measurements.length>0);
  const next=await run(t,f,{...h,adjudicate},{maximumTrials:2,resumeFrom:wire(first)});
  assert.ok(next.trials.slice(6,9).every(r=>r.reason==='paired-common-information-control-mismatch'&&r.measurements.length===0));
  assert.ok(!next.measurements.some(r=>r.trialId===first.trials[6].id));
  assert.equal(first.trials[6].executionState,'executed-unadjudicated');
  validateAstraTrialContinuation(f.plan,f.protocols,wire(next));
});
test('failed and unavailable cells are consumed, not implicitly retried after resume',async t=>{
  const f=fixture(),h=hosts(f,c=>{c.adapter.query=async()=>{throw new Error('intentional-test-failure');};});
  const first=await run(t,f,h,{maximumTrials:1});
  const next=await run(t,f,{getAdapter:()=>null},{maximumTrials:1,resumeFrom:wire(first)});
  assert.equal(next.trials[0].state,'FAILED');assert.equal(next.trials[1].state,'UNAVAILABLE');
  assert.equal(next.progress.nextOrdinal,2);assert.equal(next.attempted,1);
});
for (const [name, error, expected] of [
  ['empty error', new Error(''), 'astra-trial-host-failed'],
  ['multiline error', new Error('host response\nPRIVATE_DETAIL'), 'astra-trial-host-failed'],
  ['trailing newline', new Error('host-error\n'), 'astra-trial-host-failed'],
  ['padded error', new Error(' host-error '), 'astra-trial-host-failed'],
  ['control character', new Error('host\u0000error'), 'astra-trial-host-failed'],
  ['overlong code', new Error('x'.repeat(513)), 'astra-trial-host-failed'],
  ['null rejection', null, 'astra-trial-host-failed'],
  ['undefined rejection', undefined, 'astra-trial-host-failed'],
  ['string rejection', 'PRIVATE_DETAIL', 'astra-trial-host-failed'],
  ['non-string code', { code: { toString() { throw new Error('must-not-coerce'); } } }, 'astra-trial-host-failed'],
  ['valid diagnostic', new Error('host-temporarily-unavailable'), 'host-temporarily-unavailable'],
  ['valid code', Object.assign(new Error('host response\nPRIVATE_DETAIL'), { code: 'HOST_UNAVAILABLE:1' }), 'HOST_UNAVAILABLE:1'],
]) test(`a ${name} preserves a resumable failed cell without replay or host text`, async t => {
  const f = fixture(), h = hosts(f, (context, trial) => {
    if (trial.ordinal === 0) context.adapter.query = async () => { throw error; };
  });
  const first = await run(t, f, h, { maximumTrials: 1 });
  assert.equal(first.trials[0].state, 'FAILED');
  assert.equal(first.trials[0].executionState, 'failed-during-execution');
  assert.equal(first.trials[0].reason, expected);
  assert.equal(first.progress.nextOrdinal, 1);
  const packed = wire(packAstraTrialContinuation(f.plan, first));
  assert.ok(!JSON.stringify(packed).includes('PRIVATE_DETAIL'));
  assert.equal(stableStringify(validateAstraTrialContinuation(f.plan, f.protocols, packed)), stableStringify(first));
  const next = await run(t, f, h, { maximumTrials: 1, resumeFrom: packed });
  assert.deepEqual(next.trials[0], first.trials[0]);
  assert.equal(next.trials[1].executionState, 'executed-unadjudicated');
  assert.deepEqual(next.trials.slice(2), first.trials.slice(2));
  assert.equal(next.progress.nextOrdinal, 2);
  assert.equal(next.progress.attemptedTotal, 2);
  assert.equal(next.trials.length, f.plan.denominator);
  assert.equal(h.stats().queries, 1);
  assert.equal(h.stats().closes, 2);
  assert.equal(next.releaseQualified, false);
});
for (const method of ['cancel', 'close']) for (const rejection of [null, undefined, false, 0, '']) {
  test(`${method} rejecting ${String(rejection)} invalidates candidates and keeps a resumable denominator`, async t => {
    const f = fixture(), calls = { cancel: 0, close: 0 };
    const h = hosts(f, (context, trial) => {
      if (trial.ordinal !== 0) return;
      const cancel = context.adapter.cancel, close = context.close;
      context.adapter.cancel = async () => {
        calls.cancel++;
        if (method === 'cancel') throw rejection;
        return cancel();
      };
      context.close = async options => {
        calls.close++;
        if (method === 'close') throw rejection;
        return close(options);
      };
    });
    let offered = 0;
    const first = await run(t, f, { ...h, adjudicate: ({ trial }, { protocol }) => {
      const candidates = rowsFor(protocol).filter(row => row.caseId === trial.caseId && row.participantId === trial.participantId
        && row.repetition === trial.repetition && row.cacheState === trial.cacheState);
      offered += candidates.length;
      return candidates;
    } }, { maximumTrials: 1 });
    assert.ok(offered > 0);
    assert.deepEqual(calls, { cancel: 1, close: 1 });
    assert.equal(first.trials[0].state, 'FAILED');
    assert.equal(first.trials[0].executionState, 'invalidated-cleanup');
    assert.deepEqual(first.trials[0].cleanup, { status: 'unconfirmed', reason: 'cleanup-failed' });
    assert.deepEqual(first.trials[0].measurements, []);
    assert.deepEqual(first.measurements, []);
    const packed = wire(packAstraTrialContinuation(f.plan, first));
    assert.equal(stableStringify(validateAstraTrialContinuation(f.plan, f.protocols, packed)), stableStringify(first));
    const next = await run(t, f, h, { maximumTrials: 1, resumeFrom: packed });
    assert.deepEqual(next.trials[0], first.trials[0]);
    assert.equal(next.trials[1].executionState, 'executed-unadjudicated');
    assert.deepEqual(next.trials.slice(2), first.trials.slice(2));
    assert.equal(next.progress.nextOrdinal, 2);
    assert.equal(next.trials.length, f.plan.denominator);
    assert.equal(h.stats().queries, 2);
    assert.deepEqual(calls, { cancel: 1, close: 1 });
    assert.equal(next.releaseQualified, false);
  });
}
for (const [name,mutate] of [
  ['digest',r=>r.trials[0].responseDigest='changed'],
  ['denominator',r=>{r.denominator--;reseal(r);}],
  ['missing cell',r=>{r.trials.pop();reseal(r);}],
  ['duplicate cell',r=>{r.trials[1]=wire(r.trials[0]);reseal(r);}],
  ['frontier outside plan',r=>{r.progress.nextOrdinal=4097;reseal(r);}],
  ['frontier over unprocessed tail',r=>{r.progress.nextOrdinal=24;reseal(r);}],
  ['top-level release',r=>{r.releaseQualified=true;reseal(r);}],
  ['row oracle',r=>{r.trials[0].oracleAuthority=true;reseal(r);}],
  ['row measured',r=>{r.trials[0].state='MEASURED';reseal(r);}],
  ['wrong preparation',r=>{r.trials[0].preparation.binding.binarySha256='f'.repeat(64);reseal(r);}],
  ['invented measurements',r=>{r.trials[0].measurements=['invented'];reseal(r);}],
])test(`rejects ${name} before invoking a host`,async t=>{
  const f=fixture(),first=await run(t,f,hosts(f),{maximumTrials:1}),raw=wire(first);mutate(raw);
  let calls=0;await assert.rejects(run(t,f,{getAdapter:()=>{calls++;return null;}},{resumeFrom:raw}));assert.equal(calls,0);
});
test('changing plan or serializing a legacy report cannot silently start a fresh run',async t=>{
  const f=fixture(),first=await run(t,f,hosts(f),{maximumTrials:1});
  const changed={...f,plan:createAstraTrialPlan(f.protocols,{...f.config,seed:72})};
  await assert.rejects(run(t,changed,hosts(changed),{resumeFrom:wire(first)}),/continuation/);
  const legacy=wire(first);delete legacy.progress;
  await assert.rejects(run(t,f,hosts(f),{resumeFrom:legacy}),/continuation/);
});


test('plan-relative journal restores all bytes of evidence and rejects duplicate context',async t=>{
  const f=fixture(),h=hosts(f),result=await run(t,f,h,{maximumTrials:12});
  const packed=packAstraTrialContinuation(f.plan,result),restored=validateAstraTrialContinuation(f.plan,f.protocols,wire(packed));
  assert.equal(stableStringify(restored),stableStringify(result));
  assert.ok(JSON.stringify(packed).length<JSON.stringify(result).length);
  const forged=wire(packed);forged.trials[0].binarySha256='f'.repeat(64);
  assert.throws(()=>validateAstraTrialContinuation(f.plan,f.protocols,forged),/pack-duplicate/);
  const wrongPlan=createAstraTrialPlan(f.protocols,{...f.config,seed:72});
  assert.throws(()=>validateAstraTrialContinuation(wrongPlan,f.protocols,wire(packed)),/pack-binding/);
  const next=await run(t,f,h,{maximumTrials:12,resumeFrom:wire(packed)});
  assert.equal(next.progress.nextOrdinal,24);assert.equal(h.stats().queries,24);
});

test('a synthetic 2304-cell scale plan survives nine bounded wire checkpoints without dropping a cell', {timeout:20000},async t=>{
  const protocols=Object.fromEntries(['T0','T1','T2','T3'].map(mode=>{
    const raw=protocolInput();raw.repetitions=48;
    raw.track={T0:'scripted-substrate',T1:'native-best',T2:'knowledge-equalized',T3:'native-best'}[mode];
    return [mode,createCompetitiveProtocol(raw)];
  }));
  // This checks checkpoint persistence, not sub-100ms host latency. Keep the
  // production's finite default budgets when the full suite competes for CPU;
  // dedicated timeout tests continue to use the short deadline fixture.
  const config={...fixture().config,resources:{},cacheStates:['cold','warm']};
  const plan=createAstraTrialPlan(protocols,config),f={plan,protocols},h=hosts(f);
  assert.equal(plan.denominator,2304);
  let result=null;
  for(let batch=0;batch<9;batch++){
    result=await run(t,f,h,{maximumTrials:256,resumeFrom:result?wire(packAstraTrialContinuation(plan,result)):null});
    assert.equal(result.progress.nextOrdinal,(batch+1)*256);
    assert.equal(result.attempted,256);
    assert.equal(result.trials.length,2304);
    const failed=result.trials.filter(row=>row.state==='FAILED');
    assert.equal(failed.length,0,JSON.stringify(failed.slice(0,8).map(({ordinal,reason,executionState,cleanup})=>({ordinal,reason,executionState,cleanup}))));
  }
  const packed=packAstraTrialContinuation(plan,result);
  const restored=validateAstraTrialContinuation(plan,protocols,wire(packed));
  assert.equal(stableStringify(restored),stableStringify(result));
  assert.equal(h.stats().queries,2304);assert.equal(h.stats().closes,2304);
  assert.equal(new Set(result.trials.map(row=>row.id)).size,2304);
  assert.ok(result.trials.every(row=>row.executionState==='executed-unadjudicated'));
  assert.equal(result.measurements.length,0);assert.equal(result.releaseQualified,false);
  assert.equal(reviewAstraTrialReadiness(plan,result).verdict,'NOT-YET');
  t.diagnostic(JSON.stringify({fixtureOnly:true,composition:'2 synthetic cases x 48 repetitions x 3 test adapters x 4 modes x 2 caches',denominator:2304,batches:9,packedBytes:Buffer.byteLength(JSON.stringify(packed)),realCompetitorMeasurements:0}));
});

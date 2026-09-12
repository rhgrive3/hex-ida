import assert from 'node:assert/strict';
import test from 'node:test';
import { conditionalRegionFixture } from '../helpers/conditional-region-fixture.mjs';
import { identity } from '../helpers/proof-fixtures.mjs';
import { prepareConditionalRegionStructure } from '../../../js/decompiler/phase8/conditional-region-structure.js';
import { prepareConditionalRegionErasure, readConditionalRegionErasure } from '../../../js/decompiler/phase8/conditional-region-erasure.js';
import { REGION_ERASURE_PASS, runRegionErasurePass, readProvedRegionErasure } from '../../../js/decompiler/phase8/region-erasure-pass.js';
import { seedAnalysisState, createAnalysisState, forkAnalysisState, commitAnalysisState, runPassTransaction,
  runPhase8Vertical, phase8RewriteRegistry, createPassDescriptor, createPassResult } from '../../../js/decompiler/phase8/index.js';

async function prepared(options) {
  const armEffect = (builder, value) => {
    const store = builder.store(value, { locKind:'global', locKey:'g', bits:8 });
    Object.assign(store.loc, { address:16n, addressSpace:'data' });
    store.extra = { completeness:'complete', addressPrecise:true, memoryAccess:{ addressSpace:'data', widthBits:8,
      volatility:false, atomic:false, ordering:'unknown', endian:'little', faults:[] } };
  };
  const f = conditionalRegionFixture({ armEffect, ...options }), reachability = await f.run();
  assert.equal(reachability.status, 'complete', reachability.reason);
  const plan = prepareConditionalRegionErasure(f.structure, reachability, f.ir, { identity, timeoutMs:5000 });
  return { ...f, reachability, plan, context:{ ir:f.ir, proofIdentity:identity, regionErasurePlan:plan } };
}
const pass = { descriptor:REGION_ERASURE_PASS, run:runRegionErasurePass };

for (const kind of ['cbz','cbnz']) test(`issued ${kind} erasure retains header, live arm, CFG and all PHIs`, async () => {
  const f = await prepared({ kind }), p = f.plan;
  assert.equal(p.status, 'complete', p.reason);
  assert.equal(p.transformAuthorization, false);
  assert.equal(p.renderValidation, 'required');
  const dead = f.region.arms.find(arm => arm.role === p.removedRole);
  assert.equal(p.removedNodes, dead.nodes);
  assert.deepEqual(p.candidateNodes, f.region.nodes.filter(node => !dead.nodes.includes(node)));
  assert.equal(p.retainedHeader, f.region.header);
  assert.ok(p.candidateNodes.includes(f.region.close));
  assert.ok(p.candidateNodes.includes(f.region.separator));
  assert.equal(p.retainedInstructions, f.structure.instructions);
  assert.equal(p.retainedPhis, f.structure.phis);
  assert.equal(p.retainedMemoryPhis, f.structure.memoryPhis);
  assert.equal(p.retainedEdges, f.structure.cfgEdges);
  assert.equal(readConditionalRegionErasure(p, f.ir, identity), p);
  assert.equal(readConditionalRegionErasure({ ...p }, f.ir, identity), null);
});

test('a valid proof cannot be paired with another structure from the same IR', async () => {
  const f = await prepared(), other = prepareConditionalRegionStructure(f.region.record, f.ir, { identity, timeoutMs:5000 });
  assert.equal(other.status, 'complete');
  assert.equal(prepareConditionalRegionErasure(other, f.reachability, f.ir, { identity }).reason, 'unbound-region-reachability');
  const live = await prepared({ predicate:'input' });
  assert.equal(live.plan.reason, 'no-single-unreachable-arm');
});

test('the canonical vertical registers and commits region authority separately from scalar proofs', async () => {
  const f = await prepared(); assert.equal(f.plan.status, 'complete', f.plan.reason);
  const result = runPhase8Vertical({ ...f.context, enabledStages:['rendering'] }, { timeBudgetMs:1000 });
  assert.equal(result.ledger.published, true, JSON.stringify(result.ledger));
  assert.equal(readProvedRegionErasure(result.analysis, f.context), f.plan);
  assert.equal(result.analysis.get('provedRewrites'), null);
  assert.equal(result.analysis.get('provedRegions').transformAuthorization, false);
  assert.equal(result.analysis.get('provedRegions').renderValidation, 'required');
  assert.equal(result.ledger.passes.at(-1).transforms[0].kind, 'proved-unreachable-arm-candidate');
  assert.equal(phase8RewriteRegistry().filter(row => row.passId === REGION_ERASURE_PASS.id).length, 1);
});

test('canonical reachability never upgrades observed C condition text to render equivalence', async () => {
  const f = await prepared({ kind:'cbnz' });
  assert.equal(f.region.header.text, 'if (a1 ^ a1 != 0) {');
  const x = 2n;
  const canonicalTaken = (x ^ x) !== 0n;
  // C equality binds more tightly than bitwise XOR. These are different
  // expressions even though the current emitter names the correct CBR.
  const renderedTaken = (x ^ BigInt(x !== 0n)) !== 0n;
  assert.notEqual(canonicalTaken, renderedTaken);
  assert.equal(f.plan.status, 'complete');
  assert.equal(f.plan.transformAuthorization, false);
  assert.ok(f.plan.pendingValidation.includes('rendered-condition-equivalence'));
  const output = runPhase8Vertical({ ...f.context, enabledStages:['rendering'] }, { timeBudgetMs:1000 });
  assert.equal(output.ledger.published, true);
  assert.equal(output.analysis.get('provedRegions').transformAuthorization, false);
  assert.ok(f.plan.removedNodes.every(node => f.seed.lines.includes(node)));
});

test('copied plans, copied results and manually seeded overlays cannot mint region authority', async () => {
  const f = await prepared(), state = seedAnalysisState(f.ir), before = state.snapshot();
  assert.equal(runPassTransaction(state, pass, { ...f.context, regionErasurePlan:{ ...f.plan } }, {}).committed, false);
  assert.deepEqual(state.snapshot(), before);
  const copiedResult = { descriptor:REGION_ERASURE_PASS, run(c,b,a) { return { ...runRegionErasurePass(c,b,a) }; } };
  assert.equal(runPassTransaction(state, copiedResult, f.context, {}).committed, false);
  assert.deepEqual(state.snapshot(), before);
  assert.equal(runPassTransaction(state, pass, f.context, {}).committed, true);
  const forged = createAnalysisState({ provedRegions:state.get('provedRegions') });
  assert.equal(readProvedRegionErasure(forged, f.context), null);
});

test('a different pass cannot stage a genuine region overlay under its own authority', async () => {
  const f = await prepared(), source = seedAnalysisState(f.ir);
  assert.equal(runPassTransaction(source, pass, f.context, {}).committed, true);
  const descriptor = createPassDescriptor({ id:'other-region-pass', version:'1', stage:'rendering', produces:['provedRegions'] });
  const other = { descriptor, run(c,b,a) { a.stage('provedRegions', source.get('provedRegions'));
    return createPassResult({ descriptor, status:'changed', produced:['provedRegions'] }); } };
  const target = seedAnalysisState(f.ir), before = target.snapshot();
  assert.equal(runPassTransaction(target, other, f.context, {}).stopReason, 'region-proof-pass-mismatch');
  assert.deepEqual(target.snapshot(), before);
});

test('fork and vertical commit preserve region authority while later invalidation removes it', async () => {
  const f = await prepared(), state = seedAnalysisState(f.ir), before = state.snapshot(), working = forkAnalysisState(state);
  assert.equal(runPassTransaction(working, pass, f.context, {}).committed, true);
  assert.equal(readProvedRegionErasure(state, f.context), null);
  assert.equal(commitAnalysisState(state, working, before), true);
  assert.equal(readProvedRegionErasure(state, f.context), f.plan);
  const descriptor = createPassDescriptor({ id:'invalidate-region', version:'1', stage:'rendering', produces:['ranges'] });
  const invalidator = { descriptor, run(c,b,a) { a.stage('ranges', {}); return createPassResult({ descriptor, status:'changed', produced:['ranges'] }); } };
  assert.equal(runPassTransaction(state, invalidator, f.context, {}).committed, true);
  assert.equal(readProvedRegionErasure(state, f.context), null);
});

test('mutation in the final budget callback refuses the complete region transaction', async () => {
  const f = await prepared(), state = seedAnalysisState(f.ir), before = state.snapshot(); let calls = 0;
  const result = runPassTransaction(state, pass, f.context, { shouldAbort() {
    if (++calls === 4) f.region.close.text = '// changed'; return false;
  } });
  assert.equal(result.committed, false); assert.deepEqual(state.snapshot(), before);
});

test('empty bodies and exhausted preparation budgets do not become erasure candidates', async () => {
  const empty = await prepared({ armEffect:() => {} });
  assert.equal(empty.plan.reason, 'empty-unreachable-arm');
  const f = await prepared();
  for (const limits of [{ workItems:0 }, { allocationUnits:0 }]) {
    const p = prepareConditionalRegionErasure(f.structure, f.reachability, f.ir, { identity, limits });
    assert.equal(p.status, 'partial'); assert.equal(readConditionalRegionErasure(p, f.ir, identity), null);
  }
});

test('unresolved memory PHIs remain obligations and never become rendered erasure authority', async () => {
  const f = await prepared({ mutate:ir => { ir.blocks[3].memPhis = [{ id:'unresolved-memory-phi' }]; } });
  assert.equal(f.plan.status, 'complete', f.plan.reason);
  assert.equal(f.plan.retainedMemoryPhis.length, 1);
  assert.equal(f.plan.retainedMemoryPhis[0].validation, 'required');
  assert.equal(f.plan.transformAuthorization, false);
});

test('a committed candidate cannot be read under a different requested plan', async () => {
  const f = await prepared(), state = seedAnalysisState(f.ir);
  assert.equal(runPassTransaction(state, pass, f.context, {}).committed, true);
  const other = prepareConditionalRegionErasure(f.structure, f.reachability, f.ir, { identity, timeoutMs:5000 });
  assert.equal(other.status, 'complete');
  assert.equal(readProvedRegionErasure(state, { ...f.context, regionErasurePlan:other }), null);
});

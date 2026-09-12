import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { conditionalRegionFixture, textRowConditionalRegionFixture } from '../helpers/conditional-region-fixture.mjs';
import { identity } from '../helpers/proof-fixtures.mjs';
import { validateExecutionContract } from '../../../js/symbolic/memory/execution-contract.js';
import { enhanceSemanticDecompilation, optimizeSemanticDecompilation, isProducerProjection } from '../../../js/decompiler/pipeline.js';
import { prepareConditionalRegionCondition, readConditionalRegionCondition } from '../../../js/decompiler/phase8/conditional-region-condition.js';
import { prepareConditionalRegionErasure } from '../../../js/decompiler/phase8/conditional-region-erasure.js';
import { readProvedRegionErasure } from '../../../js/decompiler/phase8/region-erasure-pass.js';
import { runPhase8Vertical, createAnalysisState } from '../../../js/decompiler/phase8/index.js';
import { applyPhase8Projection, readProjectedConditionalRegions, readLineExpressionHistory } from '../../../js/decompiler/phase8/projection.js';
import { evaluateExpression } from '../../../js/decompiler/verify/equivalence.js';

function storeArm(builder, value) {
    const store = builder.store(value, { locKind:'global', locKey:'g', bits:8 });
    Object.assign(store.loc, { address:16n, addressSpace:'data' });
    store.extra = { completeness:'complete', addressPrecise:true, memoryAccess:{ addressSpace:'data', widthBits:8,
      volatility:false, atomic:false, ordering:'unknown', endian:'little', faults:[] } };
}
function fixture(options = {}) {
  const f = conditionalRegionFixture({ armEffect:storeArm, ...options });
  const projection = enhanceSemanticDecompilation(f.seed, { name:'reachability', calls:[] }, {
    phase8PrepareProof:true, phase8PrepareRegionProof:true, deterministicTransforms:true, renderProvenance:true,
  });
  return { ...f, projection };
}
const options = { identity, addressBits:8, backendTier:'exhaustive', timeoutMs:5000 };

test('production text-row PHI handoff remains explicitly partial and preserves the original view', async () => {
  const f = textRowConditionalRegionFixture();
  const preparedOptions = { ...f.options, ir:f.ir, deterministicTransforms:true,
    phase8PrepareRegionProof:true, phase8PrepareProof:true, renderProvenance:true };
  const { decompileSemantic, readSemanticConditionalRegions } = await import('../../../js/decompiler/semantic-core.js');
  const seed = decompileSemantic(f.model, preparedOptions);
  const branch = readSemanticConditionalRegions(seed)?.regions.find(region => region.selection.header === 0)?.branch;
  assert.ok(branch);
  const projection = enhanceSemanticDecompilation(seed, f.model, preparedOptions);
  const before = structuredClone(f.ir.instructions);
  // Pin the deterministic PHI mismatch independently of the public query's
  // wall-clock deadline. This validation does not execute or prove the region.
  assert.throws(() => validateExecutionContract(f.ir, { chargeExecution() {} }),
    error => error.reason === 'invalid-phi-instruction');
  const output = await optimizeSemanticDecompilation(projection, { ...options, conditionalBranch:branch });
  // Next production boundary: canonical PHIs expose args as their use list;
  // the byte executor currently accepts only args:[]. This is pending C4 work,
  // not a completed production proof or a permanent restriction on PHIs.
  assert.ok(f.ir.blocks.some(block => block.phis.some(phi => phi.args.length > 0)));
  assert.equal(output.proofOptimization.status, 'partial');
  // A finite public query may exhaust its deadline before reaching that PHI;
  // either refusal must retain the exact original view and IR.
  assert.ok(['invalid-phi-instruction', 'deadline-exceeded'].includes(output.proofOptimization.reason),
    output.proofOptimization.reason);
  assert.equal(output.proofOptimization.adopted, 0);
  assert.equal(output.cAst, projection.cAst);
  assert.equal(output.pseudocode, projection.pseudocode);
  assert.deepEqual(f.ir.instructions, before);
});
async function prepared(input = {}, extra = {}) {
  const f = fixture(input);
  const conditionPlan = await prepareConditionalRegionCondition(f.structure, f.projection, { ...options, ...extra });
  return { ...f, conditionPlan, packet:readConditionalRegionCondition(conditionPlan, f.projection, f.structure, identity) };
}
async function committed(input = {}, extra = {}) {
  const f = await prepared(input, extra);
  assert.equal(f.conditionPlan.status, 'complete', f.conditionPlan.reason);
  const reachability = await f.run();
  const plan = prepareConditionalRegionErasure(f.structure, reachability, f.ir,
    { identity, timeoutMs:5000, projection:f.projection, conditionPlan:f.conditionPlan });
  assert.equal(plan.status, 'complete', plan.reason);
  const opts = { phase8ProofIdentity:identity, phase8RegionErasurePlan:plan };
  const stage = runPhase8Vertical({ ir:f.ir, opts, enabledStages:['rendering'] }, { timeBudgetMs:1000 });
  assert.equal(stage.ledger.published, true, JSON.stringify(stage.ledger));
  return { ...f, plan, opts, stage };
}

test('public optimizer proves and commits an actual conditional header through its existing transaction', async () => {
  const f = fixture({ kind:'cbnz' }), before = f.projection.pseudocode;
  const output = await optimizeSemanticDecompilation(f.projection, { ...options, conditionalBranch:f.region.branch });
  assert.equal(output.proofOptimization.status, 'complete', output.proofOptimization.reason);
  assert.equal(output.proofOptimization.adopted, 1);
  assert.equal(output.proofOptimization.scope, 'conditional-predicate-only');
  assert.equal(output.proofOptimization.armErasureAuthorized, false);
  assert.equal(output.proofOptimization.decisionCoverage.complete, true);
  assert.ok(isProducerProjection(output));
  assert.notEqual(output.pseudocode, before);
  assert.equal(f.projection.pseudocode, before);
  assert.equal(output.cAst.body.length, f.projection.cAst.body.length);
  assert.equal(output.rewriteProof.filter(r => r.rule === 'project-proved-conditional-predicate').length, 1);
  assert.ok(readProjectedConditionalRegions(output.cAst, f.ir));
  let replay = output;
  for (let i = 0; i < 3; i++) {
    replay = await optimizeSemanticDecompilation(replay, { ...options, conditionalBranch:f.region.branch });
    assert.equal(replay.proofOptimization.status, 'complete', replay.proofOptimization.reason);
    assert.equal(replay.proofOptimization.adopted, 0);
    assert.equal(replay.proofOptimization.targetDecisions[0].disposition, 'already-adopted');
    assert.equal(replay.cAst, output.cAst);
    assert.equal(replay.rewriteProof, output.rewriteProof);
  }
  for (const invalid of [{ addressBits:'8' }, { endian:'native' }, { backendTier:'injected' }]) {
    const refused = await optimizeSemanticDecompilation(replay, { ...options, conditionalBranch:f.region.branch, ...invalid });
    assert.equal(refused.proofOptimization.status, 'partial');
    assert.equal(refused.cAst, output.cAst);
  }
  f.region.branch.extra.kind = 'cbz';
  const stale = await optimizeSemanticDecompilation(replay, { ...options, conditionalBranch:f.region.branch });
  assert.equal(stale.proofOptimization.status, 'partial');
});

test('public conditional publication rejects a final lifecycle callback mutation and cannot reuse forged report fields', async () => {
  const baseline = fixture({ kind:'cbnz' });
  let calls = 0;
  const accepted = await optimizeSemanticDecompilation(baseline.projection,
    { ...options, conditionalBranch:baseline.region.branch, isCancelled:()=>{ calls++; return false; } });
  assert.equal(accepted.proofOptimization.status, 'complete', accepted.proofOptimization.reason);
  assert.ok(calls > 0);
  const f = fixture({ kind:'cbnz' });
  let count = 0;
  const refused = await optimizeSemanticDecompilation(f.projection, { ...options, conditionalBranch:f.region.branch,
    isCancelled:()=>{ if (++count === calls) f.region.branch.extra.kind = 'cbz'; return false; } });
  assert.equal(count, calls);
  assert.equal(refused.proofOptimization.status, 'partial');
  assert.equal(refused.proofOptimization.adopted, 0);
  assert.equal(refused.cAst, f.projection.cAst);
  const fresh = fixture({ kind:'cbnz' });
  fresh.projection.proofOptimization = accepted.proofOptimization;
  const actual = await optimizeSemanticDecompilation(fresh.projection, { ...options, conditionalBranch:fresh.region.branch });
  assert.equal(actual.proofOptimization.status, 'complete', actual.proofOptimization.reason);
  assert.equal(actual.proofOptimization.adopted, 1);
});

test('public conditional requests reject copied branches, missing preparation and mixed scalar authority', async () => {
  for (const alter of [f=>({ conditionalBranch:{ ...f.region.branch } }),
    () => ({ conditionalBranch:null }), () => ({ targets:[] }), () => ({ phase8RegionErasurePlan:{} }),
    () => ({ backend:{} }), () => ({ requireProofOnlyRewrites:true })]) {
    const f = fixture({ kind:'cbnz' });
    const output = await optimizeSemanticDecompilation(f.projection,
      { ...options, conditionalBranch:f.region.branch, ...alter(f) });
    assert.equal(output.proofOptimization.status, 'partial');
    assert.equal(output.proofOptimization.adopted, 0);
    assert.equal(output.cAst, f.projection.cAst);
  }
  const f = fixture({ kind:'cbnz' });
  const unprepared = enhanceSemanticDecompilation(f.seed, { name:'reachability', calls:[] }, {});
  const refused = await optimizeSemanticDecompilation(unprepared, { ...options, conditionalBranch:f.region.branch });
  assert.equal(refused.proofOptimization.reason, 'unissued-or-stale-projection');
});

test('public conditional requests retain the original view on cancellation, stale identity, budget and unconstrained arms', async () => {
  for (const extra of [{ timeoutMs:0 }, { isCancelled:()=>true },
    { getCurrentIdentity:()=>({ ...identity, snapshotId:'changed' }) }, { phase8WorkBudget:0 },
    { phase8TimeBudgetMs:'5000' }, { phase8TimeBudgetMs:NaN }, { phase8WorkBudget:'1000000' }]) {
    const f = fixture({ kind:'cbnz' });
    const output = await optimizeSemanticDecompilation(f.projection, { ...options, conditionalBranch:f.region.branch, ...extra });
    assert.equal(output.proofOptimization.status, 'partial');
    assert.equal(output.proofOptimization.adopted, 0);
    assert.equal(output.cAst, f.projection.cAst);
  }
  const f = fixture({ kind:'cbnz', predicate:'input', armEffect:()=>{} });
  const output = await optimizeSemanticDecompilation(f.projection, { ...options, conditionalBranch:f.region.branch });
  assert.equal(output.proofOptimization.reason, 'no-single-unreachable-arm');
  assert.equal(output.cAst, f.projection.cAst);
});

test('public conditional request preserves the prepared proof-only policy and snapshots async request options', async () => {
  const f = conditionalRegionFixture({ kind:'cbnz', armEffect:storeArm });
  const projection = enhanceSemanticDecompilation(f.seed, { name:'reachability', calls:[] }, {
    phase8PrepareProof:true, phase8PrepareRegionProof:true, phase8ProofOnlyRewrites:true,
    deterministicTransforms:true, renderProvenance:true,
  });
  const request = { ...options, conditionalBranch:f.region.branch, requireProofOnlyRewrites:true };
  const pending = optimizeSemanticDecompilation(projection, request);
  request.conditionalBranch = { ...f.region.branch }; request.timeoutMs = 0;
  const output = await pending;
  assert.equal(output.proofOptimization.status, 'complete', output.proofOptimization.reason);
  assert.equal(output.proofOptimization.rewritePolicy, 'deferred-optional-scalar-rewrites');
  assert.ok(isProducerProjection(output));
});

for (const kind of ['cbz','cbnz','tbz','tbnz']) {
  for (const bit of (kind.startsWith('tb') ? [0,3,7] : [null])) {
    test(`actual ${kind} ${bit} proposal is universally verified and safely re-lowered`, async () => {
      const f = await prepared({ kind, predicate:'input', armEffect:() => {},
        mutate(ir) { if (bit != null) ir.blocks[0].insts.at(-1).extra.bit = bit; } });
      assert.equal(f.conditionPlan.status, 'complete', f.conditionPlan.reason);
      assert.ok(f.packet);
      assert.equal(f.conditionPlan.transformAuthorization, false);
      assert.equal(readConditionalRegionCondition({ ...f.conditionPlan }, f.projection, f.structure, identity), null);
      assert.equal(readConditionalRegionCondition(f.conditionPlan, { ...f.projection }, f.structure, identity), null);
      assert.equal(readConditionalRegionCondition(f.conditionPlan, f.projection, { ...f.structure }, identity), null);
    });
  }
}

test('one-sided inverted condition preserves the selected arm polarity', async () => {
  const f = await committed({ kind:'cbz', mutate(ir) {
    const [entry, unused, , join] = ir.blocks;
    entry.succ[0] = 3; entry.successorEdges.find(edge => edge.kind === 'conditional-true').to = 3;
    unused.pred = []; join.pred.push(0);
    join.phis[0].incoming.push({ from:0, value:entry.insts[0].dst });
    Object.assign(entry.insts.at(-1).extra, { targetBlock:3, target:join.insts[0].address });
  } });
  assert.equal(f.region.selection.invert, true);
  const output = applyPhase8Projection(f.projection, f.stage.analysis, f.opts);
  assert.notEqual(output, f.projection);
  assert.ok(output.cAst.body.some(node => node.text === f.packet.text));
  for (let value = 0n; value < 256n; value++) assert.equal(evaluateExpression(f.packet.expression, { a1:value }), 0n);
  assert.equal(output.cAst.body.length, f.projection.cAst.body.length);
});

test('native 32/64-bit direct predicates use the existing bounded tiered verifier', async () => {
  for (const bits of [32,64]) {
    const f = await prepared({ kind:'tbnz', armEffect:() => {},
      predicate(_builder, input) { input.bits = bits; return input; },
      mutate(ir) { ir.blocks[0].insts.at(-1).extra.bit = bits - 1; } }, { backendTier:'tiered' });
    assert.equal(f.conditionPlan.status, 'complete', f.conditionPlan.reason);
    assert.ok(f.packet);
  }
});

test('committed region projection repairs the actual C precedence counterexample and retains every arm/PHI', async () => {
  const f = await committed({ kind:'cbnz' });
  const initial = f.projection.cAst.body.map(node => node.text);
  assert.ok(initial.includes('if (a1 ^ a1 != 0) {'));
  const beforeInstructions = [...f.ir.instructions], beforePhis = [...f.ir.blocks[3].phis];
  const output = applyPhase8Projection(f.projection, f.stage.analysis, f.opts);
  assert.notEqual(output, f.projection);
  assert.equal(output.renderProvenance.completeness, 'complete');
  const changed = output.cAst.body.flatMap((node,index) => node.text !== initial[index] ? [index] : []);
  assert.equal(changed.length, 1);
  assert.equal(output.cAst.body[changed[0]].text, f.packet.text);
  assert.deepEqual(f.projection.cAst.body.map(node => node.text), initial);
  assert.deepEqual(f.ir.instructions, beforeInstructions); assert.deepEqual(f.ir.blocks[3].phis, beforePhis);
  assert.equal(output.cAst.body.length, initial.length);
  assert.equal(f.plan.transformAuthorization, false);
  assert.deepEqual(f.plan.pendingValidation, ['live-phi-render-correspondence','removed-entity-provenance']);
  const history = readLineExpressionHistory(output.lines[changed[0]], f.ir);
  assert.ok(history.some(record => record.rule === 'project-proved-conditional-predicate'));
  assert.ok(readProjectedConditionalRegions(output.cAst, f.ir));
  let replay = output;
  for (let i = 0; i < 4; i++) {
    replay = applyPhase8Projection(replay, f.stage.analysis, { preserveInitialSpelling:true });
    assert.equal(replay.cAst.body[changed[0]].text, f.packet.text);
    assert.ok(readLineExpressionHistory(replay.lines[changed[0]], f.ir));
    assert.ok(readProjectedConditionalRegions(replay.cAst, f.ir));
    assert.equal(replay.rewriteProof.filter(record => record.rule === 'project-proved-conditional-predicate').length, 1);
  }
});

test('printed direct predicates agree with an independent C truth table, including the precedence counterexample', async () => {
  const functions = [], checks = [];
  for (const kind of ['cbz','cbnz','tbz','tbnz']) {
    for (const bit of (kind.startsWith('tb') ? [0,3,7] : [null])) {
      const f = await prepared({ kind, predicate:'input', mutate(ir) { if (bit != null) ir.blocks[0].insts.at(-1).extra.bit = bit; } });
      assert.ok(f.packet, f.conditionPlan.reason);
      const name = `predicate_${functions.length}`;
      functions.push(`static int ${name}(int8_t a1) { ${f.packet.text} return 1; } return 0; }`);
      const tested = bit == null ? 'i' : `(i >> ${bit}) & 1`;
      checks.push(`if (${name}((int8_t)i) != ((${tested}) ${kind.endsWith('nz') ? '!=' : '=='} 0)) return ${functions.length};`);
    }
  }
  const f = await committed({ kind:'cbnz' });
  const output = applyPhase8Projection(f.projection, f.stage.analysis, f.opts);
  assert.notEqual(output, f.projection);
  const header = output.cAst.body.find(node => node.semantic?.expression === f.packet.expression).text;
  functions.push(`static int corrected(int8_t a1) { ${header} return 1; } return 0; }`);
  checks.push('if (corrected((int8_t)i) != 0) return 99;');
  const configured = process.env.TMPDIR || join(process.cwd(), '.cache', 'c4-condition');
  assert.ok(configured && isAbsolute(configured), 'explicit persistent TMPDIR required');
  mkdirSync(configured, { recursive:true });
  const root = realpathSync(configured);
  assert.ok(!['/tmp','/var/tmp','/dev/shm'].some(path => root === path || root.startsWith(path + '/')));
  const directory = mkdtempSync(join(root, 'c4-condition-c-')), binary = join(directory, 'predicate');
  const source = `#include <stdint.h>\n${functions.join('\n')}\nint main(void) { for (unsigned i=0;i<256;i++) { ${checks.join('\n')} } return 0; }`;
  const compiled = spawnSync(process.env.CC || 'cc', ['-std=c11','-O2','-fsanitize=undefined','-fno-sanitize-recover=all','-x','c','-','-o',binary],
    { input:source, encoding:'utf8', timeout:30000 });
  assert.equal(compiled.status, 0, compiled.stderr || String(compiled.error));
  const executed = spawnSync(binary, [], { encoding:'utf8', timeout:30000 });
  assert.equal(executed.status, 0, executed.stderr);
});

test('forged and manually staged overlays cannot publish even a genuine prepared condition', async () => {
  const f = await committed();
  const forged = createAnalysisState({ provedRegions:f.stage.analysis.get('provedRegions') });
  assert.equal(readProvedRegionErasure(forged, { ir:f.ir, opts:f.opts }), null);
  assert.equal(applyPhase8Projection(f.projection, forged, f.opts), f.projection);
  assert.equal(applyPhase8Projection(f.projection, f.stage.analysis,
    { ...f.opts, phase8RegionErasurePlan:{ ...f.plan } }), f.projection);
  const other = fixture();
  assert.equal(applyPhase8Projection(other.projection, f.stage.analysis, f.opts), other.projection);
});

for (const target of ['header','expression','branch','identity']) test(`changed ${target} revokes prepared condition`, async () => {
  const f = await committed();
  if (target === 'header') f.packet.header.text += ' ';
  if (target === 'expression') f.packet.expression.bits = 8;
  if (target === 'branch') f.region.branch.extra.kind = 'cbnz';
  const opts = target === 'identity' ? { ...f.opts, phase8ProofIdentity:{ ...identity, snapshotId:'new' } } : f.opts;
  assert.equal(applyPhase8Projection(f.projection, f.stage.analysis, opts), f.projection);
});

test('cancellation and exhausted projection provenance/carrier budgets publish no predicate', async () => {
  const f = await committed();
  for (const extra of [{ shouldAbort:() => true }, { renderProvenanceBudget:{ maxTransformRecords:0 } },
    { renderProvenanceBindingBudget:{ maxEdges:0 } }, { phase8RegionCarrierBudget:{ maxNodes:0 } }]) {
    assert.equal(applyPhase8Projection(f.projection, f.stage.analysis, { ...f.opts, ...extra }), f.projection);
  }
});

test('late projection callback mutation cannot refresh a genuine condition proof', async () => {
  const f = await committed();
  let calls = 0;
  const output = applyPhase8Projection(f.projection, f.stage.analysis, { ...f.opts,
    shouldAbort() { if (++calls === 6) f.packet.header.text += ' '; return false; } });
  assert.ok(calls >= 6);
  assert.equal(output, f.projection);
});

test('the final projection callback cannot publish a stale header after earlier checks passed', async () => {
  const f = await committed();
  let finalCall = 0;
  const baseline = applyPhase8Projection(f.projection, f.stage.analysis, { ...f.opts,
    scopedTransformEvidence:true, shouldAbort() { finalCall++; return false; } });
  assert.notEqual(baseline, f.projection); assert.ok(finalCall > 0);
  let calls = 0;
  const output = applyPhase8Projection(f.projection, f.stage.analysis, { ...f.opts,
    scopedTransformEvidence:true, shouldAbort() { if (++calls === finalCall) f.packet.header.text += ' '; return false; } });
  assert.ok(calls >= finalCall);
  assert.equal(output, f.projection);
});

for (const extra of [{ limits:{ workItems:0 } }, { timeoutMs:0 }, { isCancelled:() => true },
  { getCurrentIdentity:() => ({ ...identity, snapshotId:'changed' }) }, { backend:{} }, { preconditions:[] }]) {
  test(`condition preparation refuses ${Object.keys(extra)[0]}`, async () => {
    const f = await prepared({}, extra);
    assert.equal(f.conditionPlan.status, 'partial'); assert.equal(f.packet, null);
  });
}

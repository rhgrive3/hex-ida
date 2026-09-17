import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSemanticModel } from '../../../js/blocks.js';
import { decompileSemantic, readSemanticSuppressionHistory } from '../../../js/decompiler/semantic-core.js';
import { enhanceSemanticDecompilation } from '../../../js/decompiler/pipeline.js';
import { applyPhase8Projection } from '../../../js/decompiler/phase8/projection.js';
import { buildRenderProvenance, validateRenderProvenance } from '../../../js/decompiler/phase8/render-provenance.js';
import { fixture as irFixture } from '../helpers/ir-fixtures.mjs';
import { analysis } from './fixture.js';

function fixture({ options = {}, mechanical = false, ordinary = false, calls = 1, fork = false } = {}) {
  const opts = { deterministicTransforms:true, ...options };
  let model;
  if (mechanical) {
    const f = irFixture('initial_stack_suppression'); f.block(0);
    const input = f.opaque(64); input.reg = ordinary ? 'x0' : 'x29';
    f.store(input, { locKind:'stack', locKey:'stack:8', disp:8 }); f.ret();
    const ir = f.build(); ir.instructions = ir.blocks.flatMap(block => block.insts);
    ir.instructions.forEach((inst, index) => { inst.id = index + 20; inst.address = 0x3000n + BigInt(index * 4); });
    model = { name:ir.name, instructions:ir.instructions, calls:[] }; opts.ir = ir;
  } else {
    const raw = (fork ? [{ mn:'bl', ops:'0x2000' }, { mn:'cbz', ops:'x0, 0x100c' }, { mn:'ret', ops:'' },
      { mn:'bl', ops:'0x2000' }, { mn:'ret', ops:'' }]
      : [...Array.from({ length:calls }, () => ({ mn:'bl', ops:'0x2000' })), { mn:'ret', ops:'' }])
      .map((inst, row) => ({ ...inst, row, address:0x1000n + BigInt(row * 4) }));
    opts.rowOfAddress = address => raw.find(inst => inst.address === BigInt(address))?.row ?? null;
    opts.addrOfRow = row => raw[row]?.address ?? null;
    opts.symbolFor = () => ordinary ? 'ordinary_work' : 'objc_release';
    model = buildSemanticModel(raw, { ...opts, startRow:0, endRow:raw.length - 1 });
  }
  const seed = decompileSemantic(model, opts);
  const canonical = structuredClone(seed.ir.instructions);
  const result = enhanceSemanticDecompilation(seed, model, opts);
  return { seed, result, canonical, model, opts };
}

const omissions = map => map.ledger.filter(record => record.kind === 'display-suppression');

test('actual runtime-call omission reaches the existing ledger and reverse history, without a fictitious C line', () => {
  const f = fixture();
  assert.equal(f.seed.ctx.suppressed.length, 1);
  let result = applyPhase8Projection(f.result, analysis());
  const map = result.renderProvenance, records = omissions(map);
  assert.equal(records.length, 1);
  const record = records[0], inst = result.ir.instructions.find(inst => inst.op === 'call');
  assert.equal(record.rule, 'omit-runtime-noise-call');
  assert.equal(record.proof, 'observed-display-event-not-semantic-equivalence');
  assert.deepEqual(record.suppressedRender, { scope:'initial-semantic-render', operation:'omit', reason:'folded runtime noise: objc_release' });
  for (const key of [`ir:${inst.id}`, `row:${inst.row}`, `addr:${inst.address}`]) {
    assert.ok(map.transformReverse[key].includes(map.ledger.indexOf(record)));
  }
  assert.deepEqual(record.producedRefs, []); assert.deepEqual(record.removedRefs, []);
  assert.ok(!record.originHistory && !record.renderedRemoval);
  assert.ok(Object.isFrozen(record.suppressedRender));
  assert.equal(validateRenderProvenance(map).state, 'complete');
  assert.deepEqual(result.ir.instructions, f.canonical);
  for (let i = 0; i < 3; i++) result = applyPhase8Projection(result, analysis());
  assert.deepEqual(omissions(result.renderProvenance), records);
});

test('actual mechanical stack omission is display history, not a DCE receipt', () => {
  const f = fixture({ mechanical:true });
  const map = applyPhase8Projection(f.result, analysis()).renderProvenance;
  assert.equal(omissions(map).length, 1);
  assert.equal(omissions(map)[0].rule, 'omit-mechanical-stack-spill');
  assert.ok(f.result.ir.instructions.some(inst => inst.op === 'store'));
  assert.deepEqual(f.result.ir.instructions, f.canonical);
  assert.equal(validateRenderProvenance(map).state, 'complete');
});

test('expert calls, ordinary calls and ordinary stores do not acquire suppression history', () => {
  for (const options of [{ options:{ expert:true } }, { ordinary:true }, { mechanical:true, ordinary:true }]) {
    const f = fixture(options), map = applyPhase8Projection(f.result, analysis()).renderProvenance;
    assert.deepEqual(omissions(map), []);
    assert.equal(f.seed.ctx.suppressed.length, 0);
    assert.ok(f.seed.lines.some(line => line.kind === 'stmt' && !line.text.startsWith('return')));
  }
});

test('copied metadata, stale instructions and replaced IR roots do not issue omission history', () => {
  for (const mutate of [
    result => { result.ctx = { ...result.ctx, suppressed:structuredClone(result.ctx.suppressed) }; },
    result => { result.semanticSuppressionHistory = { ...result.semanticSuppressionHistory }; },
    result => { result.ir.instructions.find(inst => inst.op === 'call').extra.name = 'changed'; },
    result => { result.ir = { ...result.ir }; },
    result => { result.ir.instructions = [...result.ir.instructions]; },
    result => { result.ctx.suppressed[0].reason = 'forged'; },
  ]) {
    const f = fixture(); mutate(f.result);
    assert.equal(readSemanticSuppressionHistory(f.result), null);
    const map = applyPhase8Projection(f.result, analysis()).renderProvenance;
    assert.deepEqual(omissions(map), []);
    assert.ok(map.reasons.includes('unavailable-semantic-suppression-history'));
    assert.equal(map.completeness, 'incomplete');
  }
});

test('history budgets and observation cancellation never change the actual display decision', () => {
  for (const options of [
    { renderProvenanceBudget:{ maxTransformRecords:0 } },
    { renderProvenanceBindingBudget:{ maxEdges:0 } },
    { shouldAbort:() => true },
  ]) {
    const f = fixture({ options });
    assert.equal(f.seed.ctx.suppressed.length, 1);
    assert.ok(!f.seed.pseudocode.includes('objc_release'));
    assert.equal(f.seed.semanticSuppressionHistory.completeness, 'incomplete');
    const map = buildRenderProvenance({ result:f.seed, snapshotId:'suppression-fixture' });
    assert.equal(map.completeness, 'incomplete'); assert.deepEqual(omissions(map), []);
  }
  const f = fixture({ calls:3, options:{ renderProvenanceBudget:{ maxTransformRecords:2 } } });
  assert.equal(f.seed.ctx.suppressed.length, 3);
  const map = buildRenderProvenance({ result:f.seed, snapshotId:'suppression-fixture', budget:{ maxTransformRecords:1 } });
  assert.equal(omissions(map).length, 1); assert.equal(map.completeness, 'incomplete');
  assert.ok(map.budget.truncatedScopes.includes('ledger'));
});

test('shared visible origins do not invent replacement edges and public projection records cannot issue omissions', () => {
  const f = fixture(), record = readSemanticSuppressionHistory(f.result).records[0];
  const lines = [{ kind:'stmt', text:'other();', source:record.origin }];
  const map = buildRenderProvenance({ result:{ ...f.result, lines }, snapshotId:'suppression-fixture' });
  assert.deepEqual(omissions(map)[0].producedRefs, []);
  assert.deepEqual(map.entities['L0:stmt'].recordRefs, []);
  const fake = buildRenderProvenance({ result:{ lines, phase8Projection:{ transforms:[structuredClone(record)] } }, snapshotId:'suppression-fixture' });
  assert.deepEqual(omissions(fake), []);
  assert.ok(fake.reasons.includes('unissued-semantic-suppression-history'));
});

test('suppression validation rejects semantic deletion claims and invented current or old line references', () => {
  const original = applyPhase8Projection(fixture().result, analysis()).renderProvenance;
  for (const mutate of [
    record => { record.suppressedRender.scope = 'canonical-ir'; },
    record => { record.proof = 'equivalent'; },
    record => { record.producedRefs = ['L0:stmt']; },
    record => { record.removedRefs = ['before:0:L0:stmt']; },
    record => { record.renderedRemoval = { scope:'pre-transform-render', operation:'remove', lineIndex:0, kind:'stmt' }; },
  ]) {
    const map = structuredClone(original); mutate(omissions(map)[0]);
    assert.ok(validateRenderProvenance(map).reasons.includes('invalid-semantic-suppression-history'));
  }
  assert.ok(validateRenderProvenance(original, { snapshotId:'stale' }).reasons.includes('stale-snapshot'));
});

test('faithful CFG fallback records only its selected emission, not the abandoned structured attempt', () => {
  const f = fixture({ fork:true });
  assert.equal(f.seed.coverage.mode, 'linear');
  assert.equal(f.seed.ctx.suppressed.length, 3, 'legacy diagnostics are preserved');
  const records = readSemanticSuppressionHistory(f.seed).records;
  assert.equal(records.length, 2, 'each actually omitted call in the final emission occurs once');
  assert.equal(new Set(records.map(record => record.targets[0])).size, 2);
  const map = applyPhase8Projection(f.result, analysis()).renderProvenance;
  assert.equal(omissions(map).length, 2);
  assert.deepEqual(f.result.ir.instructions, f.canonical);
});

test('a mutation during map construction cannot publish a complete current suppression history', () => {
  const f = fixture(); let checks = 0;
  const map = buildRenderProvenance({ result:f.result, snapshotId:'suppression-fixture', shouldAbort:() => {
    if (++checks === 2) f.result.ir.instructions.find(inst => inst.op === 'call').row = 99;
    return false;
  } });
  assert.ok(checks >= 2);
  assert.equal(map.completeness, 'incomplete');
  assert.ok(map.reasons.includes('stale-semantic-suppression-history'));
});

test('later symbol resolution cannot reassign an earlier omission to a changed source position', () => {
  const f = fixture({ calls:2 }), first = f.seed.ir.instructions.find(inst => inst.op === 'call');
  let resolutions = 0;
  const result = decompileSemantic(f.model, { ...f.opts, ir:f.seed.ir, symbolFor:() => {
    if (++resolutions === 2) first.row = 99;
    return 'objc_release';
  } });
  assert.equal(resolutions, 2);
  assert.equal(result.ctx.suppressed.length, 2);
  assert.equal(result.ctx.suppressed[0].row, 0, 'the event retains its actual source at emission');
  assert.equal(result.semanticSuppressionHistory.completeness, 'incomplete');
  assert.equal(readSemanticSuppressionHistory(result), null);
  assert.deepEqual(omissions(buildRenderProvenance({ result, snapshotId:'suppression-fixture' })), []);
  const fresh = fixture();
  const instruction = fresh.seed.ir.instructions.find(inst => inst.op === 'call');
  const changedDuringCapture = decompileSemantic(fresh.model, { ...fresh.opts, ir:fresh.seed.ir, shouldAbort:() => {
    instruction.row = 99; return false;
  } });
  assert.equal(changedDuringCapture.ctx.suppressed[0].row, 0);
  assert.equal(changedDuringCapture.semanticSuppressionHistory.completeness, 'incomplete');
  assert.equal(readSemanticSuppressionHistory(changedDuringCapture), null);
});

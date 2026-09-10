import assert from 'node:assert/strict';
import test from 'node:test';

import { applyPhase8Projection } from '../../../js/decompiler/phase8/projection.js';
import { runPhase8Vertical } from '../../../js/decompiler/phase8/index.js';
import { enhanceSemanticDecompilation } from '../../../js/decompiler/pipeline-core.js';
import { fixture as irFixture } from '../helpers/ir-fixtures.mjs';
import { analysis, expr, resultWith, source, sourceOf } from './fixture.js';

// These are actual candidate-producing passes followed by the ordinary view
// producer. A nested-cast collapse is not a substitute for CSE or DCE adoption.
function candidateFixture(bits) {
  const f = irFixture('candidate-not-adoption'); f.block(0);
  const a = f.opaque(bits), b = f.opaque(bits);
  const first = f.binary('add', a, b, bits), second = f.binary('add', a, b, bits);
  const dead = f.binary('mul', a, b, bits), ignored = f.call(bits);
  f.store(first, { locKind:'global', locKey:'global:32768' });
  f.store(second, { locKind:'global', locKey:'global:32776' });
  f.ret();
  const ir = f.build();
  ir.instructions = ir.blocks.flatMap(block => block.insts);
  ir.instructions.forEach((inst, index) => {
    inst.id = index + 100; inst.row = index; inst.address = 0x6000n + BigInt(index * 4);
  });
  ir.values.forEach((value, index) => { value.reg = `x${index}`; value.signed = false; });
  ir.blocks[0].startRow = 0;
  const canonical = structuredClone(ir);
  const vertical = runPhase8Vertical({ ir });
  assert.equal(vertical.ledger.published, true, vertical.ledger.stopReason);
  const render = state => {
    const seed = { semantic:true, ir, types:{ values:new Map(), locations:new Map() },
      lines:ir.instructions.filter(inst => ['call', 'store', 'ret'].includes(inst.op)).map(inst => ({
        kind:'stmt', indent:1, text:inst.op === 'ret' ? 'return;' : inst.op === 'call' ? 'opaque();' : 'old = value;',
        row:inst.row, addr:inst.address,
      })), warnings:[], evidence:[], coverage:{ mode:'structured' }, summary:'' };
    return applyPhase8Projection(enhanceSemanticDecompilation(seed, { calls:[] }, { deterministicTransforms:true }), state);
  };
  return { ir, canonical, vertical, render, first, second, dead, ignored };
}

test('C4-03 actual GVN/DCE candidate publication is not an applied merge or removal', () => {
  for (const bits of [8, 16, 32, 64]) {
    const f = candidateFixture(bits), { analysis:state, ledger } = f.vertical;
    const gvn = state.get('valueNumbers'), dce = state.get('deadCode');
    assert.equal(gvn.completeness, 'complete');
    assert.ok(gvn.reuseCandidates.some(row => row.valueId === f.second.id && row.reuseOf === f.first.id));
    assert.equal(dce.completeness, 'complete');
    assert.ok(dce.candidates.some(row => row.valueId === f.dead.id));
    assert.ok(dce.deadButObservable.some(row => row.valueId === f.ignored.id));
    for (const id of ['phase8.gvn', 'phase8.dce']) {
      assert.deepEqual(ledger.passes.find(pass => pass.passId === id).transforms, []);
      assert.equal(ledger.rewriteCoverage.rows.find(row => row.passId === id).disposition, 'analysis-only');
    }
    const result = f.render(state);
    const withoutCandidates = f.render({ get:key => ['valueNumbers', 'deadCode'].includes(key) ? null : state.get(key) });
    assert.deepEqual(result.cAst, withoutCandidates.cAst);
    assert.deepEqual(result.semanticAst, withoutCandidates.semanticAst);
    assert.deepEqual(result.pseudocode, withoutCandidates.pseudocode);
    assert.deepEqual(result.renderProvenance, withoutCandidates.renderProvenance);
    assert.ok(result.renderProvenance.ledger.every(record => record.removedRefs.length === 0));
    assert.ok(result.cAst.body.some(node => node.text === 'opaque();'
      && node.source.rows.includes(f.ignored.def.row)));
    // Both source computations survive independently; equal expression text
    // does not assert a many-to-one CSE event between their definitions.
    const stores = result.cAst.body.filter(node => node.semantic?.op === 'store');
    assert.equal(stores.length, 2);
    for (const [index, value] of [f.first, f.second].entries()) {
      assert.ok(stores[index].semantic.expression.source.ssaDefs.includes(value.id));
      assert.ok(!stores[index].semantic.expression.source.ssaDefs.includes([f.second, f.first][index].id));
      const own = `L${result.cAst.body.indexOf(stores[index])}:stmt`;
      const other = `L${result.cAst.body.indexOf(stores[1 - index])}:stmt`;
      const reverse = result.renderProvenance.reverse[`addr:${value.def.address}`];
      assert.ok(reverse.includes(own));
      assert.ok(!reverse.includes(other));
    }
    assert.deepEqual(structuredClone(f.ir), f.canonical);
  }
});

test('C4-03 replay cannot turn retained analysis candidates into transform history', () => {
  const f = candidateFixture(32), state = f.vertical.analysis;
  let result = f.render(state);
  const before = structuredClone(result.renderProvenance), output = result.pseudocode;
  for (let index = 0; index < 4; index++) {
    result = applyPhase8Projection(result, state);
    assert.deepEqual(result.renderProvenance, before);
    assert.equal(result.pseudocode, output);
  }
  assert.deepEqual(structuredClone(f.ir), f.canonical);
});

test('P8-PROV ledger records carry kind, proof, targets, origins, produced and version', () => {
  const value = expr.variable('a1', 64, true, source(1, 1));
  const wide = expr.unary('trunc', value, 32, false, source(1, 2));
  const narrow = expr.unary('trunc', wide, 8, false, source(1, 3));
  const result = applyPhase8Projection(resultWith(narrow), analysis());

  const collapse = result.renderProvenance.ledger.find((record) => record.kind === 'exact-view-collapse');
  assert.ok(collapse, 'collapse rewrite must be recorded');
  assert.ok(typeof collapse.proof === 'string' && collapse.proof.length > 0, 'proof is required');
  assert.ok(Array.isArray(collapse.targets) && collapse.targets.length > 0, 'targets are required');
  assert.ok(collapse.origin.rows.length > 0, 'consumed origins are required');
  assert.ok(collapse.producedRefs.length > 0, 'produced entity refs are required');
  assert.equal(collapse.version, 1);
});

test('P8-PROV a merged expression record lists consumed origins and the produced entity', () => {
  const value = expr.variable('a1', 64, true, source(1, 1));
  const wide = expr.unary('trunc', value, 32, false, source(1, 2));
  const narrow = expr.unary('trunc', wide, 8, false, source(1, 3));
  const result = applyPhase8Projection(resultWith(narrow), analysis());

  const provenance = result.renderProvenance;
  const collapse = provenance.ledger.find((record) => record.kind === 'exact-view-collapse');
  assert.deepEqual(collapse.origin.rows, [1, 2, 3], 'all consumed origins of the merged chain are listed');
  assert.equal(collapse.producedRefs.length, 1, 'one produced entity');

  const entity = Object.values(provenance.entities).find((candidate) => candidate.entityKey === collapse.producedRefs[0])
    ?? Object.values(provenance.entities).find((candidate) => candidate.recordRefs.includes(provenance.ledger.indexOf(collapse)));
  assert.ok(entity, 'produced ref must resolve to the rendered entity carrying the merge');
  assert.ok(entity.origins.rows.includes(1) && entity.origins.rows.includes(3));
});

test('P8-PROV address-only rewrite records target the canonical address entity', () => {
  const addressOnly = sourceOf({ address:0x4444n, evidence:[{ reason:'address-only-rewrite' }] });
  const value = expr.variable('a1', 64, true, addressOnly);
  const wide = expr.unary('trunc', value, 32, false, addressOnly);
  const narrow = expr.unary('trunc', wide, 8, false, addressOnly);
  const result = applyPhase8Projection(resultWith(narrow), analysis());

  const collapse = result.renderProvenance.ledger.find((record) => record.kind === 'exact-view-collapse');
  assert.ok(collapse, 'address-only collapse rewrite must be recorded');
  // Public ledger addresses use the canonical serializable decimal form.
  assert.deepEqual(collapse.origin.addresses, ['17476']);
  assert.deepEqual(collapse.targets, ['addr:17476']);
  assert.ok(!collapse.targets.some((target) => target.startsWith('proof:')), 'canonical address must not be replaced by proof fallback');
  assert.ok(collapse.producedRefs.length > 0, 'address-only rewrite must remain linked to the rendered entity');
});

test('P8-PROV SSA-use-only rewrite records target the canonical SSA-use entity', () => {
  const ssaUseOnly = sourceOf({ ssaUse:'ssa-use-only', evidence:[{ reason:'ssa-use-only-rewrite' }] });
  const value = expr.variable('a1', 64, true, ssaUseOnly);
  const wide = expr.unary('trunc', value, 32, false, ssaUseOnly);
  const narrow = expr.unary('trunc', wide, 8, false, ssaUseOnly);
  const result = applyPhase8Projection(resultWith(narrow), analysis());

  const collapse = result.renderProvenance.ledger.find((record) => record.kind === 'exact-view-collapse');
  assert.ok(collapse, 'SSA-use-only collapse rewrite must be recorded');
  assert.deepEqual(collapse.origin.ssaUses, ['ssa-use-only']);
  assert.deepEqual(collapse.targets, ['ssa:use:ssa-use-only']);
  assert.ok(!collapse.targets.some((target) => target.startsWith('proof:')), 'canonical SSA use must not be replaced by proof fallback');
  assert.ok(collapse.producedRefs.length > 0, 'SSA-use-only rewrite must remain linked to the rendered entity');
});

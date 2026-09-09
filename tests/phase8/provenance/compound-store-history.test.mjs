import assert from 'node:assert/strict';
import test from 'node:test';
import { enhanceSemanticDecompilation } from '../../../js/decompiler/pipeline-core.js';
import { applyPhase8Projection } from '../../../js/decompiler/phase8/projection.js';
import { validateRenderProvenance } from '../../../js/decompiler/phase8/render-provenance.js';
import { AnalysisQueryAPI } from '../../../js/analysis/query/api.js';
import { createDecompilerNavigation } from '../../../js/ui/decompiler-provenance.js';
import { fixture as irFixture } from '../helpers/ir-fixtures.mjs';
import { analysis } from './fixture.js';

const records = result => result.renderProvenance.ledger.filter(record => record.rule === 'render-compound-store');

function fixture({ bits = 32, op = 'add', one = false, reversed = false, different = false, repeat = false, onSymbol = null, options = {} } = {}) {
  const f = irFixture('compound_store_history'); f.block(0);
  const load = f.load(bits, { locKind:'global', locKey:'global:32768' });
  const operand = one ? f.constant(1n, bits) : f.opaque(bits); operand.reg = 'x0';
  const value = f.binary(op, reversed ? operand : load, reversed ? load : operand, bits);
  const store = f.store(value, { locKind:'global', locKey:different ? 'global:32776' : 'global:32768' });
  const second = repeat ? f.store(value, { locKind:'global', locKey:'global:32768' }) : null;
  const unrelated = f.store(value, { locKind:'global', locKey:'global:32784' });
  f.ret();
  const ir = f.build(); ir.instructions = ir.blocks.flatMap(block => block.insts);
  ir.instructions.forEach((inst, index) => { inst.id = index + 200; inst.row = index; inst.address = 0x8000n + BigInt(index * 4); });
  for (const inst of ir.instructions) if (inst.loc?.kind === 'global') inst.loc.address = BigInt(inst.loc.key.split(':')[1]);
  ir.blocks[0].startRow = 0;
  const ret = ir.instructions.at(-1); ret.args = [{ value }]; value.uses.push(ret);
  const seed = { semantic:true, ir, types:{ values:new Map(), locations:new Map() },
    lines:[store, second, unrelated, ret].filter(Boolean).map(inst => ({
      kind:'stmt', indent:1, text:inst.op === 'ret' ? 'return old;' : 'old = value;', row:inst.row, addr:inst.address,
    })), warnings:[], evidence:[], coverage:{ mode:'structured' }, summary:'' };
  const canonical = structuredClone(ir), roots = Object.entries(ir);
  const result = enhanceSemanticDecompilation(seed, { calls:[] }, { deterministicTransforms:true, ...options,
    ...(onSymbol ? { symbolFor:address => onSymbol({ address, ir, store, load, value }) } : {}),
  });
  return { result, ir, canonical, roots, load, operand, value, store, second, unrelated, ret };
}

function assertCanonical(f) {
  assert.deepEqual(structuredClone(f.ir), f.canonical);
  for (const [key, value] of f.roots) assert.equal(f.ir[key], value);
}

test('five actual compound-store spellings retain the load, arithmetic and store across eight widths', () => {
  let cells = 0;
  for (const bits of [1, 2, 3, 4, 8, 16, 32, 64]) for (const [op, one, form, spelling] of [
    ['add', true, 'post-increment', /\+\+;$/], ['sub', true, 'post-decrement', /--;$/],
    ['add', false, 'add-assignment', / \+= /], ['sub', false, 'sub-assignment', / -= /],
    ['mul', false, 'mul-assignment', / \*= /],
  ]) {
    const f = fixture({ bits, op, one });
    assert.match(f.result.cAst.body[0].text, spelling, `${bits}/${form}`);
    const result = applyPhase8Projection(f.result, analysis()), [record] = records(result);
    assert.equal(records(result).length, 1);
    assert.equal(record.before, 'store:assignment'); assert.equal(record.after, `store:${form}`);
    assert.equal(record.proof, 'observed-store-spelling-not-memory-equivalence');
    assert.equal(record.renderedBinding, 'producer-bound');
    assert.deepEqual(record.producedRefs, ['L0:stmt']);
    assert.deepEqual(record.originHistory.elidedRefs, [], 'implicit spelling does not delete a canonical memory input');
    for (const inst of [f.load.def, f.value.def, f.store]) {
      assert.ok(record.originHistory.consumedRefs.includes(`ir:${inst.id}`));
      assert.ok(record.originHistory.producedRefs.includes(`ir:${inst.id}`));
      assert.ok(result.renderProvenance.reverse[`addr:${inst.address}`].includes('L0:stmt'));
    }
    // The downstream owned projection currently reprints a full assignment.
    // This is historical spelling provenance, not a claim that ++ is current.
    assert.match(result.lines[0].text, / = /);
    assert.equal(validateRenderProvenance(result.renderProvenance).state, 'complete');
    assertCanonical(f); cells++;
  }
  assert.equal(cells, 40, 'source/spelling cells, not independent memory-equivalence proofs');
});

test('each actual store owns its event; equal expressions and return consumers cannot borrow it', () => {
  const f = fixture({ repeat:true });
  let result = applyPhase8Projection(f.result, analysis());
  const history = records(result);
  assert.equal(history.length, 2);
  assert.deepEqual(history.map(record => record.producedRefs), [['L0:stmt'], ['L1:stmt']]);
  for (const line of ['L2:stmt', 'L3:stmt']) {
    assert.ok(!result.renderProvenance.entities[line].recordRefs.some(index => result.renderProvenance.ledger[index].rule === 'render-compound-store'));
  }
  for (let i = 0; i < 3; i++) result = applyPhase8Projection(result, analysis());
  assert.deepEqual(records(result), history);
  assertCanonical(f);
});

test('different locations, reversed subtraction and non-rendered operators do not invent compound history', () => {
  for (const options of [{ different:true }, { op:'sub', reversed:true }, { op:'xor' }, { op:'udiv' }]) {
    const f = fixture(options);
    assert.match(f.result.cAst.body[0].text, / = /);
    assert.deepEqual(records(applyPhase8Projection(f.result, analysis())), []);
    assertCanonical(f);
  }
});

test('stale selected inputs, replaced instruction roots and copied descriptors cannot forge a store-render edge', () => {
  for (const mutate of [
    f => { f.store.loc.key = 'global:999'; },
    f => { f.load.def.loc.key = 'global:999'; },
    f => { f.value.def.sub = 'xor'; },
    f => { f.store.args[0].value = f.load; },
    f => { f.ir.instructions = [...f.ir.instructions]; },
    f => { f.ir.instructions[f.ir.instructions.indexOf(f.store)] = { ...f.store }; },
    f => { f.result.cAst.body[0].semantic = { ...f.result.cAst.body[0].semantic }; },
    f => { f.result.rewriteProof = f.result.rewriteProof.map(record => ({ ...record })); },
  ]) {
    const f = fixture(); mutate(f);
    const [record] = records(applyPhase8Projection(f.result, analysis()));
    assert.ok(record);
    assert.equal(record.renderedBinding, 'unresolved'); assert.deepEqual(record.producedRefs, []);
  }
});

test('budget and cancellation keep the existing compound spelling but report incomplete history', () => {
  const baseline = fixture({ one:true }).result.pseudocode;
  for (const options of [
    { renderProvenanceBudget:{ maxTransformRecords:0 } },
    { renderProvenanceBindingBudget:{ maxEdges:0 } },
    { renderProvenanceBindingBudget:{ maxConsumers:0 } },
    { shouldAbort:() => true },
  ]) {
    const f = fixture({ one:true, options });
    assert.equal(f.result.pseudocode, baseline);
    assert.equal(f.result.expressionHistoryBinding.completeness, 'incomplete');
    assert.equal(applyPhase8Projection(f.result, analysis()).renderProvenance.completeness, 'incomplete');
    assertCanonical(f);
  }
});

test('a later actual renderer callback cannot rebind an earlier compound store to changed operands', () => {
  let unrelatedLookups = 0;
  const f = fixture({ one:true, onSymbol:({ address, store, load }) => {
    // The unrelated store is rendered once in semantic facts and once in the
    // C AST. Only the latter follows the first compound-store emission.
    if (address === 32784n && ++unrelatedLookups === 2) store.args[0].value = load;
    return null;
  } });
  assert.equal(unrelatedLookups, 2);
  assert.match(f.result.cAst.body[0].text, /\+\+;$/);
  const [record] = records(applyPhase8Projection(f.result, analysis()));
  assert.ok(record, 'retain the actual past spelling, not a reconstructed event');
  assert.equal(record.renderedBinding, 'unresolved'); assert.deepEqual(record.producedRefs, []);
});

test('the per-function history limit retains only recorded events, never inferring omitted stores from source equality', () => {
  const f = fixture({ repeat:true, options:{ renderProvenanceBudget:{ maxTransformRecords:1 } } });
  assert.equal(f.result.rewriteProof.filter(record => record.rule === 'render-compound-store').length, 1);
  assert.ok(f.result.expressionHistoryBinding.reasons.includes('compound-store-history-budget'));
  const result = applyPhase8Projection(f.result, analysis());
  assert.deepEqual(records(result).map(record => record.producedRefs), [['L0:stmt']]);
  assert.equal(result.renderProvenance.completeness, 'incomplete');
  assertCanonical(f);
});

test('a deadline-skipped rewrite still records the actual mandatory store renderer', () => {
  const f = fixture({ one:true, options:{ deterministicTransforms:false, decompilerTimeBudgetMs:1e-12 } });
  assert.equal(f.result.passMetrics.find(pass => pass.name === 'semantic-rewrite')?.skipped, true);
  assert.match(f.result.cAst.body[0].text, /\+\+;$/);
  assert.equal(records(applyPhase8Projection(f.result, analysis()))[0].renderedBinding, 'producer-bound');
  assertCanonical(f);
});

test('query navigation reaches the actual store and retains the display-only disclaimer, then rejects stale snapshots', async () => {
  const f = fixture({ one:true }), result = applyPhase8Projection(f.result, analysis());
  let epoch = 1;
  const api = new AnalysisQueryAPI({
    currentIdentity:async () => ({ binaryId:'compound-store-history', projectRevision:1, analysisEpoch:epoch, artifactVersions:{} }),
    decompile:async () => ({ value:{ lines:result.lines, pseudocode:result.pseudocode, renderProvenance:result.renderProvenance }, status:{ completeness:'complete' } }),
  });
  const snapshot = await api.snapshot(), query = await api.decompile(snapshot, 'function');
  const navigation = createDecompilerNavigation(query, { currentSnapshot:() => api.snapshot() });
  for (const inst of [f.load.def, f.value.def, f.store]) {
    const selected = await navigation.selectOrigin('addr', inst.address);
    assert.equal(selected.state, 'ready');
    assert.ok(selected.entities.some(entity => entity.lineIndex === 0));
    assert.ok(selected.transforms.some(record => record.rule === 'render-compound-store'
      && record.proof === 'observed-store-spelling-not-memory-equivalence'));
  }
  epoch++;
  assert.equal((await navigation.selectOrigin('addr', f.store.address)).reason, 'stale-query-snapshot');
});

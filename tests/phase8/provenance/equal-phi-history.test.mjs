import assert from 'node:assert/strict';
import test from 'node:test';
import { enhanceSemanticDecompilation } from '../../../js/decompiler/pipeline-core.js';
import { applyPhase8Projection } from '../../../js/decompiler/phase8/projection.js';
import { validateRenderProvenance } from '../../../js/decompiler/phase8/render-provenance.js';
import { AnalysisQueryAPI } from '../../../js/analysis/query/api.js';
import { createDecompilerNavigation } from '../../../js/ui/decompiler-provenance.js';
import { fixture as irFixture } from '../helpers/ir-fixtures.mjs';
import { analysis } from './fixture.js';

const records = result => result.renderProvenance.ledger.filter(record => record.rule === 'collapse-equal-incoming-phi');

function fixture({ bits = 32, shared = false, different = false, nested = false, repeat = false, precomputed = false, mutateOnSymbol = null, options = {} } = {}) {
  const f = irFixture('equal_phi_history'); f.block(0);
  const input = f.opaque(bits); input.reg = 'x0'; input.signed = false;
  f.conditionalBranch(f.opaque(1), 1, 2);
  f.block(1); const left = shared ? f.copy(input, bits) : f.constant(0n, bits); f.branch(3);
  f.block(2); const right = shared ? f.copy(input, bits) : f.constant(different ? 1n : 0n, bits); f.branch(3);
  f.block(3); const phi = f.phi([[1, left], [2, right]], bits);
  if (precomputed) phi.const = 0n;
  const root = nested ? f.binary('xor', phi, f.constant(0n, bits), bits) : phi;
  if (repeat) f.store(root, { locKind:'global', locKey:'global:32768' });
  f.ret();
  const ir = f.build(); ir.instructions = ir.blocks.flatMap(block => [...block.phis, ...block.insts]);
  ir.instructions.forEach((inst, index) => { inst.id = index + 100; inst.row = index; inst.address = 0x6000n + BigInt(index * 4); });
  for (const block of ir.blocks) block.startRow = (block.phis[0] || block.insts[0]).row;
  const ret = ir.instructions.at(-1); ret.args = [{ value:root }]; root.uses.push(ret);
  const unrelated = { op:'ret', id:999, row:99, address:0x7000n, block:3, args:[{ value:shared ? input : left }] };
  ir.instructions.push(unrelated); ir.blocks[3].insts.push(unrelated);
  const seed = { semantic:true, ir, types:{ values:new Map(), locations:new Map() },
    lines:ir.instructions.filter(inst => ['store', 'ret'].includes(inst.op)).map(inst => ({
      kind:'stmt', indent:1, text:inst.op === 'ret' ? 'return old;' : 'old = value;', row:inst.row, addr:inst.address,
    })), warnings:[], evidence:[], coverage:{ mode:'structured' }, summary:'' };
  const canonical = structuredClone(ir), roots = Object.entries(ir);
  const result = enhanceSemanticDecompilation(seed, { calls:[] }, { deterministicTransforms:true, ...options,
    ...(mutateOnSymbol ? { symbolFor:() => { mutateOnSymbol({ ir, phi, left, right }); return 'global_value'; } } : {}),
  });
  return { result, ir, canonical, roots, input, left, right, phi, root, ret, unrelated };
}

function assertCanonical(f) {
  assert.deepEqual(structuredClone(f.ir), f.canonical);
  for (const [key, value] of f.roots) assert.equal(f.ir[key], value);
}

test('equal phi view collapse retains both incoming definitions and the phi across eight widths', () => {
  let cells = 0;
  for (const bits of [1, 2, 3, 4, 8, 16, 32, 64]) for (const shared of [false, true]) {
    const f = fixture({ bits, shared }), result = applyPhase8Projection(f.result, analysis());
    const [record] = records(result).filter(record => record.valueId === f.phi.id);
    assert.ok(record, `${bits}/${shared}`);
    assert.equal(record.proof, 'observed-phi-view-collapse-not-equivalence');
    assert.equal(record.renderedBinding, 'producer-bound');
    assert.deepEqual(record.producedRefs, ['L0:stmt']);
    for (const value of [f.left, f.right, f.phi]) {
      assert.ok(record.originHistory.consumedRefs.includes(`ir:${value.def.id}`));
      assert.ok(record.originHistory.consumedRefs.includes(`ssa:def:${value.id}`));
      assert.ok(result.renderProvenance.reverse[`addr:${value.def.address}`].includes('L0:stmt'));
    }
    assert.ok(record.originHistory.elidedRefs.includes(`ir:${f.phi.def.id}`));
    assert.ok(!result.renderProvenance.entities['L1:stmt'].recordRefs.some(index => result.renderProvenance.ledger[index].rule === record.rule));
    assert.equal(validateRenderProvenance(result.renderProvenance).state, 'complete');
    assertCanonical(f); cells++;
  }
  assert.equal(cells, 16, 'display-source matrix, not a phi/CFG equivalence theorem');
});

test('actual nested uses and multiple consumers inherit the builder event, not unrelated equal AST pointers', () => {
  const f = fixture({ shared:true, nested:true, repeat:true });
  let result = applyPhase8Projection(f.result, analysis());
  const record = records(result).find(record => record.valueId === f.root.id);
  assert.ok(record);
  assert.deepEqual(record.producedRefs, ['L0:stmt', 'L1:stmt']);
  assert.ok(!record.producedRefs.includes('L2:stmt'));
  const ledger = result.renderProvenance.ledger;
  for (let i = 0; i < 3; i++) result = applyPhase8Projection(result, analysis());
  assert.deepEqual(result.renderProvenance.ledger, ledger);
  assertCanonical(f);
});

test('a retained unequal phi does not get an elimination history', () => {
  const f = fixture({ different:true });
  const result = applyPhase8Projection(f.result, analysis());
  assert.equal(f.result.cAst.body[0].semantic.expression.phi, true);
  assert.deepEqual(records(result), []);
  assertCanonical(f);
});

test('an already-constant value does not invent a phi event from its unvisited canonical definition', () => {
  const f = fixture({ precomputed:true });
  assert.equal(f.result.cAst.body[0].semantic.expression.kind, 'const');
  assert.deepEqual(records(applyPhase8Projection(f.result, analysis())), []);
  assertCanonical(f);
});

test('a later render callback cannot bind an earlier phi selection to changed incoming edges', () => {
  let calls = 0;
  const f = fixture({ repeat:true, mutateOnSymbol:({ phi }) => { calls++; phi.def.incoming[1].from = 0; } });
  assert.ok(calls > 0);
  const history = records(applyPhase8Projection(f.result, analysis()));
  assert.ok(history.length > 0, 'the actual earlier builder event is retained');
  assert.ok(history.every(record => record.renderedBinding === 'unresolved' && record.producedRefs.length === 0));
  assert.ok(f.result.expressionHistoryBinding.reasons.includes('stale-expression-build-history'));
});

test('changed incoming edges/values, copied consumers and public history cannot forge the collapsed-phi edge', () => {
  for (const mutate of [
    f => { f.phi.def.incoming[1].from = 0; },
    f => { f.phi.def.incoming[1].value = f.left; },
    f => { f.right.const = 1n; },
    f => { f.result.cAst.body[0].semantic = { ...f.result.cAst.body[0].semantic }; },
    f => { f.result.rewriteProof = f.result.rewriteProof.map(record => ({ ...record })); },
  ]) {
    const f = fixture(); mutate(f);
    const history = records(applyPhase8Projection(f.result, analysis()));
    assert.ok(history.length > 0);
    assert.ok(history.every(record => record.renderedBinding === 'unresolved' && record.producedRefs.length === 0));
  }
});

test('history and observation limits preserve the actual selected expression while reporting incomplete provenance', () => {
  const baseline = fixture().result.pseudocode;
  for (const options of [
    { renderProvenanceBudget:{ maxTransformRecords:0 } },
    { renderProvenanceBindingBudget:{ maxEdges:0 } },
    { renderProvenanceBindingBudget:{ maxConsumers:0 } },
    { shouldAbort:() => true },
  ]) {
    const f = fixture({ options });
    assert.equal(f.result.pseudocode, baseline);
    assert.equal(f.result.expressionHistoryBinding.completeness, 'incomplete');
    assert.equal(applyPhase8Projection(f.result, analysis()).renderProvenance.completeness, 'incomplete');
    assertCanonical(f);
  }
});

test('deadline-skipped mandatory representation fallback retains collapsed-phi source history', () => {
  const f = fixture({ shared:true, options:{ deterministicTransforms:false, decompilerTimeBudgetMs:1e-12 } });
  assert.equal(f.result.passMetrics.find(pass => pass.name === 'semantic-rewrite')?.skipped, true);
  const history = records(applyPhase8Projection(f.result, analysis()));
  assert.ok(history.some(record => record.renderedBinding === 'producer-bound' && record.producedRefs.includes('L0:stmt')));
  assertCanonical(f);
});

test('query navigation resolves the elided phi and second incoming source to the real return, then rejects staleness', async () => {
  const f = fixture(), result = applyPhase8Projection(f.result, analysis());
  let epoch = 1;
  const api = new AnalysisQueryAPI({
    currentIdentity:async () => ({ binaryId:'equal-phi-history', projectRevision:1, analysisEpoch:epoch, artifactVersions:{} }),
    decompile:async () => ({ value:{ lines:result.lines, pseudocode:result.pseudocode, renderProvenance:result.renderProvenance }, status:{ completeness:'complete' } }),
  });
  const snapshot = await api.snapshot(), query = await api.decompile(snapshot, 'function');
  const navigation = createDecompilerNavigation(query, { currentSnapshot:() => api.snapshot() });
  for (const value of [f.phi, f.right]) {
    const selected = await navigation.selectOrigin('addr', value.def.address);
    assert.equal(selected.state, 'ready');
    assert.deepEqual(selected.entities.map(entity => entity.lineIndex), [0]);
    assert.ok(selected.transforms.some(record => record.rule === 'collapse-equal-incoming-phi'));
  }
  epoch++;
  assert.equal((await navigation.selectOrigin('addr', f.phi.def.address)).reason, 'stale-query-snapshot');
});

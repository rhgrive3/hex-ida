import assert from 'node:assert/strict';
import test from 'node:test';
import { enhanceSemanticDecompilation, readExpressionHistoryConsumer } from '../../../js/decompiler/pipeline-core.js';
import { enhanceSemanticDecompilation as enhancePublic } from '../../../js/decompiler/pipeline.js';
import { applyPhase8Projection } from '../../../js/decompiler/phase8/projection.js';
import { validateRenderProvenance } from '../../../js/decompiler/phase8/render-provenance.js';
import { structuralKey } from '../../../js/decompiler/ast/nodes.js';
import { AnalysisQueryAPI } from '../../../js/analysis/query/api.js';
import { createDecompilerNavigation } from '../../../js/ui/decompiler-provenance.js';
import { analysis } from './fixture.js';

function fixture(options = {}, { nested = false, repeat = false, publicPath = false } = {}) {
  const value = (id, kind = 'arg') => ({ id, kind, reg:`x${id}`, bits:64, signed:false, uses:[], def:null, const:null });
  const p = value(1), q = value(2), scalar = value(3), loaded = value(4, 'def'), unused = value(5, 'def');
  const instructions = [];
  const instruction = (op, dst, args, extra = {}) => {
    const row = instructions.length;
    const inst = { id:10 + row, row, address:0x9000n + BigInt(row * 4), block:0, op, dst,
      args:args.map(value => ({ value })), ...extra };
    if (dst) dst.def = inst;
    for (const v of args) v.uses.push(inst);
    instructions.push(inst);
    return inst;
  };
  const field = base => ({ kind:'field', key:`field:${base.id}:8`, disp:8n, size:8, base });
  const store = instruction('store', null, [scalar], { loc:field(p) });
  const innerValue = nested ? value(6, 'def') : null;
  const inner = nested ? instruction('load', innerValue, [], { loc:field(q) }) : null;
  const load = instruction('load', loaded, [], { loc:field(innerValue || q) });
  const unusedLoad = instruction('load', unused, [], { loc:field(p) });
  const reused = repeat ? instruction('store', null, [loaded], { loc:{ kind:'global', key:'global:40960', address:0xa000n } }) : null;
  const ret = instruction('ret', null, [loaded]);
  const unrelated = instruction('ret', null, [scalar]);
  const ir = { values:[p, q, scalar, loaded, unused, ...(nested ? [innerValue] : [])], instructions,
    args:new Map([['x1', p], ['x2', q], ['x3', scalar]]),
    blocks:[{ index:0, startRow:0, endRow:unrelated.row, pred:[], succ:[], insts:instructions }] };
  const seed = { semantic:true, ir, types:{ values:new Map(), locations:new Map() },
    lines:[store, ret, unrelated, reused].filter(Boolean).map(inst => ({ kind:'stmt', indent:1, row:inst.row, addr:inst.address,
      text:inst.op === 'ret' ? 'return old;' : 'old = value;' })),
    warnings:[], evidence:[], coverage:{ mode:'structured' }, summary:'' };
  const result = (publicPath ? enhancePublic : enhanceSemanticDecompilation)(seed, { calls:[] }, {
    deterministicTransforms:true, fieldFor:() => ({ name:'shared' }), ...options,
  });
  return { result, ir, p, q, scalar, store, load, unusedLoad, ret, inner };
}

const records = map => map.ledger.filter(record => record.rule === 'render-field-access');

test('C4-03 actual field accesses retain independent producer bindings despite equal field spelling', () => {
  const f = fixture(), canonical = structuredClone(f.ir);
  const original = f.result.cAst.body[1].semantic.expression;
  const key = structuralKey(original), source = structuredClone(original.source);
  const projected = applyPhase8Projection(f.result, analysis()), map = projected.renderProvenance;
  assert.equal(records(map).length, 2, 'an unused field expression is not an emitted field projection');
  assert.deepEqual(records(map).map(record => record.producedRefs), [['L0:stmt'], ['L1:stmt']]);
  assert.ok(records(map).every(record => record.renderedBinding === 'producer-bound'));
  assert.deepEqual(map.reverse[`addr:${f.store.address}`], ['L0:stmt']);
  assert.deepEqual(map.reverse[`addr:${f.load.address}`], ['L1:stmt']);
  assert.equal(map.reverse[`addr:${f.unusedLoad.address}`], undefined);
  assert.deepEqual(map.entities['L2:stmt'].recordRefs, []);
  assert.ok(map.entities['L0:stmt'].origins.ssaRefs.includes(`def:${f.p.id}`));
  assert.ok(map.entities['L1:stmt'].origins.ssaRefs.includes(`def:${f.q.id}`));
  assert.ok(!map.entities['L0:stmt'].origins.ssaRefs.includes(`def:${f.q.id}`));
  assert.ok(!map.entities['L1:stmt'].origins.ssaRefs.includes(`def:${f.p.id}`));
  assert.equal(validateRenderProvenance(map).state, 'complete');
  assert.deepEqual(f.ir, canonical);
  assert.equal(structuralKey(original), key);
  assert.deepEqual(original.source, source);
});

test('C4-03 field names remain presentation metadata and unavailable names keep generated spelling', () => {
  for (const fieldFor of [undefined, () => { throw new Error('no metadata'); }]) {
    const f = fixture({ fieldFor });
    assert.match(f.result.pseudocode, /field_8/);
    const map = applyPhase8Projection(f.result, analysis()).renderProvenance;
    assert.equal(records(map).length, 2);
    assert.ok(records(map).every(record => record.renderedBinding === 'producer-bound'));
    for (const record of f.result.rewriteProof.filter(record => record.rule === 'render-field-access')) {
      assert.equal(record.evidence.kind, 'canonical-memory-access-projection');
      assert.match(record.evidence.detail, /not type or layout proof/);
      assert.ok(Object.isFrozen(record.originHistory));
    }
  }
});

test('C4-03 copied field descriptors and changed canonical locations cannot replay field bindings', () => {
  for (const mutate of [
    f => { f.result.cAst.body[0].semantic = { ...f.result.cAst.body[0].semantic }; },
    f => { f.store.loc.disp = 16n; },
    f => { f.result.cAst.body[0].semantic.location.name = 'changed'; },
    f => { f.result.rewriteProof = f.result.rewriteProof.map(record => ({ ...record })); },
  ]) {
    const f = fixture();
    assert.ok(readExpressionHistoryConsumer(f.result.cAst.body[0].semantic, f.ir));
    mutate(f);
    const map = applyPhase8Projection(f.result, analysis()).renderProvenance;
    assert.equal(records(map)[0].renderedBinding, 'unresolved');
    assert.deepEqual(records(map)[0].producedRefs, []);
  }
});

test('C4-03 field history and observation limits preserve output while explicitly withholding complete provenance', () => {
  const text = fixture().result.pseudocode;
  for (const options of [
    { renderProvenanceBudget:{ maxTransformRecords:0 } },
    { renderProvenanceBudget:{ maxTransformRecords:1 } },
    { renderProvenanceBindingBudget:{ maxConsumers:0 } },
    { renderProvenanceBindingBudget:{ maxEdges:0 } },
  ]) {
    const f = fixture(options);
    assert.equal(f.result.pseudocode, text);
    assert.equal(f.result.expressionHistoryBinding.completeness, 'incomplete');
    assert.equal(applyPhase8Projection(f.result, analysis()).renderProvenance.completeness, 'incomplete');
  }
});

test('C4-03 repeated owned projections retain field history without turning it into new transformations', () => {
  let result = applyPhase8Projection(fixture().result, analysis());
  const expected = structuredClone(records(result.renderProvenance));
  for (let i = 0; i < 4; i++) {
    result = applyPhase8Projection(result, analysis());
    assert.deepEqual(records(result.renderProvenance), expected);
    assert.equal(result.phase8Projection.transforms.length, 0);
  }
});

test('C4-03 nested field bases retain both memory accesses and shared consumers reuse the actual record', () => {
  const f = fixture({}, { nested:true, repeat:true });
  assert.match(f.result.pseudocode, /shared.*shared/);
  const map = applyPhase8Projection(f.result, analysis()).renderProvenance;
  assert.equal(records(map).length, 3);
  assert.deepEqual(map.reverse[`addr:${f.inner.address}`], ['L1:stmt', 'L3:stmt']);
  assert.deepEqual(map.reverse[`addr:${f.load.address}`], ['L1:stmt', 'L3:stmt']);
  assert.ok(records(map).every(record => record.renderedBinding === 'producer-bound'));
  assert.equal(validateRenderProvenance(map).state, 'complete');
});

test('C4-03 public decompiler field history reaches canonical navigation and rejects a stale query snapshot', async () => {
  const f = fixture({}, { publicPath:true });
  const result = applyPhase8Projection(f.result, analysis());
  let epoch = 1;
  const api = new AnalysisQueryAPI({
    currentIdentity:async () => ({ binaryId:'field-render', projectRevision:1, analysisEpoch:epoch, artifactVersions:{} }),
    decompile:async () => ({ value:result, status:{ completeness:'complete' } }),
  });
  const snapshot = await api.snapshot(), query = await api.decompile(snapshot, 'function');
  const navigation = createDecompilerNavigation(query, { currentSnapshot:() => api.snapshot() });
  const selected = await navigation.selectOrigin('addr', f.load.address);
  assert.equal(selected.state, 'ready');
  assert.deepEqual(selected.entities.map(entity => entity.lineIndex), [1]);
  assert.ok(selected.transforms.some(record => record.rule === 'render-field-access' && record.renderedBinding === 'producer-bound'));
  const opened = [];
  await navigation.openAddress(f.load.address, address => opened.push(address));
  assert.deepEqual(opened, [f.load.address]);
  epoch++;
  assert.equal((await navigation.selectOrigin('addr', f.load.address)).reason, 'stale-query-snapshot');
});

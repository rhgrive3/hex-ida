import assert from 'node:assert/strict';
import test from 'node:test';
import { enhanceSemanticDecompilation, readExpressionHistoryConsumer } from '../../../js/decompiler/pipeline-core.js';
import { applyPhase8Projection } from '../../../js/decompiler/phase8/projection.js';
import { validateRenderProvenance } from '../../../js/decompiler/phase8/render-provenance.js';
import { AnalysisQueryAPI } from '../../../js/analysis/query/api.js';
import { createDecompilerNavigation } from '../../../js/ui/decompiler-provenance.js';
import { fixture as irFixture } from '../helpers/ir-fixtures.mjs';
import { analysis } from './fixture.js';

const families = ['madd', 'msub', 'bit_extract', 'max'];
const widths = [1, 2, 3, 4, 8, 16, 32, 64];
const idioms = result => result.rewriteProof.filter(record => record.phase === 'idiom');
const ledgerIdioms = result => result.renderProvenance.ledger.filter(record => record.phase === 'idiom');

function fixture(family, bits = 32, { options = {}, nested = false, negative = false, repeat = false } = {}) {
  const f = irFixture(`idiom_${family}_${bits}`); f.block(0);
  const input = f.opaque(bits), other = f.opaque(bits), third = f.opaque(bits);
  [input, other, third].forEach((value, index) => { value.reg = `x${index}`; value.signed = true; });
  let root;
  if (family === 'madd' || family === 'msub') {
    const product = f.binary(negative ? 'or' : 'mul', input, other, bits);
    root = f.binary(family === 'madd' ? 'add' : 'sub', product, third, bits);
  } else if (family === 'bit_extract') {
    const shifted = f.binary(negative ? 'shl' : 'lshr', input, f.constant(0n, bits), bits);
    root = f.binary('and', shifted, f.constant((1n << BigInt(Math.min(bits, 3))) - 1n, bits), bits);
  } else {
    const shifted = f.binary(negative ? 'lshr' : 'ashr', input, f.constant(BigInt(bits - 1), bits), bits);
    root = f.binary('and', input, f.unary('not', shifted, bits), bits);
  }
  const recognized = root;
  if (nested) root = f.binary('xor', root, third, bits);
  if (repeat) f.store(root, { locKind:'global', locKey:'global:24576' });
  f.ret();
  const ir = f.build(); ir.instructions = ir.blocks.flatMap(block => block.insts);
  ir.instructions.forEach((inst, index) => { inst.id = index + 100; inst.row = index; inst.address = 0x4000n + BigInt(index * 4); });
  const ret = ir.instructions.at(-1); ret.args = [{ value:root }]; root.uses.push(ret);
  const unrelated = { id:999, op:'ret', block:0, row:99, address:0x5000n, args:[{ value:third }] };
  ir.instructions.push(unrelated); ir.blocks[0].insts.push(unrelated);
  const seed = { semantic:true, ir, types:{ values:new Map(), locations:new Map() },
    lines:ir.instructions.filter(inst => ['store', 'ret'].includes(inst.op)).map(inst => ({
      kind:'stmt', indent:1, text:inst.op === 'ret' ? 'return old;' : 'old = value;', row:inst.row, addr:inst.address,
    })), warnings:[], evidence:[], coverage:{ mode:'structured' }, summary:'' };
  const canonical = structuredClone(ir);
  const roots = Object.entries(ir);
  const result = enhanceSemanticDecompilation(seed, { calls:[] }, { deterministicTransforms:true, ...options });
  return { result, ir, canonical, roots, recognized, root, ret, unrelated, input, third };
}

function assertCanonical(f) {
  // structuredClone preserves data, not the live DominanceView prototype.
  assert.deepEqual(structuredClone(f.ir), f.canonical);
  for (const [key, value] of f.roots) assert.equal(f.ir[key], value, `canonical root ${key}`);
}

test('every existing idiom family retains its actual producer history across eight widths', () => {
  let cells = 0;
  for (const family of families) for (const bits of widths) {
    const f = fixture(family, bits), result = applyPhase8Projection(f.result, analysis());
    const records = ledgerIdioms(result).filter(record => record.valueId === f.root.id);
    assert.equal(records.length, 1, `${family}/${bits}`);
    const [record] = records;
    assert.equal(record.rule, `recognize-${family}`);
    assert.equal(record.proof, 'legacy-idiom-recognition-not-equivalence');
    assert.equal(record.renderedBinding, 'producer-bound');
    assert.deepEqual(record.producedRefs, ['L0:stmt']);
    assert.ok(record.originHistory.consumedRefs.includes(`ir:${f.recognized.def.id}`));
    assert.ok(result.renderProvenance.transformReverse[`addr:${f.recognized.def.address}`].includes(result.renderProvenance.ledger.indexOf(record)));
    assert.ok(result.renderProvenance.entities['L1:stmt'].recordRefs.every(index => result.renderProvenance.ledger[index].phase !== 'idiom'));
    assert.equal(validateRenderProvenance(result.renderProvenance).state, 'complete');
    assertCanonical(f); cells++;
  }
  assert.equal(cells, 32, 'finite recognizer coverage, not a semantic equivalence proof');
});

test('nested and shared idiom results retain each actual consumer and survive repeated projections', () => {
  const f = fixture('madd', 32, { nested:true, repeat:true });
  let result = applyPhase8Projection(f.result, analysis());
  const records = ledgerIdioms(result).filter(record => record.valueId === f.root.id);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].producedRefs, ['L0:stmt', 'L1:stmt']);
  assert.equal(records[0].renderedBinding, 'producer-bound');
  const original = result.renderProvenance.ledger;
  for (let i = 0; i < 3; i++) result = applyPhase8Projection(result, analysis());
  assert.deepEqual(result.renderProvenance.ledger, original);
  assertCanonical(f);
});

test('nonmatching shapes do not acquire recognizer history', () => {
  for (const family of families) {
    const f = fixture(family, 32, { negative:true });
    assert.deepEqual(idioms(f.result), [], family);
    assert.deepEqual(ledgerIdioms(applyPhase8Projection(f.result, analysis())), []);
  }
});

test('copied consumer descriptors, modified definitions and edited public histories cannot bind an idiom', () => {
  for (const mutate of [
    f => { f.result.cAst.body[0].semantic = { ...f.result.cAst.body[0].semantic }; },
    f => { f.root.def.sub = 'or'; },
    f => { f.result.rewriteProof = f.result.rewriteProof.map(record => ({ ...record })); },
  ]) {
    const f = fixture('madd'); mutate(f);
    const result = applyPhase8Projection(f.result, analysis()), records = ledgerIdioms(result);
    assert.ok(records.length > 0);
    assert.ok(records.every(record => record.renderedBinding === 'unresolved'));
    assert.ok(records.every(record => record.producedRefs.length === 0));
  }
});

test('history or consumer budgets preserve recognizer output but cannot claim complete provenance', () => {
  const baseline = fixture('madd').result.pseudocode;
  for (const options of [
    { renderProvenanceBudget:{ maxTransformRecords:0 } },
    { renderProvenanceBindingBudget:{ maxEdges:0 } },
    { renderProvenanceBindingBudget:{ maxConsumers:0 } },
    { shouldAbort:() => true },
  ]) {
    const f = fixture('madd', 32, { options });
    assert.equal(f.result.pseudocode, baseline);
    assert.equal(f.result.expressionHistoryBinding.completeness, 'incomplete');
    const projected = applyPhase8Projection(f.result, analysis());
    assert.equal(projected.renderProvenance.completeness, 'incomplete');
  }
});

test('mandatory representation fallback retains its actual recognizer events when optional passes never ran', () => {
  const f = fixture('madd', 32, { options:{ deterministicTransforms:false, decompilerTimeBudgetMs:1e-12 } });
  assert.equal(f.result.passMetrics.find(pass => pass.name === 'semantic-rewrite')?.skipped, true);
  assert.ok(idioms(f.result).length > 0);
  const consumer = readExpressionHistoryConsumer(f.result.cAst.body[0].semantic, f.ir);
  assert.ok(consumer?.records.some(record => record.phase === 'idiom'));
  const records = ledgerIdioms(applyPhase8Projection(f.result, analysis()));
  assert.ok(records.some(record => record.renderedBinding === 'producer-bound' && record.producedRefs.includes('L0:stmt')));
  assertCanonical(f);
});

test('query navigation preserves the recognizer disclaimer and rejects stale snapshots', async () => {
  const f = fixture('madd'), result = applyPhase8Projection(f.result, analysis());
  let epoch = 1;
  const api = new AnalysisQueryAPI({
    currentIdentity:async () => ({ binaryId:'idiom-history', projectRevision:1, analysisEpoch:epoch, artifactVersions:{} }),
    decompile:async () => ({ value:{ lines:result.lines, pseudocode:result.pseudocode, renderProvenance:result.renderProvenance }, status:{ completeness:'complete' } }),
  });
  const snapshot = await api.snapshot(), query = await api.decompile(snapshot, 'function');
  const navigation = createDecompilerNavigation(query, { currentSnapshot:() => api.snapshot() });
  const selected = await navigation.selectOrigin('addr', f.root.def.address);
  assert.equal(selected.state, 'ready');
  assert.deepEqual(selected.entities.map(entity => entity.lineIndex), [0]);
  assert.equal(selected.transforms.find(record => record.phase === 'idiom').proof, 'legacy-idiom-recognition-not-equivalence');
  epoch++;
  assert.equal((await navigation.selectOrigin('addr', f.root.def.address)).reason, 'stale-query-snapshot');
});

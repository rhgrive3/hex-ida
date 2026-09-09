import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSemanticModel } from '../../../js/blocks.js';
import { decompile, decompileSemantic } from '../../../js/decompile.js';
import { enhanceSemanticDecompilation } from '../../../js/decompiler/pipeline-core.js';
import { structureKnownSwitches, normalizeCompatibilityLine } from '../../../js/decompiler/switch.js';
import { applyPhase8Projection } from '../../../js/decompiler/phase8/projection.js';
import { buildRenderProvenance, validateRenderProvenance } from '../../../js/decompiler/phase8/render-provenance.js';
import { analysis } from './fixture.js';
import { AnalysisQueryAPI } from '../../../js/analysis/query/api.js';
import { createDecompilerNavigation } from '../../../js/ui/decompiler-provenance.js';

function fixture({ options = {}, publicPath = false, mutate = null, name = 'kind', invalid = false } = {}) {
  const raw = [
    { row:0, address:0x1000n, mn:'br', ops:'x8' },
    { row:1, address:0x1004n, mn:'mov', ops:'x0, #1' },
    { row:2, address:0x1008n, mn:'ret', ops:'' },
    { row:3, address:0x100cn, mn:'mov', ops:'x0, #2' },
    { row:4, address:0x1010n, mn:'ret', ops:'' },
    { row:5, address:0x1014n, mn:'mov', ops:'x0, #3' },
    { row:6, address:0x1018n, mn:'ret', ops:'' },
  ];
  const rowOfAddress = addr => raw.find(inst => inst.address === BigInt(addr))?.row ?? null;
  const addrOfRow = row => raw[row]?.address ?? null;
  const model = buildSemanticModel(raw, { startRow:0, endRow:6, rowOfAddress, addrOfRow });
  const descriptor = { row:0, expr:name, cases:[{ value:0, address:0x1004n }, { value:1, address:0x100cn }],
    defaultAddress:invalid ? 'invalid' : 0x1014n };
  const opts = { addr:0x1000n, rowOfAddress, addrOfRow, beginner:false, deterministicTransforms:true,
    jumpTables:[descriptor], ...options };
  if (publicPath) return { result:decompile(model, opts), descriptor };
  const seed = structureKnownSwitches(decompileSemantic(model, opts), model, opts);
  const canonical = structuredClone({ instructions:seed.ir.instructions, values:seed.ir.values, blocks:seed.ir.blocks });
  mutate?.(seed, descriptor);
  return { result:enhanceSemanticDecompilation(seed, model, opts), seed, descriptor, canonical, model, opts };
}

const records = result => result.renderProvenance.ledger.filter(record => record.rule === 'render-switch');

test('C4-03 actual switch output spans retain branch origins and individual case targets', () => {
  const f = fixture(), result = applyPhase8Projection(f.result, analysis()), map = result.renderProvenance;
  assert.equal(records(result).length, 5);
  assert.deepEqual({ instructions:f.result.ir.instructions, values:f.result.ir.values, blocks:f.result.ir.blocks }, f.canonical);
  assert.ok(records(result).every(record => record.renderedBinding === 'producer-bound'), JSON.stringify(f.result.expressionHistoryBinding));
  const switchLines = result.lines.map((line, index) => ({ line, index })).filter(({ line }) => line.row === 0);
  for (const record of records(result)) assert.equal(record.producedRefs.length, 1);
  for (const { line, index } of switchLines.filter(({ line }) => /switch|case|default|^}$/.test(line.text))) {
    assert.ok(map.reverse['addr:4096'].includes(`L${index}:${line.kind}`));
    const entity = map.entities[`L${index}:${line.kind}`];
    if (line.text.startsWith('case 0:')) {
      assert.ok(entity.origins.addresses.includes('4100'));
      assert.ok(!entity.origins.addresses.includes('4108'));
    }
    if (line.text.startsWith('case 1:')) {
      assert.ok(entity.origins.addresses.includes('4108'));
      assert.ok(!entity.origins.addresses.includes('4100'));
    }
  }
  assert.ok(records(result)[0].removedRefs.length === 1, 'the replaced raw branch has a pre-transform tombstone');
  assert.equal(validateRenderProvenance(map).state, 'complete');
  assert.deepEqual({ instructions:f.result.ir.instructions, values:f.result.ir.values, blocks:f.result.ir.blocks }, f.canonical);
});

test('C4-03 public switch rendering carries the existing compatibility-name normalization', () => {
  const f = fixture({ publicPath:true, name:'local_ff' });
  assert.equal(f.result.semantic, false, 'disconnected indirect targets retain the existing faithful fallback');
  assert.ok(f.result.lines.some(line => /switch \(var_FF\)/.test(line.text)));
  const result = f.result;
  assert.equal(records(result).length, 5);
  assert.ok(records(result).every(record => record.renderedBinding === 'producer-bound'));
  assert.ok(result.renderProvenance.reasons.includes('missing-snapshot'), 'fallback does not manufacture analysis identity');
  const map = buildRenderProvenance({ result, snapshotId:'switch-fixture' });
  assert.equal(validateRenderProvenance(map, { snapshotId:'switch-fixture' }).state, 'complete');
});

test('C4-03 changed descriptors, targets or source lines cannot replay switch render history', () => {
  for (const mutate of [
    (seed, descriptor) => { descriptor.cases[0].address = 0x1014n; },
    seed => { seed.ir.instructions.find(inst => inst.address === 0x1004n).row = 99; },
    seed => { seed.ir.blocks = seed.ir.blocks.slice(); },
    seed => { seed.ir.instructions = seed.ir.instructions.map(inst => ({ ...inst })); },
    seed => { seed.lines.find(line => line.text.startsWith('switch')).text = 'switch (other) {'; },
    seed => { seed.lines = seed.lines.map(line => ({ ...line })); },
  ]) {
    const f = fixture({ mutate });
    assert.equal(records(applyPhase8Projection(f.result, analysis()))[0].renderedBinding, 'unresolved');
  }
});

test('C4-03 switch render artifacts navigate to the actual branch through a snapshot-bound query', async () => {
  const result = applyPhase8Projection(fixture().result, analysis());
  // Query values are cloneable data, not the live compatibility IR envelope
  // (which owns methods such as defUse). Exercise the actual rendered artifacts.
  const value = { pseudocode:result.pseudocode, lines:result.lines, renderProvenance:result.renderProvenance };
  let epoch = 1;
  const api = new AnalysisQueryAPI({
    currentIdentity:async () => ({ binaryId:'switch-render', projectRevision:1, analysisEpoch:epoch, artifactVersions:{} }),
    decompile:async () => ({ value, status:{ completeness:'complete' } }),
  });
  const snapshot = await api.snapshot(), query = await api.decompile(snapshot, 'function');
  const navigation = createDecompilerNavigation(query, { currentSnapshot:() => api.snapshot() });
  const selected = await navigation.selectOrigin('addr', 0x1000n);
  assert.equal(selected.state, 'ready');
  assert.equal(selected.transforms.filter(record => record.rule === 'render-switch').length, 5);
  const opened = [];
  await navigation.openAddress(0x1000n, address => opened.push(address));
  assert.deepEqual(opened, [0x1000n]);
  epoch++;
  assert.equal((await navigation.selectOrigin('addr', 0x1000n)).reason, 'stale-query-snapshot');
});

test('C4-03 a second actual switch insertion preserves prior history and does not invent another removal', () => {
  const f = fixture();
  structureKnownSwitches(f.seed, f.model, f.opts);
  const map = buildRenderProvenance({ result:f.seed, snapshotId:'switch-fixture' });
  const history = map.ledger.filter(record => record.rule === 'render-switch');
  assert.equal(history.length, 10);
  assert.ok(history.every(record => record.renderedBinding === 'producer-bound'));
  assert.equal(history.filter(record => record.removedRefs.length).length, 1);
});

test('C4-03 fallback copies cannot manufacture a producer or a complete switch history', () => {
  const result = fixture({ publicPath:true }).result;
  const copied = { ...result, lines:result.lines.map(line => ({ ...line })) };
  const map = buildRenderProvenance({ result:copied, snapshotId:'switch-fixture' });
  assert.equal(map.completeness, 'incomplete');
  assert.ok(map.reasons.includes('unavailable-switch-history'));
  assert.equal(map.ledger.filter(record => record.rule === 'render-switch').length, 0);
});

test('C4-03 altered C AST text or copied semantic metadata cannot carry a switch binding', () => {
  for (const mode of ['text', 'semantic']) {
    const f = fixture(), node = f.result.cAst.body.find(node => node.text.startsWith('switch'));
    if (mode === 'text') node.text = 'switch (other) {';
    else node.semantic = { ...node.semantic };
    assert.equal(records(applyPhase8Projection(f.result, analysis()))[0].renderedBinding, 'unresolved');
  }
});

test('C4-03 arbitrary edits followed by compatibility normalization do not regain switch authority', () => {
  const f = fixture({ mutate:seed => {
    const line = seed.lines.find(line => line.text.startsWith('switch'));
    line.text = 'switch (local_bad) {';
    normalizeCompatibilityLine(line, seed.ir);
  } });
  assert.equal(records(applyPhase8Projection(f.result, analysis()))[0].renderedBinding, 'unresolved');
});

test('C4-03 switch record and observation budgets preserve output but withhold completeness', () => {
  const text = fixture().result.pseudocode;
  for (const options of [
    { renderProvenanceBudget:{ maxTransformRecords:0 } },
    { renderProvenanceBudget:{ maxTransformRecords:2 } },
    { renderProvenanceBindingBudget:{ maxConsumers:0 } },
    { renderProvenanceBindingBudget:{ maxEdges:0 } },
  ]) {
    const f = fixture({ options });
    assert.equal(f.result.pseudocode, text);
    assert.equal(f.result.expressionHistoryBinding.completeness, 'incomplete');
    assert.equal(applyPhase8Projection(f.result, analysis()).renderProvenance.completeness, 'incomplete');
  }
});

test('C4-03 rejected switch descriptors emit no transformation history', () => {
  const f = fixture({ invalid:true });
  assert.ok(!f.result.pseudocode.includes('switch ('));
  assert.equal(records(applyPhase8Projection(f.result, analysis())).length, 0);
});

test('C4-03 repeated owned projection retains switch history without repeated adoption', () => {
  let result = applyPhase8Projection(fixture().result, analysis());
  const expected = structuredClone(records(result));
  for (let i = 0; i < 3; i++) {
    result = applyPhase8Projection(result, analysis());
    assert.deepEqual(records(result), expected);
    assert.equal(result.phase8Projection.transforms.length, 0);
  }
});

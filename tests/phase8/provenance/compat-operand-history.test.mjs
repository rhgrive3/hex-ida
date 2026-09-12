import assert from 'node:assert/strict';
import test from 'node:test';
import { stableDigest } from '../../../js/core/identity/index.js';
import { ownDataEntries, captureProjectionIrData, PROJECTION_LIMITS } from '../../../js/core/identity/live-data.js';
import { ownDataEntries as solverEntries } from '../../../js/symbolic/expr/data-boundary.js';
import { captureProjectionIrData as projectionCapture, PROJECTION_LIMITS as projectionLimits } from '../../../js/decompiler/phase8/projection-origin.js';
import { createSemanticIrFunction } from '../../../js/semantics/ir/function.js';
import { createSemanticCfg } from '../../../js/semantics/cfg/index.js';
import { createMemoryRegionRef } from '../../../js/semantics/memoryssa/contract.js';
import { buildMemorySsa, MEMORY_SSA_BUILD_VERSION } from '../../../js/semantics/memoryssa/build.js';
import { projectSemanticIrV2ToLegacyV1, readProjectedMemoryOperandTransition } from '../../../js/semantics/compat/semantic-ir-v2-to-v1.js';
import { attachMemorySsa } from '../../../js/semantics/compat/semantic-ir-v2-to-v1-memory.js';
import { enhanceSemanticDecompilation as enhanceCore, readExpressionHistoryConsumer } from '../../../js/decompiler/pipeline-core.js';
import { enhanceSemanticDecompilation as enhancePublic } from '../../../js/decompiler/pipeline.js';
import { applyPhase8Projection } from '../../../js/decompiler/phase8/projection.js';
import { validateRenderProvenance } from '../../../js/decompiler/phase8/render-provenance.js';
import { AnalysisQueryAPI } from '../../../js/analysis/query/api.js';
import { createDecompilerNavigation } from '../../../js/ui/decompiler-provenance.js';
import { analysis } from './fixture.js';
import { BRANCH, loadRoadmapManifest, validateRoadmapInventory } from '../../../tools/validation/analysis-roadmap/ownership.mjs';

const rule = 'project-stack-load-to-operand';
const records = result => result.renderProvenance.ledger.filter(record => record.rule === rule);
const data = ir => structuredClone(Object.fromEntries(Object.entries(ir).filter(([, value]) => typeof value !== 'function')));

// Real canonical stack-operand identity chain, as in compat-v1-memory-multi-use.
// The stored input is unknown, so this is not numeric constant forwarding.
function fixture({ bits = 32, endian = 'little', atomic = false } = {}) {
  const functionId = 'operand_history';
  const origin = (id, row) => ({ instructionIds:[id], virtualRanges:[{ start:0x4000n + BigInt(row * 4), end:0x4004n + BigInt(row * 4) }] });
  const addressType = { kind:'address', widthBits:64, addressSpace:'memory' }, type = { kind:'bitvector', widthBits:bits };
  const memory = valueId => ({ addressSpace:'memory', addressExpr:{ valueId }, widthBits:bits,
    endian, alignment:bits / 8, volatility:false, atomic, ordering:'unknown', faults:[] });
  const canonical = createSemanticIrFunction({ schemaVersion:2, contractVersion:'2.0.0', functionId, entryBlockId:'b0',
    blocks:[{ id:'b0', nodeIds:['n_store', 'n_load', 'n_ret', 'n_other'], origin:origin('block', 0) }],
    values:[
      { id:'store_addr', kind:'entry', machineType:addressType, sourceEntityId:functionId, origin:origin('store_addr', 0) },
      { id:'load_addr', kind:'entry', machineType:addressType, sourceEntityId:functionId, origin:origin('load_addr', 1) },
      { id:'stored', kind:'entry', machineType:type, sourceEntityId:functionId, origin:origin('stored', 2) },
      { id:'loaded', kind:'definition', machineType:type, definitionNodeId:'n_load', sourceEntityId:'n_load', origin:origin('loaded', 4) },
    ],
    nodes:[
      { id:'n_store', kind:'store', blockId:'b0', inputs:['store_addr', 'stored'], outputs:[], memory:memory('store_addr'), origin:origin('store', 3) },
      { id:'n_load', kind:'load', blockId:'b0', inputs:['load_addr'], outputs:['loaded'], memory:memory('load_addr'), origin:origin('load', 4) },
      { id:'n_ret', kind:'return', blockId:'b0', inputs:['loaded'], outputs:[], origin:origin('ret', 5) },
      { id:'n_other', kind:'return', blockId:'b0', inputs:['stored'], outputs:[], origin:origin('other', 6) },
    ], completeness:'complete', unknowns:[], origin:origin('function', 0) });
  const cfg = createSemanticCfg({ functionId, entryBlockId:'b0', blocks:[{ id:'b0', successors:[] }] });
  const region = createMemoryRegionRef({ id:'stack', kind:'stack-fixed', functionId, offset:'8', widthBits:bits,
    metadata:{ canonicalAddressIncludesOperationDisplacement:true }, origin:origin('region', 0) });
  const irIdentity = { functionId, semanticIrId:'ir', semanticIrContractVersion:'2.0.0', semanticIrDigest:stableDigest(canonical) };
  const memorySsa = buildMemorySsa(canonical, cfg, { regions:[region], resolveRegion:() => region,
    queryAlias:() => ({ relation:'must', reasonCodes:['same-fixture-region'], evidenceIds:['fixture-region'],
      proof:{ analyzerId:'phase7.alias.solver', analyzerVersion:'1.1.0', completeness:'complete', stopReason:null } }),
    identity:{ ...irIdentity, binaryId:'operand-history', sliceId:'slice', snapshotId:'snapshot',
      scalarSsaId:'ssa', scalarSsaBuildVersion:'1.0.0', scalarSsaDigest:'ssa-digest',
      memorySsaId:'mssa', memorySsaBuildVersion:MEMORY_SSA_BUILD_VERSION, analyzerVersion:'fixture' },
    snapshotId:'snapshot', canonicalIrIdentity:irIdentity });
  const ir = projectSemanticIrV2ToLegacyV1(canonical, { memorySsa, cfg });
  return { canonical, memorySsa, cfg, ir, load:ir.instructions.find(inst => inst.semanticNodeId === 'n_load'),
    store:ir.instructions.find(inst => inst.semanticNodeId === 'n_store') };
}

function render(f, { publicPipeline = false, ...options } = {}) {
  const canonical = data(f.ir), roots = Object.entries(f.ir);
  const returns = f.ir.instructions.filter(inst => inst.op === 'ret');
  const seed = { semantic:true, ir:f.ir, types:{ values:new Map(), locations:new Map() },
    lines:returns.map(inst => ({ kind:'stmt', indent:1, text:'return old;', row:inst.row, addr:inst.address })),
    warnings:[], evidence:[], coverage:{ mode:'structured' }, summary:'' };
  const result = (publicPipeline ? enhancePublic : enhanceCore)(seed, { calls:[] }, { deterministicTransforms:true, ...options });
  return { ...f, result, prior:canonical, roots };
}
function projected(f) { return applyPhase8Projection(f.result, analysis()); }
function unchanged(f) {
  assert.deepEqual(data(f.ir), f.prior);
  for (const [key, value] of f.roots) assert.equal(f.ir[key], value);
}

test('shared observation entry points are the identical existing functions and limits', () => {
  assert.equal(solverEntries, ownDataEntries);
  assert.equal(projectionCapture, captureProjectionIrData);
  assert.equal(projectionLimits, PROJECTION_LIMITS);
  const root = { uses:[], value:1n }; root.self = root;
  const observed = captureProjectionIrData([root]);
  assert.equal(observed.matches(), true);
  root.value = 2n; assert.equal(observed.matches(), false);
  assert.throws(() => captureProjectionIrData([new Map()]), /prototype/);
});

test('shared observer and projector finalization ownership is exact, not a core/compatibility blanket exemption', () => {
  const manifest = loadRoadmapManifest(), files = Object.values(manifest.owners).flat();
  for (const file of ['js/core/identity/live-data.js', 'js/semantics/compat/semantic-ir-v2-to-v1.js']) {
    assert.ok(manifest.owners.semanticCompat.includes(file));
  }
  for (const phase of ['phase7', 'phase8']) {
    assert.doesNotThrow(() => validateRoadmapInventory(BRANCH, phase, files));
    for (const foreign of ['js/core/identity/index.js', 'js/core/identity/unreviewed.js', 'js/semantics/compat/unreviewed.js']) {
      assert.throws(() => validateRoadmapInventory(BRANCH, phase, [...files, foreign]), /undeclared/);
    }
  }
});

test('real LOAD-to-MOV transitions retain original load/store/address sources across widths and endianness', () => {
  let cells = 0;
  for (const bits of [8, 16, 32, 64]) for (const endian of ['little', 'big']) {
    const raw = fixture({ bits, endian });
    assert.equal(raw.load.op, 'mov');
    assert.equal(raw.load.dst.const, null);
    const producer = readProjectedMemoryOperandTransition(raw.ir, raw.load);
    assert.ok(producer, `${bits}/${endian}`);
    assert.equal(producer.memory, raw.load.extra.memoryAccess, 'retain the original projected access object');
    assert.deepEqual(producer.memory, raw.canonical.nodes.find(node => node.id === 'n_load').memory);
    const f = render(raw), result = projected(f), [record] = records(result);
    assert.equal(records(result).length, 1);
    assert.equal(record.proof, 'observed-compat-memory-transition-not-new-proof');
    assert.equal(record.before, 'load:canonical-stack-operand');
    assert.equal(record.after, 'mov:memory-forward');
    assert.equal(record.renderedBinding, 'producer-bound');
    assert.deepEqual(record.producedRefs, ['L0:stmt']);
    for (const inst of [raw.load, raw.store]) {
      assert.ok(record.originHistory.consumedRefs.includes(`ir:${inst.id}`));
      assert.deepEqual(result.renderProvenance.reverse[`addr:${inst.address}`], ['L0:stmt']);
    }
    for (const input of producer.beforeInputs) assert.ok(record.originHistory.consumedRefs.includes(`ssa:def:${input.id}`));
    assert.ok(result.renderProvenance.ledger.some(record => record.rule === 'select-mov-operand' && record.producedRefs.includes('L0:stmt')));
    assert.equal(validateRenderProvenance(result.renderProvenance).state, 'complete');
    assert.deepEqual(result.renderProvenance.entities['L1:stmt'].recordRefs, []);
    unchanged(f); cells++;
  }
  assert.equal(cells, 8, 'observed source cells, not eight new memory theorems');
});

test('public rendering and repeated owned projection retain the original compatibility producer', () => {
  const f = render(fixture(), { publicPipeline:true });
  let result = projected(f);
  assert.equal(records(result)[0].renderedBinding, 'producer-bound');
  const ledger = result.renderProvenance.ledger;
  for (let i = 0; i < 3; i++) result = applyPhase8Projection(result, analysis());
  assert.deepEqual(result.renderProvenance.ledger, ledger);
  unchanged(f);
});

test('changes before first rendering cannot reseal a copied proof, altered source or root', () => {
  for (const mutate of [
    f => { f.load.memoryOperandForwarding = { ...f.load.memoryOperandForwarding }; },
    f => { f.load.extra.memoryAccess = { ...f.load.extra.memoryAccess }; },
    f => { f.store.args[0].value = f.load.dst; },
    f => { f.load.id++; },
    f => { f.ir.instructions = [...f.ir.instructions]; },
    f => { f.ir.values = [...f.ir.values]; },
    f => { const input = f.load.args[0].value; f.ir.values[f.ir.values.indexOf(input)] = { ...input }; },
    f => { f.ir.blocks[0].index = 99; },
    f => { f.ir = { ...f.ir }; },
    f => { f.load.sub = null; delete f.load.extra.originalMemoryOp; },
  ]) {
    const f = fixture();
    assert.ok(readProjectedMemoryOperandTransition(f.ir, f.load));
    mutate(f);
    assert.equal(readProjectedMemoryOperandTransition(f.ir, f.load), null);
    const rendered = render(f), result = projected(rendered);
    assert.deepEqual(records(result), []);
    assert.equal(result.renderProvenance.completeness, 'incomplete');
    unchanged(rendered);
  }
});

test('changes after rendering revoke both upstream transition and actual expression-consumer binding', () => {
  for (const mutate of [
    f => { f.store.semanticNodeId = 'other-store'; },
    f => { f.ir.blocks[0].insts = [...f.ir.blocks[0].insts]; },
    f => { f.load.args[0].value = f.load.dst; },
    f => { f.result.cAst.body[0].semantic = { ...f.result.cAst.body[0].semantic }; },
  ]) {
    const f = render(fixture());
    assert.ok(readExpressionHistoryConsumer(f.result.cAst.body[0].semantic, f.ir));
    mutate(f);
    assert.equal(readExpressionHistoryConsumer(f.result.cAst.body[0].semantic, f.ir), null);
    assert.ok(records(projected(f)).every(record => record.renderedBinding === 'unresolved' && record.producedRefs.length === 0));
  }
});

test('public ledger copies and independently produced same-shaped projections cannot transfer private authority', () => {
  const f = render(fixture()), other = fixture();
  assert.equal(readProjectedMemoryOperandTransition(other.ir, f.load), null);
  f.result.rewriteProof = f.result.rewriteProof.map(record => ({ ...record }));
  assert.ok(readExpressionHistoryConsumer(f.result.cAst.body[0].semantic, f.ir));
  assert.ok(records(projected(f)).every(record => record.renderedBinding === 'unresolved'));
});

test('calling the exported memory attachment helper cannot issue a projector-owned transition on a copied IR', () => {
  const original = fixture(), ir = data(original.ir);
  const load = ir.instructions.find(inst => inst.semanticNodeId === 'n_load');
  load.op = 'load'; load.sub = null;
  load.args = [{ value:load.addr.base }];
  const values = new Map(ir.values.map(value => [value.semanticValueId, value]));
  const instructions = new Map(ir.instructions.map(inst => [inst.semanticNodeId, inst]));
  const descriptions = attachMemorySsa(ir, original.memorySsa, values, instructions, new Map([['b0', 0]]), original.canonical);
  assert.equal(load.op, 'mov');
  assert.equal(descriptions.length, 1, 'the helper performed the operation but cannot register private finalization authority');
  assert.equal(readProjectedMemoryOperandTransition(ir, load), null);
  const rendered = render({ ...original, ir, load, store:instructions.get('n_store') });
  const result = projected(rendered);
  assert.deepEqual(records(result), []);
  assert.equal(result.renderProvenance.completeness, 'incomplete');
});

test('source getters are refused without invocation and unknown memory does not invent an executed transition', () => {
  const f = fixture(), original = f.load.id;
  let reads = 0;
  Object.defineProperty(f.load, 'id', { enumerable:true, configurable:true, get:() => { reads++; return original; } });
  assert.equal(readProjectedMemoryOperandTransition(f.ir, f.load), null);
  assert.equal(reads, 0);
  const unknown = fixture({ atomic:true });
  assert.equal(unknown.load.op, 'load');
  assert.equal(readProjectedMemoryOperandTransition(unknown.ir, unknown.load), null);
  assert.deepEqual(records(projected(render(unknown))), []);
});

test('history budgets and mandatory fallback preserve output while distinguishing unavailable mapping', () => {
  const baseline = render(fixture()).result.pseudocode;
  for (const options of [
    { deterministicTransforms:false, decompilerTimeBudgetMs:1e-12 },
    { renderProvenanceBudget:{ maxTransformRecords:0 } },
    { renderProvenanceBindingBudget:{ maxEdges:0 } },
    { renderProvenanceBindingBudget:{ maxConsumers:0 } },
    { shouldAbort:() => true },
  ]) {
    const f = render(fixture(), options), result = projected(f);
    assert.equal(f.result.pseudocode, baseline);
    if (options.deterministicTransforms === false) assert.ok(records(result).some(record => record.renderedBinding === 'producer-bound'));
    else assert.equal(result.renderProvenance.completeness, 'incomplete');
    unchanged(f);
  }
});

test('query navigation reaches the removed load original STORE dependency and refuses stale snapshots', async () => {
  const f = render(fixture()), result = projected(f);
  let epoch = 1;
  const api = new AnalysisQueryAPI({
    currentIdentity:async () => ({ binaryId:'operand-history', projectRevision:1, analysisEpoch:epoch, artifactVersions:{} }),
    decompile:async () => ({ value:{ lines:result.lines, pseudocode:result.pseudocode, renderProvenance:result.renderProvenance }, status:{ completeness:'complete' } }),
  });
  const snapshot = await api.snapshot(), query = await api.decompile(snapshot, 'function');
  const navigation = createDecompilerNavigation(query, { currentSnapshot:() => api.snapshot() });
  const selected = await navigation.selectOrigin('addr', f.store.address);
  assert.equal(selected.state, 'ready');
  assert.deepEqual(selected.entities.map(entity => entity.lineIndex), [0]);
  assert.ok(selected.transforms.some(record => record.rule === rule));
  epoch++;
  assert.equal((await navigation.selectOrigin('addr', f.store.address)).reason, 'stale-query-snapshot');
});

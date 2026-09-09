import assert from 'node:assert/strict';
import test from 'node:test';
import { enhanceSemanticDecompilation, readExpressionHistoryConsumer } from '../../../js/decompiler/pipeline-core.js';
import { enhanceSemanticDecompilation as enhancePublic } from '../../../js/decompiler/pipeline.js';
import { applyPhase8Projection } from '../../../js/decompiler/phase8/projection.js';
import { validateRenderProvenance } from '../../../js/decompiler/phase8/render-provenance.js';
import { fixture as irFixture } from '../helpers/ir-fixtures.mjs';
import { analysis } from './fixture.js';
import { createSemanticIrFunction } from '../../../js/semantics/ir/function.js';
import { createSemanticCfg } from '../../../js/semantics/cfg/index.js';
import { createMemoryRegionRef } from '../../../js/semantics/memoryssa/contract.js';
import { buildMemorySsa, MEMORY_SSA_BUILD_VERSION } from '../../../js/semantics/memoryssa/build.js';
import { projectSemanticIrV2ToLegacyV1 } from '../../../js/semantics/compat/semantic-ir-v2-to-v1.js';
import { isCanonicalExactMemoryForwarding, canonicalMemoryForwardingContextForLoad } from '../../../js/semantics/memoryssa/queries.js';
import { stableDigest } from '../../../js/core/identity/index.js';
import { AnalysisQueryAPI } from '../../../js/analysis/query/api.js';
import { createDecompilerNavigation } from '../../../js/ui/decompiler-provenance.js';

const rule = 'select-precomputed-value';
const records = result => result.renderProvenance.ledger.filter(record => record.rule === rule);
const loadRule = 'select-canonical-load-constant';
const loadRecords = result => result.renderProvenance.ledger.filter(record => record.rule === loadRule);
const canonicalData = ir => structuredClone(Object.fromEntries(Object.entries(ir).filter(([, value]) => typeof value !== 'function')));

function render(ir, target, unrelated, options = {}, publicPipeline = false) {
  const returns = ir.instructions.filter(inst => inst.op === 'ret');
  returns[0].args = [{ value:target }];
  if (unrelated) {
    const last = ir.blocks.at(-1), ret = { id:999, row:99, address:0x7000n, block:last.index, op:'ret', args:[{ value:unrelated }] };
    ir.instructions.push(ret); last.insts.push(ret); returns.push(ret);
  }
  const canonical = canonicalData(ir), roots = Object.entries(ir);
  const seed = { semantic:true, ir, types:{ values:new Map(), locations:new Map() },
    lines:returns.map(inst => ({ kind:'stmt', indent:1, text:'return old;', row:inst.row, addr:inst.address })),
    warnings:[], evidence:[], coverage:{ mode:'structured' }, summary:'' };
  const result = (publicPipeline ? enhancePublic : enhanceSemanticDecompilation)(seed, { calls:[] }, { deterministicTransforms:true, ...options });
  return { result, ir, canonical, roots, target };
}

function fixture({ bits = 32, kind = 'bin', floating = false, precomputed = true, publicPipeline = false, options = {} } = {}) {
  const f = irFixture('precomputed_history'); f.block(0);
  let left, right, target;
  if (kind === 'phi') {
    f.conditionalBranch(f.opaque(1), 1, 2);
    f.block(1); left = f.constant(1n, bits); f.branch(3);
    f.block(2); right = f.constant(2n, bits); f.branch(3);
    f.block(3); target = f.phi([[1, left], [2, right]], bits);
  } else {
    left = f.constant(1n, bits); right = f.constant(2n, bits);
    const sum = f.binary('add', left, right, bits);
    if (kind === 'load') {
      const store = f.store(left, { locKind:'global', locKey:'global:32768' });
      target = f.load(bits, { locKind:'global', locKey:'global:32768' });
      target.def.reachingStore = store;
    } else target = kind === 'mov' ? f.copy(sum, bits) : sum;
  }
  if (precomputed) {
    if (floating) { target.floatConst = 1.25; target.constKind = 'float'; }
    else target.const = BigInt.asUintN(bits, 3n);
  }
  f.ret();
  const ir = f.build(); ir.instructions = ir.blocks.flatMap(block => [...block.phis, ...block.insts]);
  ir.instructions.forEach((inst, index) => { inst.id = index + 100; inst.row = index; inst.address = 0x6000n + BigInt(index * 4); });
  for (const block of ir.blocks) block.startRow = (block.phis[0] || block.insts[0]).row;
  return { ...render(ir, target, left, options, publicPipeline), left, right };
}

// Same real IR -> CFG -> MemorySSA -> compatibility chain used by the existing
// C2-01 byte-forwarding regressions. No fabricated exact fact/provider token.
function canonicalLoad(bits = 32) {
  const origin = (id, index) => ({ instructionIds:[id], virtualRanges:[{ start:0x3000n + BigInt(index * 4), end:0x3004n + BigInt(index * 4) }] });
  const type = { kind:'bitvector', widthBits:bits }, address = { kind:'address', widthBits:64, addressSpace:'memory' };
  const value = (id, node, machineType, index) => ({ id, kind:'definition', machineType,
    definitionNodeId:node, sourceEntityId:node, origin:origin(id, index) });
  const access = () => ({ addressSpace:'memory', addressExpr:{ valueId:'addr' }, widthBits:bits,
    endian:'little', alignment:bits / 8, volatility:false, atomic:false, ordering:'unknown', faults:[] });
  const nodes = [
    { id:'n_addr', kind:'address', blockId:'b0', inputs:[], outputs:['addr'], attributes:{ value:'0x4000' }, origin:origin('addr', 0) },
    { id:'n_value', kind:'const', blockId:'b0', inputs:[], outputs:['stored'], attributes:{ value:37 }, origin:origin('value', 1) },
    { id:'n_store', kind:'store', blockId:'b0', inputs:['addr', 'stored'], outputs:[], memory:access(), origin:origin('store', 2) },
    { id:'n_load', kind:'load', blockId:'b0', inputs:['addr'], outputs:['loaded'], memory:access(), origin:origin('load', 3) },
    { id:'n_return', kind:'return', blockId:'b0', inputs:['loaded'], outputs:[], origin:origin('return', 4) },
  ];
  const canonicalIr = createSemanticIrFunction({ schemaVersion:2, contractVersion:'2.0.0', functionId:'precomputed_load', entryBlockId:'b0',
    blocks:[{ id:'b0', nodeIds:nodes.map(node => node.id), origin:origin('block', 0) }], nodes,
    values:[value('addr', 'n_addr', address, 0), { ...value('stored', 'n_value', type, 1), metadata:{ constant:{ kind:'bitvector', widthBits:bits, value:37n } } }, value('loaded', 'n_load', type, 3)],
    completeness:'complete', unknowns:[], origin:origin('function', 0) });
  const cfg = createSemanticCfg({ functionId:canonicalIr.functionId, entryBlockId:'b0', blocks:[{ id:'b0', successors:[] }] });
  const region = createMemoryRegionRef({ id:'global', kind:'global-absolute', binaryId:'constant-history', address:'0x4000', widthBits:bits, origin:origin('region', 0) });
  const irIdentity = { functionId:canonicalIr.functionId, semanticIrId:'ir', semanticIrContractVersion:'2.0.0', semanticIrDigest:stableDigest(canonicalIr) };
  const memorySsa = buildMemorySsa(canonicalIr, cfg, { regions:[region], resolveRegion:() => region,
    queryAlias:() => ({ relation:'must', reasonCodes:['identical-region-identity'], evidenceIds:['canonical-fixture-alias'],
      proof:{ analyzerId:'phase7.alias.solver', analyzerVersion:'1.1.0', completeness:'complete', stopReason:null } }),
    identity:{ ...irIdentity, binaryId:'constant-history', sliceId:'slice', snapshotId:'snapshot',
      scalarSsaId:'ssa', scalarSsaBuildVersion:'1.0.0', scalarSsaDigest:'ssa-digest',
      memorySsaId:'mssa', memorySsaBuildVersion:MEMORY_SSA_BUILD_VERSION, analyzerVersion:'memoryssa-fixture' },
    snapshotId:'snapshot', canonicalIrIdentity:irIdentity });
  const ir = projectSemanticIrV2ToLegacyV1(canonicalIr, { memorySsa, cfg });
  const load = ir.instructions.find(inst => inst.semanticNodeId === 'n_load');
  assert.equal(load.dst.const, 37n);
  assert.ok(isCanonicalExactMemoryForwarding(load.memoryForwarding, canonicalMemoryForwardingContextForLoad(load.memoryForwarding, load, load.memoryForwardingContext)));
  return { ir, load, store:ir.instructions.find(inst => inst.semanticNodeId === 'n_store') };
}

function assertCanonical(f) {
  assert.deepEqual(canonicalData(f.ir), f.canonical);
  for (const [key, value] of f.roots) assert.equal(f.ir[key], value);
}

function explicitLoad(bits = 32) {
  const m = canonicalLoad(bits);
  // Compatibility normally supplies this constant already. Removing only the
  // cached scalar value exercises the lower builder gate without changing its
  // canonical MemorySSA fact or independently supplied current load context.
  m.load.dst.const = null;
  assert.ok(isCanonicalExactMemoryForwarding(m.load.memoryForwarding,
    canonicalMemoryForwardingContextForLoad(m.load.memoryForwarding, m.load, m.load.memoryForwardingContext)));
  return m;
}

test('explicit canonical numeric-load selection retains load/store sources at four widths through public rendering and replay', () => {
  for (const bits of [8, 16, 32, 64]) {
    const m = explicitLoad(bits), f = render(m.ir, m.load.dst, null, {}, true);
    assert.equal(f.result.cAst.body[0].semantic.expression.value, 37n);
    let result = applyPhase8Projection(f.result, analysis());
    const history = loadRecords(result);
    assert.equal(history.length, 1);
    const [record] = history;
    assert.equal(record.before, 'load:canonical-numeric-forwarding');
    assert.equal(record.proof, 'observed-canonical-load-selection-not-new-memory-proof');
    assert.equal(record.renderedBinding, 'producer-bound');
    assert.deepEqual(record.producedRefs, ['L0:stmt']);
    for (const inst of [m.load, m.store, m.store.args[0].value.def]) {
      assert.ok(record.originHistory.consumedRefs.includes(`ir:${inst.id}`));
      assert.ok(result.renderProvenance.reverse[`addr:${inst.address}`].includes('L0:stmt'));
    }
    assert.equal(validateRenderProvenance(result.renderProvenance).state, 'complete');
    assert.deepEqual(records(result), [], 'a visited lower branch is not a supplied precomputed-value selection');
    const ledger = result.renderProvenance.ledger;
    for (let i = 0; i < 3; i++) result = applyPhase8Projection(result, analysis());
    assert.deepEqual(result.renderProvenance.ledger, ledger);
    assertCanonical(f);
  }
});

test('unvisited or uncertified numeric-load branches cannot issue canonical selection history', () => {
  const supplied = canonicalLoad(), precomputed = render(supplied.ir, supplied.load.dst, null);
  assert.deepEqual(loadRecords(applyPhase8Projection(precomputed.result, analysis())), []);
  for (const mutate of [
    m => { m.load.memoryForwarding = { ...m.load.memoryForwarding }; },
    m => { m.load.memoryForwardingContext = { ...m.load.memoryForwardingContext, snapshotId:'stale' }; },
    m => { m.load.memoryForwarding = null; },
  ]) {
    const m = explicitLoad(); mutate(m);
    const f = render(m.ir, m.load.dst, null), result = applyPhase8Projection(f.result, analysis());
    assert.equal(f.result.cAst.body[0].semantic.expression.kind, 'load');
    assert.deepEqual(loadRecords(result), []);
    assertCanonical(f);
  }
});

test('canonical numeric-load history refuses changed private source roots, facts, contexts and public copies', () => {
  for (const [index, mutate] of [
    m => { m.load.memoryForwarding = { ...m.load.memoryForwarding }; },
    m => { m.load.memoryForwardingContext = { ...m.load.memoryForwardingContext, snapshotId:'stale' }; },
    m => { m.store.semanticNodeId = 'other-store'; },
    m => { m.ir.instructions = [...m.ir.instructions]; },
    (m, f) => { f.result.cAst.body[0].semantic = { ...f.result.cAst.body[0].semantic }; },
    (m, f) => { f.result.rewriteProof = f.result.rewriteProof.map(record => ({ ...record })); },
  ].entries()) {
    const m = explicitLoad(), f = render(m.ir, m.load.dst, null);
    assert.ok(readExpressionHistoryConsumer(f.result.cAst.body[0].semantic, m.ir));
    mutate(m, f);
    assert.equal(readExpressionHistoryConsumer(f.result.cAst.body[0].semantic, m.ir) !== null, index === 5);
    const history = loadRecords(applyPhase8Projection(f.result, analysis()));
    assert.ok(history.length > 0);
    assert.ok(history.every(record => record.renderedBinding === 'unresolved' && record.producedRefs.length === 0));
  }
});

test('canonical numeric-load fallback and history limits preserve scalar output without inventing complete history', () => {
  const m = explicitLoad(), baseline = render(m.ir, m.load.dst, null).result.pseudocode;
  for (const options of [
    { deterministicTransforms:false, decompilerTimeBudgetMs:1e-12 },
    { renderProvenanceBudget:{ maxTransformRecords:0 } },
    { renderProvenanceBindingBudget:{ maxEdges:0 } },
    { renderProvenanceBindingBudget:{ maxConsumers:0 } },
    { shouldAbort:() => true },
  ]) {
    const m = explicitLoad(), f = render(m.ir, m.load.dst, null, options);
    const result = applyPhase8Projection(f.result, analysis());
    assert.equal(f.result.pseudocode, baseline);
    if (options.deterministicTransforms === false) {
      assert.ok(loadRecords(result).some(record => record.renderedBinding === 'producer-bound' && record.producedRefs.includes('L0:stmt')));
      assert.ok(result.renderProvenance.reverse[`addr:${m.store.address}`].includes('L0:stmt'));
    } else assert.equal(result.renderProvenance.completeness, 'incomplete');
    assertCanonical(f);
  }
});

test('canonical numeric-load query navigates its selected-away store and rejects stale snapshots', async () => {
  const m = explicitLoad(), f = render(m.ir, m.load.dst, null);
  const result = applyPhase8Projection(f.result, analysis());
  let epoch = 1;
  const api = new AnalysisQueryAPI({
    currentIdentity:async () => ({ binaryId:'explicit-load-history', projectRevision:1, analysisEpoch:epoch, artifactVersions:{} }),
    decompile:async () => ({ value:{ lines:result.lines, pseudocode:result.pseudocode, renderProvenance:result.renderProvenance }, status:{ completeness:'complete' } }),
  });
  const snapshot = await api.snapshot(), query = await api.decompile(snapshot, 'function');
  const navigation = createDecompilerNavigation(query, { currentSnapshot:() => api.snapshot() });
  const selected = await navigation.selectOrigin('addr', m.store.address);
  assert.equal(selected.state, 'ready');
  assert.deepEqual(selected.entities.map(entity => entity.lineIndex), [0]);
  assert.ok(selected.transforms.some(record => record.rule === loadRule));
  epoch++;
  assert.equal((await navigation.selectOrigin('addr', m.store.address)).reason, 'stale-query-snapshot');
});

test('ambiguous canonical store-source projection preserves the numeric result but cannot claim complete navigation', () => {
  const m = explicitLoad();
  m.ir.instructions.push({ ...m.store, id:9001 });
  const f = render(m.ir, m.load.dst, null), result = applyPhase8Projection(f.result, analysis());
  assert.equal(f.result.cAst.body[0].semantic.expression.value, 37n);
  assert.ok(f.result.expressionHistoryBinding.reasons.includes('canonical-load-source-history-incomplete'));
  assert.equal(result.renderProvenance.completeness, 'incomplete');
  const history = loadRecords(result);
  assert.ok(history.length > 0);
  assert.ok(history.every(record => record.originHistory.completeness === 'incomplete'
    && !record.originHistory.consumedRefs.includes(`ir:${m.store.id}`)
    && !record.originHistory.consumedRefs.includes('ir:9001')));
  assertCanonical(f);
});

test('a getter replacing an observed canonical store source invalidates history without executing it', () => {
  const m = explicitLoad(), f = render(m.ir, m.load.dst, null);
  const original = m.store.semanticNodeId;
  let reads = 0;
  Object.defineProperty(m.store, 'semanticNodeId', { enumerable:true, configurable:true, get:() => { reads++; return original; } });
  assert.equal(readExpressionHistoryConsumer(f.result.cAst.body[0].semantic, m.ir), null);
  assert.equal(reads, 0);
});

test('precomputed bin/MOV/phi selection preserves declared dependencies across eight widths without inventing upstream pass events', () => {
  let cells = 0;
  for (const bits of [1, 2, 3, 4, 8, 16, 32, 64]) for (const kind of ['bin', 'mov', 'phi']) {
    const f = fixture({ bits, kind }), result = applyPhase8Projection(f.result, analysis());
    const [record] = records(result);
    assert.equal(records(result).length, 1, `${bits}/${kind}`);
    assert.equal(record.renderedBinding, 'producer-bound');
    assert.deepEqual(record.producedRefs, ['L0:stmt']);
    assert.equal(record.proof, 'observed-precomputed-value-selection-not-equivalence');
    for (const value of [f.left, f.right, f.target]) {
      assert.ok(record.originHistory.consumedRefs.includes(`ir:${value.def.id}`));
      assert.ok(result.renderProvenance.reverse[`addr:${value.def.address}`].includes('L0:stmt'));
    }
    assert.ok(!result.renderProvenance.ledger.some(record => ['collapse-equal-incoming-phi', 'select-mov-operand'].includes(record.rule)));
    assert.ok(!record.producedRefs.includes('L1:stmt'));
    assert.equal(validateRenderProvenance(result.renderProvenance).state, 'complete');
    assertCanonical(f); cells++;
  }
  assert.equal(cells, 24, 'source cells, not proofs of the supplied constants');
});

test('floating precomputed values retain dependency history through the public pipeline and projection replay', () => {
  for (const bits of [32, 64]) {
    const f = fixture({ bits, floating:true, publicPipeline:true });
    let result = applyPhase8Projection(f.result, analysis());
    const [record] = records(result);
    assert.equal(record.after, 'expression:float-const');
    assert.equal(record.renderedBinding, 'producer-bound');
    const ledger = result.renderProvenance.ledger;
    for (let i = 0; i < 3; i++) result = applyPhase8Projection(result, analysis());
    assert.deepEqual(result.renderProvenance.ledger, ledger);
    assertCanonical(f);
  }
});

test('real canonical MemorySSA numeric constants retain their contributing store without replaying a lower unvisited load branch', () => {
  for (const bits of [8, 16, 32, 64]) {
    const m = canonicalLoad(bits), f = render(m.ir, m.load.dst, null, {}, true);
    const result = applyPhase8Projection(f.result, analysis()), [record] = records(result);
    assert.ok(record);
    assert.equal(record.before, 'precomputed:load');
    assert.equal(record.renderedBinding, 'producer-bound');
    assert.ok(record.originHistory.consumedRefs.includes(`ir:${m.store.id}`));
    assert.ok(result.renderProvenance.reverse[`addr:${m.store.address}`].includes('L0:stmt'));
    assert.equal(record.originHistory.completeness, 'complete');
    assertCanonical(f);
  }
});

test('uncertified precomputed load constants cannot borrow a structural memory source certificate', () => {
  const f = fixture({ kind:'load' }), result = applyPhase8Projection(f.result, analysis());
  assert.equal(f.result.cAst.body[0].semantic.expression.kind, 'const', 'legacy output is not silently changed by source bookkeeping');
  assert.equal(result.renderProvenance.completeness, 'complete', 'complete observed selection does not certify the supplied value');
  const [record] = records(result);
  assert.equal(record.proof, 'observed-precomputed-value-selection-not-equivalence');
  assert.ok(record.originHistory.consumedRefs.includes(`ir:${f.target.def.id}`));
  assert.ok(!record.originHistory.consumedRefs.includes(`ir:${f.left.def.id}`));
  assertCanonical(f);
});

test('edited constants, upstream operands, phi roots and copied public records lose their private selection binding', () => {
  for (const [index, mutate] of [
    f => { f.target.const = 8n; },
    f => { f.right.const = 9n; },
    f => { f.ir.values = [...f.ir.values]; },
    f => { f.ir.blocks.at(-1).phis = [...f.ir.blocks.at(-1).phis]; },
    f => { f.result.cAst.body[0].semantic = { ...f.result.cAst.body[0].semantic }; },
    f => { f.result.rewriteProof = f.result.rewriteProof.map(record => ({ ...record })); },
  ].entries()) {
    const f = fixture({ kind:'phi' }); mutate(f);
    assert.equal(readExpressionHistoryConsumer(f.result.cAst.body[0].semantic, f.ir) !== null, index === 5,
      'copying public history does not revoke the original private consumer; it loses the projected record binding');
    const history = records(applyPhase8Projection(f.result, analysis()));
    assert.ok(history.length > 0);
    assert.ok(history.every(record => record.renderedBinding === 'unresolved' && record.producedRefs.length === 0));
  }
});

test('copied memory facts cannot supply constant dependencies and later context/store mutations invalidate issued history', () => {
  const copied = canonicalLoad();
  copied.load.memoryForwarding = { ...copied.load.memoryForwarding };
  const f = render(copied.ir, copied.load.dst, null), projected = applyPhase8Projection(f.result, analysis());
  assert.equal(projected.renderProvenance.completeness, 'incomplete');
  assert.ok(records(projected).every(record => !record.originHistory.consumedRefs.includes(`ir:${copied.store.id}`)));
  const changed = canonicalLoad(); changed.load.dst.const = 38n;
  const mismatched = render(changed.ir, changed.load.dst, null), mismatch = applyPhase8Projection(mismatched.result, analysis());
  assert.equal(mismatch.renderProvenance.completeness, 'incomplete');
  assert.ok(records(mismatch).every(record => !record.originHistory.consumedRefs.includes(`ir:${changed.store.id}`)));
  for (const mode of ['context', 'store']) {
    const m = canonicalLoad(), fresh = render(m.ir, m.load.dst, null);
    assert.ok(readExpressionHistoryConsumer(fresh.result.cAst.body[0].semantic, m.ir));
    if (mode === 'context') m.load.memoryForwardingContext = { ...m.load.memoryForwardingContext, snapshotId:'changed' };
    else m.store.semanticNodeId = 'changed-store';
    assert.equal(readExpressionHistoryConsumer(fresh.result.cAst.body[0].semantic, m.ir) !== null, false);
    assert.ok(records(applyPhase8Projection(fresh.result, analysis())).every(record => record.renderedBinding === 'unresolved'));
  }
});

test('upstream definition getters cannot replay a precomputed value observation', () => {
  const f = fixture(), original = f.right.const;
  let reads = 0;
  Object.defineProperty(f.right, 'const', { enumerable:true, configurable:true, get:() => { reads++; return original; } });
  assert.equal(readExpressionHistoryConsumer(f.result.cAst.body[0].semantic, f.ir), null);
  assert.equal(reads, 0);
});

test('mandatory fallback retains precomputed dependency navigation without optional representation passes', () => {
  const f = fixture({ kind:'mov', options:{ deterministicTransforms:false, decompilerTimeBudgetMs:1e-12 } });
  assert.equal(f.result.passMetrics.find(pass => pass.name === 'semantic-rewrite')?.skipped, true);
  const projected = applyPhase8Projection(f.result, analysis());
  assert.ok(records(projected).some(record => record.renderedBinding === 'producer-bound' && record.producedRefs.includes('L0:stmt')),
    JSON.stringify(records(projected).map(record => ({ valueId:record.valueId, binding:record.renderedBinding, refs:record.producedRefs }))));
  assert.ok(projected.renderProvenance.reverse[`addr:${f.right.def.address}`].includes('L0:stmt'));
  assertCanonical(f);
});

test('query navigation resolves a selected-away constant dependency to its actual return and refuses staleness', async () => {
  const f = fixture(), result = applyPhase8Projection(f.result, analysis());
  let epoch = 1;
  const api = new AnalysisQueryAPI({
    currentIdentity:async () => ({ binaryId:'precomputed-history', projectRevision:1, analysisEpoch:epoch, artifactVersions:{} }),
    decompile:async () => ({ value:{ lines:result.lines, pseudocode:result.pseudocode, renderProvenance:result.renderProvenance }, status:{ completeness:'complete' } }),
  });
  const snapshot = await api.snapshot(), query = await api.decompile(snapshot, 'function');
  const navigation = createDecompilerNavigation(query, { currentSnapshot:() => api.snapshot() });
  const selected = await navigation.selectOrigin('addr', f.right.def.address);
  assert.equal(selected.state, 'ready');
  assert.deepEqual(selected.entities.map(entity => entity.lineIndex), [0]);
  assert.ok(selected.transforms.some(record => record.rule === rule));
  epoch++;
  assert.equal((await navigation.selectOrigin('addr', f.right.def.address)).reason, 'stale-query-snapshot');
});

test('history and observation limits retain supplied constants while reporting incomplete provenance', () => {
  const baseline = fixture().result.pseudocode;
  for (const options of [{ renderProvenanceBudget:{ maxTransformRecords:0 } }, { renderProvenanceBindingBudget:{ maxEdges:0 } },
    { renderProvenanceBindingBudget:{ maxConsumers:0 } }, { shouldAbort:() => true }]) {
    const f = fixture({ options });
    assert.equal(f.result.pseudocode, baseline);
    assert.equal(applyPhase8Projection(f.result, analysis()).renderProvenance.completeness, 'incomplete');
    assertCanonical(f);
  }
});

test('a large declared dependency set is bounded and cannot advertise complete constant provenance', () => {
  const f = irFixture('precomputed_dependency_limit'); f.block(0);
  const args = Array.from({ length:600 }, () => f.opaque(32));
  const target = f.call(32); target.const = 7n;
  target.def.args = args.map(value => ({ value }));
  f.ret();
  const ir = f.build(); ir.instructions = ir.blocks.flatMap(block => block.insts);
  ir.instructions.forEach((inst, index) => { inst.id = index + 100; inst.address = 0x5000n + BigInt(index * 4); });
  ir.blocks[0].startRow = 0;
  const rendered = render(ir, target, null, { deterministicTransforms:false, decompilerTimeBudgetMs:1e-12 });
  assert.equal(rendered.result.cAst.body[0].semantic.expression.value, 7n);
  assert.ok(rendered.result.expressionHistoryBinding.reasons.includes('precomputed-source-history-incomplete'));
  const projected = applyPhase8Projection(rendered.result, analysis());
  assert.equal(projected.renderProvenance.completeness, 'incomplete');
  assert.ok(records(projected).every(record => record.originHistory.completeness === 'incomplete'));
  assertCanonical(rendered);
});

test('literal constants and actual non-precomputed construction cannot invent a precomputed-selection event', () => {
  const f = fixture({ precomputed:false });
  assert.deepEqual(records(applyPhase8Projection(f.result, analysis())), []);
  assertCanonical(f);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';

// A real canonical IR/MemorySSA projection enters the actual private facade.
// This worker-only seam proves conditional writers, not decoded/compiler coverage;
// no production API accepts the fixture option.
const loader = registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (!url.endsWith('/js/ir-core.js')) return result;
  const source = String(result.source), marker = 'const result = buildSemanticV2CompatibilityPipeline({';
  assert.equal(source.split(marker).length, 2);
  return { ...result, source:source.replace(marker, 'const result = opts.__escapeFixture ?? buildSemanticV2CompatibilityPipeline({') };
} });
const { createSemanticIrFunction } = await import('../../../js/semantics/ir/function.js');
const { createSemanticCfg } = await import('../../../js/semantics/cfg/index.js');
const { createMemoryRegionRef } = await import('../../../js/semantics/memoryssa/contract.js');
const { buildMemorySsa, MEMORY_SSA_BUILD_VERSION } = await import('../../../js/semantics/memoryssa/build.js');
const { projectSemanticIrV2ToLegacyV1, readProjectedStateNormalization, observeProjectedOperationData } = await import('../../../js/semantics/compat/semantic-ir-v2-to-v1.js');
const { stableDigest } = await import('../../../js/core/identity/index.js');
const { buildIR, readFacadeStateNormalization, readFacadeLocationHistory,
  readFacadeStackEscapeHistory, facadeStackEscapeTransitionExpected } = await import('../../../js/ir-core.js');
const { buildSemanticModel } = await import('../../../js/blocks.js');
const { annotateValueRanges } = await import('../../../js/semantics/compat/legacy-value-ranges.js');
const { enhanceSemanticDecompilation } = await import('../../../js/decompiler/pipeline-core.js');
const { enhanceSemanticDecompilation:enhancePublic } = await import('../../../js/decompiler/pipeline.js');
const { captureRecoveryIrData } = await import('../../../js/decompiler/phase8/projection-origin.js');
const { readStackReturnHistoryConsumer } = await import('../../../js/decompiler/passes/stack-return-recovery.js');
const { applyPhase8Projection } = await import('../../../js/decompiler/phase8/projection.js');
const { buildRenderProvenance, validateRenderProvenance } = await import('../../../js/decompiler/phase8/render-provenance.js');
const { AnalysisQueryAPI } = await import('../../../js/analysis/query/api.js');
const { createDecompilerNavigation } = await import('../../../js/ui/decompiler-provenance.js');
const { BRANCH, loadRoadmapManifest, validateRoadmapInventory } = await import('../../../tools/validation/analysis-roadmap/ownership.mjs');
const { analysis } = await import('./fixture.js');
loader.deregister();

const rule = 'invalidate-escaped-stack-forwarding';
const clone = ir => structuredClone(Object.fromEntries(Object.entries(ir).filter(([, value]) => typeof value !== 'function')));

function fixture(options = {}, mutate = null) {
  const f = canonicalFixture(options);
  f.priorState = readProjectedStateNormalization(f.ir);
  assert.equal(f.load.op, 'load');
  assert.equal(f.load.reachingStore, f.store, 'actual canonical same-range store link is required');
  f.beforeUse = f.load.memUse;
  f.memory = f.load.memoryForwarding;
  if (mutate) mutate(f);
  const lines = ['mov w0, #7', 'str w0, [sp]', ...f.calls.map(() => 'bl #0x100001000'), 'ldr w0, [sp]', 'ret'];
  const rows = lines.map((line, row) => {
    const split = line.indexOf(' ');
    return { row, address:0x100000000n + BigInt(row * 4), mn:split < 0 ? line : line.slice(0, split), ops:split < 0 ? '' : line.slice(split + 1) };
  });
  const rowOfAddress = address => rows.find(row => row.address === BigInt(address))?.row ?? null;
  f.model = buildSemanticModel(rows, { rowOfAddress, startRow:0, endRow:rows.length - 1 });
  f.ir = buildIR(f.model, { rowOfAddress, returnType:options.bits === 64 ? 'int64' : 'int32',
    semanticMigrationMode:'semantic-v2-compat', __escapeFixture:{ legacyV1:f.ir } });
  f.ret = f.ir.instructions.find(inst => inst.op === 'ret');
  return f;
}

function render(f, publicPipeline = false) {
  const seed = { semantic:true, ir:f.ir, types:{ values:new Map(), locations:new Map() },
    lines:[{ kind:'stmt', indent:1, text:'return old;', row:f.ret.row, addr:f.ret.address }],
    warnings:[], evidence:[], coverage:{ mode:'structured' }, summary:'' };
  f.result = (publicPipeline ? enhancePublic : enhanceSemanticDecompilation)(seed, f.model, { deterministicTransforms:true });
  return f;
}

test('actual canonical-link invalidation records the original store, memory use and tested stack argument', () => {
  for (const bits of [32, 64]) {
    const f = fixture({ bits }), before = clone(f.ir), history = readFacadeStackEscapeHistory(f.ir);
    assert.ok(history);
    assert.equal(history.completeness, 'complete');
    assert.equal(history.events.length, 1);
    const event = history.events[0];
    assert.equal(event.source, f.load);
    assert.equal(event.output, f.load.dst);
    assert.equal(event.store, f.store);
    assert.equal(event.call, f.calls[0]);
    assert.equal(event.beforeUse, f.beforeUse);
    assert.equal(event.afterUse, f.load.memUse);
    assert.equal(event.before.kind, 'store');
    assert.equal(event.after.kind, 'clobber');
    assert.equal(event.argument, f.calls[0].args[0]);
    assert.equal(event.input, event.argument.value);
    assert.equal(event.proof.must, true);
    assert.equal(f.load.reachingStore, undefined);
    assert.equal(f.load.memoryForwarding, f.memory, 'canonical numeric evidence is untouched');
    assert.equal(f.load.memoryForwarding.status, 'exact');
    assert.equal(event.memory, f.memory);
    assert.ok(Object.isFrozen(event) && Object.isFrozen(event.before) && Object.isFrozen(event.proof));
    assert.equal(readFacadeStackEscapeHistory(f.ir, f.load).events[0], event);
    assert.deepEqual(clone(f.ir), before);
  }
});

test('only the first intervening qualifying call invalidates, while rejected call arguments stay in history', () => {
  const f = fixture({ calls:2 }, f => {
    // Selection-only synthetic public view: first call receives a non-stack
    // canonical stored value. No memory fact or store pointer is fabricated.
    f.calls[0].args = [{ value:f.store.args[0].value, bits:32 }];
  });
  const event = readFacadeStackEscapeHistory(f.ir)?.events[0];
  assert.ok(event);
  assert.equal(event.call, f.calls[1]);
  assert.equal(event.object.tested.length, 2);
  assert.equal(event.object.tested[0].proof, null);
  assert.equal(event.object.tested[1].proof.must, true);
  assert.ok(event.related.includes(f.calls[0]));
  const first = fixture({ calls:2 });
  assert.equal(readFacadeStackEscapeHistory(first.ir).events[0].call, first.calls[0]);
  assert.equal(readFacadeStackEscapeHistory(first.ir).events[0].object.tested.length, 1, 'same short-circuit evaluation count');
});

test('actual escape writes carry both preceding public-state and location histories', () => {
  const f = fixture();
  assert.ok(f.priorState, 'fixture has real projector-issued normalization');
  assert.ok(readFacadeStateNormalization(f.ir));
  assert.equal(readFacadeLocationHistory(f.ir)?.completeness, 'complete');
  assert.equal(readFacadeLocationHistory(f.ir).events.length, 2);
  const map = buildRenderProvenance({ result:{ ir:f.ir, lines:[] }, snapshotId:'escape' });
  assert.equal(map.completeness, 'complete', JSON.stringify(map.reasons));
});

test('no call, non-stack argument, no link, same-row call and cross-block store are not escape events', () => {
  for (const [options, mutate] of [[{ calls:0 }, null], [{ passStack:false }, null], [{}, f => { delete f.load.reachingStore; }],
    [{}, f => { f.calls[0].row = f.store.row; }], [{}, f => { f.calls[0].row = f.load.row; }],
    [{}, f => { f.store.block = 1; }], [{}, f => { f.load.loc.kind = 'global'; }]]) {
    const f = fixture(options, mutate);
    assert.equal(facadeStackEscapeTransitionExpected(f.ir), false);
    assert.equal(readFacadeStackEscapeHistory(f.ir), null);
    assert.notEqual(f.load.extra?.compatStackEscapeInvalidation, true);
  }
});

test('ordinary decoded unknown-call input stays conservatively unlinked without a synthetic escape event', () => {
  const lines = ['sub sp, sp, #32', 'str w1, [sp, #8]', 'add x0, sp, #8', 'bl #0x100001000', 'ldr w0, [sp, #8]', 'add sp, sp, #32', 'ret'];
  const rows = lines.map((text, row) => { const split = text.indexOf(' '); return { row, address:0x100000000n + BigInt(row * 4), mn:split < 0 ? text : text.slice(0, split), ops:split < 0 ? '' : text.slice(split + 1) }; });
  const rowOfAddress = address => rows.find(row => row.address === BigInt(address))?.row ?? null;
  const model = buildSemanticModel(rows, { rowOfAddress, startRow:0, endRow:rows.length - 1 });
  const ir = buildIR(model, { rowOfAddress, returnType:'int32', semanticMigrationMode:'semantic-v2-compat' });
  const load = ir.instructions.find(inst => inst.op === 'load');
  assert.ok(load);
  assert.equal(load.memUse.kind, 'clobber');
  assert.equal(load.reachingStore, undefined);
  assert.equal(facadeStackEscapeTransitionExpected(ir), false);
});

test('source-less direct escape records retain canonical load/store/call navigation without removing them', () => {
  const f = fixture(), before = clone(f.ir), map = buildRenderProvenance({ result:{ ir:f.ir, lines:[] }, snapshotId:'escape' });
  const record = map.ledger.find(record => record.kind === 'stack-escape-invalidation');
  assert.ok(record);
  assert.deepEqual(record.producedRefs, []);
  assert.deepEqual(record.removedRefs, []);
  assert.equal(record.stackEscapeTransition.canonicalMemoryUnchanged, true);
  assert.deepEqual(record.stackEscapeTransition.producedRefs, [`ir:${f.load.id}`]);
  for (const inst of [f.load, f.store, f.calls[0]]) assert.ok(map.transformReverse[`ir:${inst.id}`].includes(map.ledger.indexOf(record)));
  assert.deepEqual(validateRenderProvenance(map).reasons, []);
  assert.deepEqual(clone(f.ir), before);
});

test('core and public actual return consumers retain escape and preceding location history through replay', () => {
  for (const publicPipeline of [false, true]) {
    const f = render(fixture(), publicPipeline);
    let result = applyPhase8Projection(f.result, analysis());
    const records = result.renderProvenance.ledger.filter(record => record.rule === rule && record.kind === 'expression-rewrite');
    assert.equal(result.renderProvenance.completeness, 'complete', JSON.stringify({ publicPipeline, reasons:result.renderProvenance.reasons, binding:f.result.expressionHistoryBinding }));
    assert.ok(records.some(record => record.producedRefs.length), JSON.stringify({ publicPipeline, reasons:result.renderProvenance.reasons, binding:f.result.expressionHistoryBinding }));
    for (const inst of [f.load, f.store, f.calls[0]]) assert.ok(records.some(record => record.originHistory.consumedRefs.includes(`ir:${inst.id}`)));
    assert.ok(result.renderProvenance.ledger.some(record => record.rule === 'reuse-stack-location' && record.kind === 'expression-rewrite' && record.producedRefs.length));
    const ledger = result.renderProvenance.ledger;
    result = applyPhase8Projection(result, analysis());
    assert.deepEqual(result.renderProvenance.ledger, ledger);
  }
});

test('public return recovery retains private preimages and revokes after displaced memory mutation', () => {
  for (const mutate of [f => { f.beforeUse.kind = 'other'; }, f => { f.ir.locations = new Map(f.ir.locations); }]) {
  const f = render(fixture(), true), node = f.result.cAst.body.find(node => node.semantic?.op === 'return');
  const consumer = readStackReturnHistoryConsumer(node.semantic, f.ir);
  assert.ok(consumer);
  assert.ok(consumer.records.some(record => record.rule === rule));
  mutate(f);
  assert.ok(readStackReturnHistoryConsumer(node.semantic, f.ir) === null);
  const projected = applyPhase8Projection(f.result, analysis());
  assert.ok(!projected.renderProvenance.ledger.some(record => record.rule === rule && record.kind === 'expression-rewrite' && record.producedRefs.length));
  }
});

test('recovery observes native dominance sets without invoking public iterators or accepting replacements', () => {
  for (const mutate of [ir => ir.dominators[0].add(100), ir => ir.dominators[0].delete(0),
    ir => { ir.dominators[0] = new Set(ir.dominators[0]); }, ir => { ir.dominators = [...ir.dominators]; },
    ir => { ir.idom = [...ir.idom]; }]) {
    const f = fixture(), observation = captureRecoveryIrData(f.ir, []);
    assert.equal(observation.matches(), true);
    mutate(f.ir);
    assert.equal(observation.matches(), false);
  }
  const f = fixture(); let reads = 0;
  Object.defineProperty(f.ir.dominators[0], Symbol.iterator, { get() { reads++; return Set.prototype.values; } });
  assert.throws(() => captureRecoveryIrData(f.ir, []), /recovery-dominator-set-required/);
  assert.equal(reads, 0);
  assert.throws(() => captureRecoveryIrData(fixture().ir, [], () => true), /cancelled/);
});

test('old and new memory, stack argument, rejected selection and actual source positions revoke history', () => {
  for (const mutate of [
    (f, e) => { e.beforeUse.kind = 'other'; }, (f, e) => { e.beforeExtra.compatAbiPreservedAddress = false; },
    f => { f.load.memUse = { ...f.load.memUse }; }, f => { f.load.reachingStore = f.store; },
    f => { f.calls[0].args[0].value.reg = 'x1'; }, f => { f.calls[1].row = 0; },
    f => { f.ir.blocks[0].insts = [...f.ir.blocks[0].insts]; },
    f => { const inst = f.ir.instructions[0]; f.ir.instructions[0] = { ...inst }; },
    f => { f.ir.values = [...f.ir.values]; }, f => { f.ir.instructions = [...f.ir.instructions]; },
  ]) {
    const f = fixture({ calls:2 }), history = readFacadeStackEscapeHistory(f.ir); assert.ok(history);
    mutate(f, history.events[0]);
    assert.ok(readFacadeStackEscapeHistory(f.ir) === null);
    assert.equal(facadeStackEscapeTransitionExpected(f.ir), true);
    assert.ok(buildRenderProvenance({ result:{ ir:f.ir, lines:[] }, snapshotId:'escape' }).reasons.includes('unavailable-stack-escape-history'));
  }
  const f = fixture(); let reads = 0;
  Object.defineProperty(f.calls[0], 'row', { configurable:true, enumerable:true, get:() => { reads++; return 2; } });
  assert.ok(readFacadeStackEscapeHistory(f.ir) === null);
  assert.equal(reads, 0);
});

test('only actual private issuance and real range annotation retain escape observations', () => {
  const f = fixture(), history = readFacadeStackEscapeHistory(f.ir);
  assert.equal(readFacadeStackEscapeHistory({ ...f.ir }), null);
  assert.equal(readFacadeStackEscapeHistory(f.ir, { ...f.load }), null);
  for (let index = 0; index < 2; index++) { annotateValueRanges(f.ir); assert.equal(readFacadeStackEscapeHistory(f.ir), history); }
  f.load.dst.range = { min:0n, max:0n, bits:32, signed:false };
  assert.ok(readFacadeStackEscapeHistory(f.ir) === null);
  assert.equal(observeProjectedOperationData(f.ir, history.events)(), true);
  assert.ok(readFacadeStackEscapeHistory(f.ir) === null);
});

test('copied ledger data cannot issue escape history, a numeric theorem or canonical deletion', () => {
  const f = fixture(), map = buildRenderProvenance({ result:{ ir:f.ir, lines:[] }, snapshotId:'escape' });
  const record = map.ledger.find(record => record.kind === 'stack-escape-invalidation');
  const copied = buildRenderProvenance({ result:{ lines:[], phase8Projection:{ transforms:[structuredClone(record)] } }, snapshotId:'escape' });
  assert.ok(copied.reasons.includes('unissued-stack-escape-history'));
  for (const mutate of [r => { r.producedRefs = ['L0:stmt']; }, r => { r.removedRefs = [`ir:${f.store.id}`]; },
    r => { r.stackEscapeTransition.canonicalMemoryUnchanged = false; }, r => { r.stackEscapeTransition.stackProof.must = false; },
    r => { r.stackEscapeTransition.after.kind = 'store'; }, r => { r.stackEscapeTransition.callRef = 'ir:other'; },
    r => { r.stackEscapeTransition.after.evidence = 'unissued-stack-escape'; },
    r => { r.stackEscapeTransition.after.evidence = null; },
    r => { r.stackEscapeTransition.before.definitionId = 'other'; }, r => { r.stackEscapeTransition.after.regionId = 'other'; },
    r => { r.stackEscapeTransition.argumentIndex = -1; }, r => { r.stackEscapeTransition.storeRef = 'ir:missing'; }]) {
    const changed = structuredClone(map); mutate(changed.ledger.find(item => item.kind === record.kind));
    assert.ok(validateRenderProvenance(changed).reasons.includes('invalid-stack-escape-history'));
  }
});

test('oversized block observation leaves the actual conservative invalidation intact and explicitly unavailable', () => {
  const f = fixture({}, f => {
    while (f.ir.blocks[0].insts.length <= 512) f.ir.blocks[0].insts.push({ id:10000 + f.ir.blocks[0].insts.length, op:'nop', row:10000, block:0 });
  });
  assert.equal(f.load.reachingStore, undefined);
  assert.equal(f.load.extra.compatStackEscapeInvalidation, true);
  assert.equal(facadeStackEscapeTransitionExpected(f.ir), true);
  assert.equal(readFacadeStackEscapeHistory(f.ir), null);
  assert.ok(buildRenderProvenance({ result:{ ir:f.ir, lines:[] }, snapshotId:'escape' }).reasons.includes('unavailable-stack-escape-history'));
});

test('escape ledger budgets, cancellation and late mutation remain incomplete without changing IR', () => {
  const f = fixture(), before = clone(f.ir), result = { ir:f.ir, lines:[] };
  for (const budget of [{ maxTransformRecords:1 }, { maxOriginsPerEntity:1 }]) {
    const map = buildRenderProvenance({ result, snapshotId:'escape', budget });
    assert.equal(map.completeness, 'incomplete');
    assert.ok(map.reasons.includes('truncated'));
  }
  assert.equal(buildRenderProvenance({ result, shouldAbort:() => true }).completeness, 'incomplete');
  assert.deepEqual(clone(f.ir), before);
  let calls = 0;
  const map = buildRenderProvenance({ result, snapshotId:'escape', shouldAbort:() => { if (++calls === 2) f.load.memUse.kind = 'other'; return false; } });
  assert.ok(map.reasons.includes('stale-stack-escape-history'));
});

test('direct query navigation reaches the displaced canonical store and rejects stale snapshots', async () => {
  const f = fixture(), map = buildRenderProvenance({ result:{ ir:f.ir, lines:[] }, snapshotId:'escape' });
  let epoch = 1;
  const api = new AnalysisQueryAPI({ currentIdentity:async () => ({ binaryId:'escape', projectRevision:1, analysisEpoch:epoch, artifactVersions:{} }),
    decompile:async () => ({ value:{ lines:[], pseudocode:'', renderProvenance:map }, status:{ completeness:'complete' } }) });
  const query = await api.decompile(await api.snapshot(), 'function');
  const navigation = createDecompilerNavigation(query, { currentSnapshot:() => api.snapshot() });
  const selected = await navigation.selectOrigin('ir', f.store.id);
  assert.equal(selected.state, 'ready', JSON.stringify({ selected, reasons:map.reasons }));
  assert.deepEqual(selected.entities, []);
  assert.ok(selected.transforms.some(record => record.kind === 'stack-escape-invalidation'));
  epoch++;
  assert.equal((await navigation.selectOrigin('ir', f.store.id)).reason, 'stale-query-snapshot');
});

test('stack escape histories use one exact owned path in the canonical provenance subtree', () => {
  const file = 'tests/phase8/provenance/stack-escape-history.test.mjs', manifest = loadRoadmapManifest();
  assert.deepEqual(validateRoadmapInventory(BRANCH, 'phase8', [file], manifest), [file]);
  assert.throws(() => validateRoadmapInventory(BRANCH, 'phase8', ['tests/phase8/provenance/unowned-escape.test.mjs'], manifest));
});

function canonicalFixture({ bits = 32, calls = 1, passStack = true, memoryWrite = 'none' } = {}) {
  const functionId = 'escape_history';
  const origin = (id, row) => ({ instructionIds:[id], virtualRanges:[{ start:0x100000000n + BigInt(row * 4), end:0x100000004n + BigInt(row * 4) }] });
  const address = { kind:'address', widthBits:64, addressSpace:'memory' }, scalar = { kind:'bitvector', widthBits:bits };
  const memory = { addressSpace:'memory', addressExpr:{ valueId:'addr' }, widthBits:bits,
    endian:'little', alignment:bits / 8, volatility:false, atomic:false, ordering:'unknown', faults:[] };
  const callNodes = Array.from({ length:calls }, (_, index) => ({ id:`n_call${index}`, kind:'call', blockId:'b0', inputs:[passStack ? 'addr' : 'stored'], outputs:[],
    call:{ targetValueIds:[], targetEntityIds:['callee'], arguments:[passStack ? 'addr' : 'stored'], returns:[], stateReads:[], stateWrites:[],
      memoryRead:{ scope:'none' }, memoryWrite:{ scope:memoryWrite, ...(memoryWrite === 'all' ? { addressSpaces:['memory'] } : {}) }, controlEffects:[{ kind:'call' }], determinism:'deterministic',
      noreturn:false, mayThrow:false, summarySource:'synthetic-known-no-write-call', completeness:'complete', unknownEffects:null },
    origin:origin(`call${index}`, index + 2) }));
  const nodes = [
    { id:'n_value', kind:'const', blockId:'b0', inputs:[], outputs:['stored'], attributes:{ value:7 }, origin:origin('value', 0) },
    { id:'n_store', kind:'store', blockId:'b0', inputs:['addr', 'stored'], outputs:[], memory, origin:origin('store', 1) },
    ...callNodes,
    { id:'n_load', kind:'load', blockId:'b0', inputs:['addr'], outputs:['loaded'], memory, origin:origin('load', calls + 2) },
    { id:'n_ret', kind:'return', blockId:'b0', inputs:['loaded'], outputs:[], origin:origin('ret', calls + 3) },
  ];
  const canonical = createSemanticIrFunction({ schemaVersion:2, contractVersion:'2.0.0', functionId, entryBlockId:'b0',
    blocks:[{ id:'b0', nodeIds:nodes.map(node => node.id), origin:origin('block', 0) }], nodes,
    values:[{ id:'addr', kind:'entry', variableKey:'sp', machineType:address, sourceEntityId:functionId, origin:origin('addr', 0) },
      { id:'stored', kind:'definition', machineType:scalar, definitionNodeId:'n_value', sourceEntityId:'n_value',
        metadata:{ constant:{ kind:'bitvector', widthBits:bits, value:7n } }, origin:origin('stored', 0) },
      { id:'unused', kind:'entry', variableKey:'x0', machineType:scalar, sourceEntityId:functionId, origin:origin('unused', 0) },
      { id:'loaded', kind:'definition', variableKey:'x0', machineType:scalar, definitionNodeId:'n_load', sourceEntityId:'n_load', origin:origin('loaded', calls + 2) }],
    completeness:'complete', unknowns:[], origin:origin('function', 0) });
  const cfg = createSemanticCfg({ functionId, entryBlockId:'b0', blocks:[{ id:'b0', successors:[] }] });
  const region = createMemoryRegionRef({ id:'stack', kind:'stack-fixed', functionId, offset:'0', widthBits:bits,
    metadata:{ canonicalAddressIncludesOperationDisplacement:true }, origin:origin('region', 0) });
  const identity = { functionId, semanticIrId:'ir', semanticIrContractVersion:'2.0.0', semanticIrDigest:stableDigest(canonical) };
  const memorySsa = buildMemorySsa(canonical, cfg, { regions:[region], resolveRegion:() => region,
    queryAlias:() => ({ relation:'must', reasonCodes:['same-fixture-stack-slot'], evidenceIds:['fixture-region'],
      proof:{ analyzerId:'phase7.alias.solver', analyzerVersion:'1.1.0', completeness:'complete', stopReason:null } }),
    identity:{ ...identity, binaryId:'escape-history', sliceId:'slice', snapshotId:'snapshot', scalarSsaId:'ssa', scalarSsaBuildVersion:'1.0.0',
      scalarSsaDigest:'ssa-digest', memorySsaId:'mssa', memorySsaBuildVersion:MEMORY_SSA_BUILD_VERSION, analyzerVersion:'fixture' },
    snapshotId:'snapshot', canonicalIrIdentity:identity });
  const ir = projectSemanticIrV2ToLegacyV1(canonical, { memorySsa, cfg,
    rowOfNode:node => Number((BigInt(node.origin.virtualRanges[0].start) - 0x100000000n) / 4n) });
  return { ir, canonical, memorySsa, load:ir.instructions.find(inst => inst.semanticNodeId === 'n_load'),
    store:ir.instructions.find(inst => inst.semanticNodeId === 'n_store'), calls:ir.instructions.filter(inst => inst.op === 'call') };
}

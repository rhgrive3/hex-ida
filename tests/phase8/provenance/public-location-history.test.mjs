import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';

// Synthetic integration seam only: feed a real canonical IR/MemorySSA projection
// to the actual private facade writers/issuers. No fact or issuer is forged and
// no production API gains this option. Parsed stack fixtures use the normal path.
// This does not substitute for real decoded/compiler field-restoration evidence.
const loader = registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (!url.endsWith('/js/ir-core.js')) return result;
  const source = String(result.source), marker = 'const result = buildSemanticV2CompatibilityPipeline({';
  assert.equal(source.split(marker).length, 2);
  return { ...result, source:source.replace(marker, 'const result = opts.__locationFixture ?? buildSemanticV2CompatibilityPipeline({') };
} });
const { buildSemanticModel } = await import('../../../js/blocks.js');
const { buildIR, readFacadeLocationHistory, facadeLocationTransitionExpected, readFacadeStateNormalization } = await import('../../../js/ir-core.js');
const { observeProjectedOperationData, projectSemanticIrV2ToLegacyV1 } = await import('../../../js/semantics/compat/semantic-ir-v2-to-v1.js');
const { annotateValueRanges } = await import('../../../js/semantics/compat/legacy-value-ranges.js');
const { enhanceSemanticDecompilation } = await import('../../../js/decompiler/pipeline-core.js');
const { enhanceSemanticDecompilation:enhancePublic } = await import('../../../js/decompiler/pipeline.js');
const { applyPhase8Projection } = await import('../../../js/decompiler/phase8/projection.js');
const { buildRenderProvenance, validateRenderProvenance } = await import('../../../js/decompiler/phase8/render-provenance.js');
const { AnalysisQueryAPI } = await import('../../../js/analysis/query/api.js');
const { createDecompilerNavigation } = await import('../../../js/ui/decompiler-provenance.js');
const { BRANCH, loadRoadmapManifest, validateRoadmapInventory } = await import('../../../tools/validation/analysis-roadmap/ownership.mjs');
const { analysis } = await import('./fixture.js');
const { createSemanticIrFunction } = await import('../../../js/semantics/ir/function.js');
const { createSemanticCfg } = await import('../../../js/semantics/cfg/index.js');
const { createMemoryRegionRef } = await import('../../../js/semantics/memoryssa/contract.js');
const { buildMemorySsa, MEMORY_SSA_BUILD_VERSION } = await import('../../../js/semantics/memoryssa/build.js');
const { isCanonicalExactMemoryForwarding, canonicalMemoryForwardingContextForLoad } = await import('../../../js/semantics/memoryssa/queries.js');
const { stableDigest } = await import('../../../js/core/identity/index.js');
loader.deregister();

const clone = ir => structuredClone(Object.fromEntries(Object.entries(ir).filter(([, value]) => typeof value !== 'function')));

function fixture({ store = false, lines = null, bits = 32, projected = null } = {}) {
  const register = bits === 64 ? 'x0' : 'w0';
  lines ??= ['mov x19, sp', 'bl #0x100001000', `${store ? 'str' : 'ldr'} ${register}, [x19, #8]`, 'ret'];
  const rows = lines.map((line, row) => {
    const index = line.indexOf(' ');
    return { row, address:0x100000000n + BigInt(row * 4), mn:index < 0 ? line : line.slice(0, index), ops:index < 0 ? '' : line.slice(index + 1) };
  });
  const rowOfAddress = address => rows.find(row => row.address === BigInt(address))?.row ?? null;
  const model = buildSemanticModel(rows, { rowOfAddress, startRow:0, endRow:rows.length - 1 });
  const ir = buildIR(model, { rowOfAddress, returnType:bits === 64 ? 'int64' : 'int32', semanticMigrationMode:'semantic-v2-compat',
    ...(projected ? { __locationFixture:{ legacyV1:projected } } : {}) });
  return { ir, model, ret:ir.instructions.find(inst => inst.op === 'ret'), store };
}

function fieldProjection({ copiedProof = false, store = false } = {}) {
  const functionId = 'public_field_location';
  const origin = (id, row) => ({ instructionIds:[id], virtualRanges:[{ start:0x100000000n + BigInt(row * 4), end:0x100000004n + BigInt(row * 4) }] });
  const pointer = { kind:'bitvector', widthBits:64 }, scalar = { kind:'bitvector', widthBits:32 };
  const address = { kind:'address', widthBits:64, addressSpace:'memory' };
  const value = (id, node, machineType, row) => ({ id, kind:'definition', machineType, definitionNodeId:node, sourceEntityId:node, origin:origin(id, row) });
  const memory = (valueId, bits) => ({ addressSpace:'memory', addressExpr:{ valueId }, widthBits:bits,
    endian:'little', alignment:bits / 8, volatility:false, atomic:false, ordering:'unknown', faults:[] });
  const nodes = [
    { id:'n_addr', kind:'address', blockId:'b0', inputs:[], outputs:['addr'], attributes:{ value:'0x4000' }, origin:origin('addr', 0) },
    { id:'n_value', kind:'const', blockId:'b0', inputs:[], outputs:['stored'], attributes:{ value:16384 }, origin:origin('value', 1) },
    { id:'n_store', kind:'store', blockId:'b0', inputs:['addr', 'stored'], outputs:[], memory:memory('addr', 64), origin:origin('store', 2) },
    { id:'n_load', kind:'load', blockId:'b0', inputs:['addr'], outputs:['loaded'], memory:memory('addr', 64), origin:origin('load', 3) },
    { id:'n_copy', kind:'copy', blockId:'b0', inputs:['loaded'], outputs:['base'], origin:origin('base', 4) },
    { id:'n_field', kind:store ? 'store' : 'load', blockId:'b0', inputs:store ? ['base', 'stored'] : ['base'],
      outputs:store ? [] : ['field'], memory:memory('base', store ? 64 : 32), origin:origin('field', 5) },
    { id:'n_return', kind:'return', blockId:'b0', inputs:[store ? 'loaded' : 'field'], outputs:[], origin:origin('return', 6) },
  ];
  const canonical = createSemanticIrFunction({ schemaVersion:2, contractVersion:'2.0.0', functionId, entryBlockId:'b0',
    blocks:[{ id:'b0', nodeIds:nodes.map(node => node.id), origin:origin('block', 0) }], nodes,
    values:[value('addr', 'n_addr', address, 0), { ...value('stored', 'n_value', pointer, 1), metadata:{ constant:{ kind:'bitvector', widthBits:64, value:16384n } } },
      { ...value('loaded', 'n_load', pointer, 3), ...(store ? { variableKey:'x0' } : {}) }, value('base', 'n_copy', pointer, 4),
      ...(!store ? [{ ...value('field', 'n_field', scalar, 5), variableKey:'x0' }] : [])],
    completeness:'complete', unknowns:[], origin:origin('function', 0) });
  const cfg = createSemanticCfg({ functionId, entryBlockId:'b0', blocks:[{ id:'b0', successors:[] }] });
  const globalRegion = createMemoryRegionRef({ id:'global', kind:'global-absolute', binaryId:'location', address:'0x4000', widthBits:64, origin:origin('region', 0) });
  const identity = { functionId, semanticIrId:'ir', semanticIrContractVersion:'2.0.0', semanticIrDigest:stableDigest(canonical) };
  const memorySsa = buildMemorySsa(canonical, cfg, { regions:[globalRegion], resolveRegion:() => globalRegion,
    // A literal slot holds its own address. All accesses really refer to this
    // one region; an unknown or disjoint relation is never relabelled must.
    queryAlias:() => ({ relation:'must',
      reasonCodes:['canonical-fixture-region'], evidenceIds:['canonical-fixture-alias'],
      proof:{ analyzerId:'phase7.alias.solver', analyzerVersion:'1.1.0', completeness:'complete', stopReason:null } }),
    identity:{ ...identity, binaryId:'location', sliceId:'slice', snapshotId:'snapshot', scalarSsaId:'ssa', scalarSsaBuildVersion:'1.0.0',
      scalarSsaDigest:'ssa-digest', memorySsaId:'mssa', memorySsaBuildVersion:MEMORY_SSA_BUILD_VERSION, analyzerVersion:'memoryssa-fixture' },
    snapshotId:'snapshot', canonicalIrIdentity:identity });
  const ir = projectSemanticIrV2ToLegacyV1(canonical, { memorySsa, cfg,
    rowOfNode:node => Number((BigInt(node.origin.virtualRanges[0].start) - 0x100000000n) / 4n) });
  const load = ir.instructions.find(inst => inst.semanticNodeId === 'n_load');
  assert.ok(isCanonicalExactMemoryForwarding(load.memoryForwarding,
    canonicalMemoryForwardingContextForLoad(load.memoryForwarding, load, load.memoryForwardingContext)),
    JSON.stringify({ status:load.memoryForwarding?.status, reason:load.memoryForwarding?.reason,
      completeness:memorySsa.completeness, unknowns:memorySsa.unknowns }));
  assert.equal(load.dst.const, 16384n);
  const field = ir.instructions.find(inst => inst.semanticNodeId === 'n_field');
  // Supply the facade's conservative public view as its synthetic input. The
  // canonical function, MemorySSA and base-load fact/context are untouched.
  // This fixture proves the real conditional writer, not decoded-path coverage.
  field.loc = { kind:'unknown', key:'unknown-public-field', regionId:field.loc.regionId, origin:field.loc.origin };
  ir.locations.set(field.loc.key, field.loc);
  if (copiedProof) load.memoryForwarding = structuredClone(load.memoryForwarding);
  return { ir, load, field, memorySsa };
}

test('real canonical numeric forwarding drives actual field LOAD/STORE restoration at the private facade seam', () => {
  for (const store of [false, true]) {
    const input = fieldProjection({ store }), oldLocation = input.field.loc;
    assert.equal(oldLocation.kind, 'unknown');
    const f = fixture({ store, projected:input.ir });
    const history = readFacadeLocationHistory(f.ir);
    assert.ok(history?.events.length, JSON.stringify({ store, expected:facadeLocationTransitionExpected(f.ir, input.field),
      kind:input.field.loc?.kind, precise:input.field.addr?.precise, index:input.field.addr?.index?.id,
      baseOp:input.field.addr?.base?.def?.op, baseSub:input.field.addr?.base?.def?.sub,
      fact:input.load.memoryForwarding?.status, memorySources:input.load.memoryForwarding?.provenance?.sourceEntityIds }));
    const event = history.events.find(event => event.source === input.field);
    assert.ok(event);
    assert.equal(event.operation, 'replace-field-location');
    assert.equal(event.previousLocation, oldLocation);
    assert.equal(event.before.kind, 'unknown');
    assert.equal(event.after.kind, 'field');
    assert.equal(event.memory, input.load.memoryForwarding);
    assert.equal(event.base, input.load.dst);
    assert.equal(event.after.aliasUncertain, true);
    assert.equal(event.after.compatibilityShapeOnly, true);
    assert.ok(event.related.some(inst => inst.semanticNodeId === 'n_store'));
    const map = buildRenderProvenance({ result:{ ir:f.ir, lines:[] }, snapshotId:'field' });
    const record = map.ledger.find(record => record.rule === 'replace-field-location');
    assert.ok(record);
    for (const source of [input.field, input.load, ...event.related]) assert.ok(map.transformReverse[`ir:${source.id}`].includes(map.ledger.indexOf(record)));
    input.load.memoryForwarding = structuredClone(input.load.memoryForwarding);
    assert.equal(readFacadeLocationHistory(f.ir), null);
  }
});

test('copied exact-looking memory evidence cannot execute the field restoration writer', () => {
  const input = fieldProjection({ copiedProof:true }), before = input.field.loc;
  const f = fixture({ projected:input.ir });
  assert.equal(input.field.loc, before);
  assert.equal(input.field.loc.kind, 'unknown');
  assert.equal(facadeLocationTransitionExpected(f.ir, input.field), false);
  assert.equal(readFacadeLocationHistory(f.ir, input.field), null);
});

test('field restoration keeps its exact proof sources positioned and carries real rendered consumers', () => {
  for (const store of [false, true]) for (const publicPipeline of [false, true]) {
    const input = fieldProjection({ store }), f = render(fixture({ store, projected:input.ir }), publicPipeline);
    const history = readFacadeLocationHistory(f.ir), event = history.events[0];
    const result = applyPhase8Projection(f.result, analysis());
    const records = result.renderProvenance.ledger.filter(record => record.rule === 'replace-field-location' && record.kind === 'expression-rewrite');
    assert.ok(records.some(record => record.producedRefs.length), JSON.stringify({ store, publicPipeline, reasons:result.renderProvenance.reasons,
      binding:f.result.expressionHistoryBinding, semantic:result.cAst?.body.map(line => ({ op:line.semantic?.op, expression:line.semantic?.expression?.kind })) }));
    for (const source of event.related) assert.ok(records.some(record => record.originHistory.consumedRefs.includes(`ir:${source.id}`)));
    const related = event.related[0], index = f.ir.instructions.indexOf(related);
    f.ir.instructions[index] = { ...related };
    assert.ok(readFacadeLocationHistory(f.ir) === null, 'retired store objects cannot substitute for current canonical positions');
  }
});

test('later writes to the same public location key retain the displaced mapping and every source view', () => {
  const f = fixture({ lines:['mov x19, sp', 'bl #0x100001000', 'str w0, [x19, #8]', 'ldr w0, [x19, #8]', 'ret'] });
  const history = readFacadeLocationHistory(f.ir);
  assert.ok(history?.events.length >= 2);
  const written = history.events.filter(event => event.mapWrite && event.mapKey === 'stack:8');
  assert.equal(written.length, 2);
  assert.equal(written[1].mapBefore, written[0].mapAfter);
  assert.equal(written[1].mapBeforePresent, true);
  assert.equal(f.ir.locations.get('stack:8'), written[1].location);
  assert.notEqual(written[0].source.loc, written[1].source.loc);
  assert.equal(history.isCurrent(), true, 'both actual source views remain observed after map replacement');
  written[0].location.size++;
  assert.equal(readFacadeLocationHistory(f.ir), null);
});

test('bounded location-map observation preserves the actual writer result while history stays unavailable', () => {
  const input = fieldProjection();
  for (let index = 0; index < 1024; index++) input.ir.locations.set(`extra:${index}`, { key:`extra:${index}`, kind:'unknown' });
  const f = fixture({ projected:input.ir });
  assert.equal(input.field.loc.kind, 'field');
  assert.equal(input.field.loc.aliasUncertain, true);
  assert.equal(facadeLocationTransitionExpected(f.ir, input.field), true);
  assert.equal(readFacadeLocationHistory(f.ir), null);
  assert.ok(buildRenderProvenance({ result:{ ir:f.ir, lines:[] }, snapshotId:'large-location' }).reasons.includes('unavailable-public-location-history'));
});

function render(f, publicPipeline = false) {
  const source = readFacadeLocationHistory(f.ir).events[0].source;
  const seed = { semantic:true, ir:f.ir, types:{ values:new Map(), locations:new Map() },
    lines:[{ kind:'stmt', indent:1, text:f.store ? 'old = old;' : 'return old;', row:f.store ? source.row : f.ret.row,
      addr:f.store ? source.address : f.ret.address }], warnings:[], evidence:[], coverage:{ mode:'structured' }, summary:'' };
  f.result = (publicPipeline ? enhancePublic : enhanceSemanticDecompilation)(seed, f.model, { deterministicTransforms:true });
  return f;
}

test('actual public stack location replacement records LOAD and STORE address inputs without changing memory proof', () => {
  for (const store of [false, true]) for (const bits of [32, 64]) {
    const f = fixture({ store, bits }), before = clone(f.ir), history = readFacadeLocationHistory(f.ir);
    assert.ok(history?.events.length, `${store}/${bits}: actual restoration must be issued`);
    assert.equal(history.completeness, 'complete');
    const event = history.events[0];
    assert.equal(event.operation, 'replace-stack-location');
    assert.equal(event.before.kind, 'unknown');
    assert.equal(event.after.kind, 'stack');
    assert.equal(event.after.disp, 8n);
    assert.equal(event.after.size, bits / 8);
    assert.equal(event.source.loc, event.location);
    assert.equal(f.ir.locations.get(event.mapKey), event.location);
    assert.equal(event.mapWrite, true);
    assert.equal(event.source.op, store ? 'store' : 'load');
    assert.ok(event.inputs.some(input => input.value === event.source.addr.base));
    assert.ok(event.stack.must);
    assert.equal(event.memory, null, 'stack presentation does not claim numeric forwarding');
    assert.ok(Object.isFrozen(event) && Object.isFrozen(event.before) && Object.isFrozen(event.after));
    assert.equal(facadeLocationTransitionExpected(f.ir, event.source), true);
    assert.equal(readFacadeLocationHistory(f.ir, event.source).events[0], event);
    assert.deepEqual(clone(f.ir), before);
  }
});

test('existing stack locations retain an actual reuse event without inventing a map write', () => {
  const f = fixture({ lines:['ldr w0, [sp, #8]', 'ret'] });
  const event = readFacadeLocationHistory(f.ir)?.events[0];
  assert.ok(event);
  assert.equal(event.operation, 'reuse-stack-location');
  assert.equal(event.location, event.previousLocation);
  assert.deepEqual(event.after, event.before);
  assert.equal(event.mapWrite, false);
});

test('ordinary field/unknown/indexed addresses do not acquire a facade location event', () => {
  for (const lines of [['ldr w0, [x0, #8]', 'ret'], ['ldr w0, [sp, x1]', 'ret'], ['mov w0, #5', 'ret'],
    ['mov x19, x0', 'bl #0x100001000', 'ldr w0, [x19, #8]', 'ret']]) {
    const f = fixture({ lines });
    assert.equal(facadeLocationTransitionExpected(f.ir), false);
    assert.equal(readFacadeLocationHistory(f.ir), null);
  }
});

test('location identities, displaced objects, map bindings, address inputs and roots revoke current history', () => {
  for (const mutate of [
    (f, e) => { e.location.disp++; }, (f, e) => { e.previousLocation.kind = 'field'; },
    (f, e) => { e.source.loc = { ...e.location }; }, (f, e) => { e.source.extra = { ...e.source.extra }; },
    (f, e) => { e.address.disp++; }, (f, e) => { e.input.def.args = [...e.input.def.args]; },
    (f, e) => { f.ir.locations.set(e.mapKey, { ...e.location }); },
    f => { f.ir.locations = new Map(f.ir.locations); }, f => { f.ir.locations.set('new', {}); },
    f => { f.ir.values = [...f.ir.values]; }, f => { f.ir.instructions = [...f.ir.instructions]; },
  ]) {
    const f = fixture(), history = readFacadeLocationHistory(f.ir);
    assert.ok(history);
    mutate(f, history.events[0]);
    assert.ok(readFacadeLocationHistory(f.ir) === null, 'mutated public location inputs must revoke history');
    assert.equal(facadeLocationTransitionExpected(f.ir), true);
    assert.ok(buildRenderProvenance({ result:{ ir:f.ir, lines:[] }, snapshotId:'location' }).reasons.includes('unavailable-public-location-history'));
  }
  const f = fixture(), event = readFacadeLocationHistory(f.ir).events[0];
  let reads = 0;
  Object.defineProperty(event.location, 'disp', { configurable:true, enumerable:true, get:() => { reads++; return 8n; } });
  assert.equal(readFacadeLocationHistory(f.ir), null);
  assert.equal(reads, 0);
});

test('location-map observation distinguishes an absent key from a present undefined value', () => {
  const input = fieldProjection();
  input.ir.locations.set('present-undefined', undefined);
  const f = fixture({ projected:input.ir });
  assert.ok(readFacadeLocationHistory(f.ir));
  f.ir.locations.delete('present-undefined');
  f.ir.locations.set('replacement-undefined', undefined);
  assert.ok(readFacadeLocationHistory(f.ir) === null, 'equal map size and get results do not prove exact key membership');
});

test('only the actual facade issuer and actual range writer can retain location history', () => {
  const f = fixture(), history = readFacadeLocationHistory(f.ir);
  assert.equal(readFacadeLocationHistory({ ...f.ir }), null);
  assert.equal(readFacadeLocationHistory(f.ir, { ...history.events[0].source }), null);
  for (let i = 0; i < 2; i++) { annotateValueRanges(f.ir); assert.equal(readFacadeLocationHistory(f.ir), history); }
  history.events[0].input.range = { min:0n, max:0n, bits:64, signed:false };
  assert.equal(readFacadeLocationHistory(f.ir), null);
  assert.equal(observeProjectedOperationData(f.ir, history.events)(), true, 'fresh data matching registers no authority');
  assert.equal(readFacadeLocationHistory(f.ir), null);
});

test('LOAD and STORE have direct canonical reverse location history even with no rendered entity', () => {
  for (const store of [false, true]) {
    const f = fixture({ store }), history = readFacadeLocationHistory(f.ir), before = clone(f.ir);
    const map = buildRenderProvenance({ result:{ ir:f.ir, lines:[] }, snapshotId:'location' });
    assert.equal(map.completeness, 'complete', JSON.stringify(map.reasons));
    assert.ok(readFacadeStateNormalization(f.ir), 'actual loc/extra writes must carry original normalization');
    const records = map.ledger.filter(record => record.kind === 'public-location-restoration');
    assert.equal(records.length, history.events.length);
    for (const record of records) {
      assert.deepEqual(record.producedRefs, []);
      assert.deepEqual(record.removedRefs, []);
      for (const ref of record.publicLocationTransition.consumedRefs) assert.ok(map.transformReverse[ref].includes(map.ledger.indexOf(record)));
    }
    assert.deepEqual(clone(f.ir), before);
  }
});

test('actual core/public consumers retain location history and successive projection does not duplicate it', () => {
  for (const store of [false, true]) for (const publicPipeline of [false, true]) {
    const f = render(fixture({ store }), publicPipeline), event = readFacadeLocationHistory(f.ir).events[0];
    let result = applyPhase8Projection(f.result, analysis());
    const records = result.renderProvenance.ledger.filter(record => record.rule === event.operation && record.kind === 'expression-rewrite');
    assert.ok(records.some(record => record.producedRefs.length && record.originHistory.consumedRefs.includes(`ir:${event.source.id}`)),
      JSON.stringify({ store, publicPipeline, source:event.source.id, records:records.map(record => ({ refs:record.producedRefs, before:record.before })),
        binding:f.result.expressionHistoryBinding, reasons:result.renderProvenance.reasons,
        semantic:result.cAst?.body.map(line => ({ op:line.semantic?.op, ir:line.semantic?.ir, expression:line.semantic?.expression?.kind })) }));
    const ledger = result.renderProvenance.ledger;
    result = applyPhase8Projection(result, analysis());
    assert.deepEqual(result.renderProvenance.ledger, ledger);
  }
});

test('copied location metadata cannot issue history, bind visible lines or claim canonical removal', () => {
  const f = fixture(), map = buildRenderProvenance({ result:{ ir:f.ir, lines:[] }, snapshotId:'location' });
  const record = map.ledger.find(record => record.kind === 'public-location-restoration');
  const forged = buildRenderProvenance({ result:{ lines:[], phase8Projection:{ transforms:[structuredClone(record)] } }, snapshotId:'location' });
  assert.ok(forged.reasons.includes('unissued-public-location-history'));
  for (const mutate of [
    r => { r.producedRefs = ['L0:stmt']; }, r => { r.removedRefs = ['ir:1']; },
    r => { r.publicLocationTransition.mapWrite = false; }, r => { r.publicLocationTransition.after.kind = 'global'; },
    r => { r.publicLocationTransition.canonicalValuesRetained = false; }, r => { r.publicLocationTransition.consumedRefs = []; },
    r => { r.proof = 'new-memory-proof'; },
  ]) {
    const changed = structuredClone(map);
    mutate(changed.ledger.find(item => item.kind === record.kind));
    assert.ok(validateRenderProvenance(changed).reasons.includes('invalid-public-location-history'));
  }
});

test('location budgets, cancellation and late map writes cannot become complete', () => {
  const f = fixture(), result = { ir:f.ir, lines:[] }, before = clone(f.ir);
  for (const budget of [{ maxTransformRecords:1 }, { maxOriginsPerEntity:1 }]) {
    const map = buildRenderProvenance({ result, snapshotId:'location', budget });
    assert.equal(map.completeness, 'incomplete');
    assert.ok(map.reasons.includes('truncated'));
  }
  assert.equal(buildRenderProvenance({ result, snapshotId:'location', shouldAbort:() => true }).completeness, 'incomplete');
  assert.deepEqual(clone(f.ir), before);
  let calls = 0;
  const changed = buildRenderProvenance({ result, snapshotId:'location', shouldAbort:() => {
    if (++calls === 2) f.ir.locations.set('late', {});
    return false;
  } });
  assert.ok(changed.reasons.includes('stale-public-location-history'));
});

test('query navigation reaches a non-rendered STORE location history and rejects stale snapshots', async () => {
  const f = fixture({ store:true }), event = readFacadeLocationHistory(f.ir).events[0];
  const map = buildRenderProvenance({ result:{ ir:f.ir, lines:[] }, snapshotId:'location' });
  let epoch = 1;
  const api = new AnalysisQueryAPI({ currentIdentity:async () => ({ binaryId:'location', projectRevision:1, analysisEpoch:epoch, artifactVersions:{} }),
    decompile:async () => ({ value:{ lines:[], pseudocode:'', renderProvenance:map }, status:{ completeness:'complete' } }) });
  const query = await api.decompile(await api.snapshot(), 'function');
  const navigation = createDecompilerNavigation(query, { currentSnapshot:() => api.snapshot() });
  const selected = await navigation.selectOrigin('ir', event.source.id);
  assert.equal(selected.state, 'ready', JSON.stringify({ selected, reasons:map.reasons }));
  assert.deepEqual(selected.entities, []);
  assert.ok(selected.transforms.some(record => record.kind === 'public-location-restoration'));
  epoch++;
  assert.equal((await navigation.selectOrigin('ir', event.source.id)).reason, 'stale-query-snapshot');
});

test('public location history remains in the existing provenance owner and canonical test subtree', () => {
  const manifest = loadRoadmapManifest();
  assert.deepEqual(validateRoadmapInventory(BRANCH, 'phase8', ['tests/phase8/provenance/public-location-history.test.mjs'], manifest),
    ['tests/phase8/provenance/public-location-history.test.mjs']);
  assert.throws(() => validateRoadmapInventory(BRANCH, 'phase8', ['tests/phase8/provenance/unowned-location.test.mjs'], manifest));
});

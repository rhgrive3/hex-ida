import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';

// Test-worker-only seam for orphan-candidate and observation-boundary fixtures.
// Normal parsed cases never pass this option. Production has no such callback.
const loader = registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (!url.endsWith('/js/ir-core.js')) return result;
  const source = String(result.source), marker = 'const typedResultObserver = attachCanonicalTypedCallResults(';
  assert.equal(source.split(marker).length, 2);
  return { ...result, source:source.replace(marker, 'opts.__typedFixture?.(result.legacyV1);\n  ' + marker) };
} });
const { buildSemanticModel } = await import('../../../js/blocks.js');
const { buildIR, readFacadeTypedResultHistory, facadeTypedResultTransitionExpected,
  readFacadeStateNormalization, readFacadePreservedStateHistory } = await import('../../../js/ir-core.js');
const { captureProjectionIrData } = await import('../../../js/core/identity/live-data.js');
const { observeProjectedOperationData } = await import('../../../js/semantics/compat/semantic-ir-v2-to-v1.js');
const { annotateValueRanges } = await import('../../../js/semantics/compat/legacy-value-ranges.js');
const { enhanceSemanticDecompilation } = await import('../../../js/decompiler/pipeline-core.js');
const { enhanceSemanticDecompilation:enhancePublic } = await import('../../../js/decompiler/pipeline.js');
const { applyPhase8Projection } = await import('../../../js/decompiler/phase8/projection.js');
const { buildRenderProvenance, validateRenderProvenance } = await import('../../../js/decompiler/phase8/render-provenance.js');
const { AnalysisQueryAPI } = await import('../../../js/analysis/query/api.js');
const { createDecompilerNavigation } = await import('../../../js/ui/decompiler-provenance.js');
const { BRANCH, loadRoadmapManifest, validateRoadmapInventory } = await import('../../../tools/validation/analysis-roadmap/ownership.mjs');
const { analysis } = await import('./fixture.js');
loader.deregister();

const clone = ir => structuredClone(Object.fromEntries(Object.entries(ir).filter(([, value]) => typeof value !== 'function')));
const rule = 'attach-new-typed-call-result';
function fixture({ bits = 64, fp = false, prototype = undefined, lines = null, mutate = null, returnType = null } = {}) {
  lines ??= ['bl #0x100001000', 'ret'];
  if (prototype === undefined) prototype = { returnType:fp ? bits === 32 ? 'float' : 'double' : bits === 32 ? 'int32' : 'int64',
    returnBits:bits, returnsValue:true, args:[] };
  const rows = lines.map((line, row) => {
    const index = line.indexOf(' ');
    return { row, address:0x100000000n + BigInt(row * 4), mn:index < 0 ? line : line.slice(0, index), ops:index < 0 ? '' : line.slice(index + 1) };
  });
  const rowOfAddress = address => rows.find(row => row.address === BigInt(address))?.row ?? null;
  const model = buildSemanticModel(rows, { rowOfAddress, startRow:0, endRow:rows.length - 1 });
  const ir = buildIR(model, { rowOfAddress, returnType:returnType ?? prototype?.returnType ?? 'int32', semanticMigrationMode:'semantic-v2-compat',
    ...(prototype ? { callPrototypeFor:() => prototype } : {}), ...(mutate ? { __typedFixture:mutate } : {}) });
  return { ir, model, call:ir.instructions.find(inst => inst.op === 'call'), ret:ir.instructions.find(inst => inst.op === 'ret') };
}
function render(f, publicPipeline = false) {
  const seed = { semantic:true, ir:f.ir, types:{ values:new Map(), locations:new Map() },
    lines:[{ kind:'stmt', indent:1, text:'return old;', row:f.ret.row, addr:f.ret.address }],
    warnings:[], evidence:[], coverage:{ mode:'structured' }, summary:'' };
  f.result = (publicPipeline ? enhancePublic : enhanceSemanticDecompilation)(seed, f.model, { deterministicTransforms:true });
  return f;
}

test('parsed integer and FP typed calls issue actual result attachment without inventing canonical SSA', () => {
  for (const bits of [32, 64]) for (const fp of [false, true]) {
    const f = fixture({ bits, fp }), before = clone(f.ir), history = readFacadeTypedResultHistory(f.ir);
    assert.ok(history, `${bits}/${fp}: typed writer history`);
    assert.equal(history.completeness, 'complete');
    const event = history.events[0];
    assert.equal(event.operation, rule);
    assert.equal(event.before, null);
    assert.equal(event.source, f.call);
    assert.equal(event.output, f.call.dst);
    assert.equal(event.registerId, fp ? 'v0' : 'x0');
    assert.equal(event.bits, bits);
    assert.equal(event.output.semanticValueId, null);
    assert.equal(event.output.semanticSsaValueId, null);
    assert.equal(event.output.sourceEntityId, f.call.semanticNodeId);
    assert.equal(event.after.compatibilityShapeOnly, true);
    assert.equal(event.after.unknown, true);
    assert.ok(Object.isFrozen(event) && Object.isFrozen(event.after));
    assert.equal(readFacadeTypedResultHistory(f.ir, f.call).events[0], event);
    assert.equal(facadeTypedResultTransitionExpected(f.ir, f.call), true);
    assert.deepEqual(clone(f.ir), before);
  }
});

test('unknown, void and multi-register aggregate calls do not acquire a typed scalar history', () => {
  for (const prototype of [null, { returnType:'void', returnsValue:false },
    { returnType:'struct Pair', aggregate:true, bits:128, returnsValue:true,
      fields:[{ type:'uint64', bits:64, offset:0 }, { type:'uint64', bits:64, offset:8 }] }]) {
    const f = fixture({ prototype });
    assert.equal(f.call.dst, null);
    assert.equal(facadeTypedResultTransitionExpected(f.ir), false);
    assert.equal(readFacadeTypedResultHistory(f.ir), null);
  }
});

test('synthetic orphan seam retains actual descending candidate choice and deleted view flags', () => {
  let candidates;
  const f = fixture({ mutate:ir => {
    const call = ir.instructions.find(inst => inst.op === 'call');
    // Synthetic compatibility orphan candidates only, not compiler coverage.
    candidates = [0, 1].map(() => {
      const value = { ...ir.values[0], id:ir.values.length, vid:ir.values.length + 1,
        def:null, reg:'x0', sourceEntityId:call.semanticNodeId, uses:[], undefined:true, clobbered:true };
      ir.values.push(value); return value;
    });
  } });
  const event = readFacadeTypedResultHistory(f.ir)?.events[0];
  assert.ok(event);
  assert.equal(event.operation, 'attach-existing-typed-call-result');
  assert.equal(f.call.dst, candidates[1]);
  assert.deepEqual(event.candidates.map(candidate => candidate.value), [candidates[1], candidates[0]]);
  assert.equal(event.before.id, candidates[1].id);
  assert.deepEqual(event.removedFields, ['undefined', 'clobbered']);
  assert.equal(Object.hasOwn(candidates[1], 'undefined'), false);
  assert.equal(Object.hasOwn(candidates[1], 'clobbered'), false);
  candidates[0].id += 1000;
  assert.ok(readFacadeTypedResultHistory(f.ir) === null, 'rejected candidate changes revoke history');
});

test('real typed result writes preserve predecessor public-state normalization', () => {
  for (const bits of [32, 64]) for (const fp of [false, true]) {
    const f = fixture({ bits, fp });
    assert.ok(readFacadeStateNormalization(f.ir), `${bits}/${fp}: actual typed writes carry predecessor`);
    const map = buildRenderProvenance({ result:{ ir:f.ir, lines:[] }, snapshotId:'typed' });
    assert.equal(map.completeness, 'complete', JSON.stringify(map.reasons));
  }
});

test('typed calls after preserved-state restoration keep the actual earlier ABI history', () => {
  const f = fixture({ lines:['mov x19, #5', 'bl #0x100001000', 'add x0, x19, #3', 'ret'] });
  assert.ok(readFacadeTypedResultHistory(f.ir));
  assert.ok(readFacadePreservedStateHistory(f.ir), 'typed-result append must not retire observed earlier ABI decisions');
  f.call.dst.bits = 16;
  assert.ok(readFacadePreservedStateHistory(f.ir) === null, 'retained ABI history still binds final typed output');
});

test('successive actual typed call appends retain distinct events and earlier state histories', () => {
  const f = fixture({ lines:['mov x19, #5', 'bl #0x100001000', 'add x1, x19, #3', 'bl #0x100002000', 'add x0, x19, #4', 'ret'] });
  const history = readFacadeTypedResultHistory(f.ir);
  assert.ok(history);
  assert.equal(history.events.length, 2);
  assert.deepEqual(history.events.map(event => event.ordinal), [0, 1]);
  assert.equal(history.events[0].valueLengthAfter, history.events[1].valueLengthBefore);
  assert.notEqual(history.events[0].output, history.events[1].output);
  assert.ok(readFacadeStateNormalization(f.ir));
  assert.ok(readFacadePreservedStateHistory(f.ir));
});

test('typed result direct history has original CALL reverse navigation but no fabricated rendered edge', () => {
  const f = fixture(), before = clone(f.ir);
  const map = buildRenderProvenance({ result:{ ir:f.ir, lines:[] }, snapshotId:'typed' });
  const record = map.ledger.find(record => record.kind === 'typed-call-result');
  assert.ok(record);
  assert.deepEqual(record.producedRefs, []);
  assert.deepEqual(record.removedRefs, []);
  assert.equal(record.typedCallResultTransition.newCanonicalValue, false);
  assert.deepEqual(record.typedCallResultTransition.producedRefs, [`ir:${f.call.id}`]);
  assert.ok(map.transformReverse[`ir:${f.call.id}`].includes(map.ledger.indexOf(record)));
  assert.equal(record.typedCallResultTransition.consumedRefs.includes(`ssa:def:${f.call.dst.id}`), false);
  assert.deepEqual(validateRenderProvenance(map).reasons, []);
  assert.deepEqual(clone(f.ir), before);
});

test('actual core and public return consumers bind typed result history and survive replay', () => {
  for (const fp of [false, true]) for (const publicPipeline of [false, true]) {
    const f = render(fixture({ fp }), publicPipeline);
    let result = applyPhase8Projection(f.result, analysis());
    const records = result.renderProvenance.ledger.filter(record => record.rule === rule && record.kind === 'expression-rewrite');
    assert.ok(records.some(record => record.producedRefs.length && record.originHistory.consumedRefs.includes(`ir:${f.call.id}`)),
      JSON.stringify({ fp, publicPipeline, reasons:result.renderProvenance.reasons, binding:f.result.expressionHistoryBinding }));
    const ledger = result.renderProvenance.ledger;
    result = applyPhase8Projection(result, analysis());
    assert.deepEqual(result.renderProvenance.ledger, ledger);
  }
});

test('current typed histories bind all selection values, output fields, classification data and actual positions', () => {
  for (const mutate of [
    f => { f.call.dst.bits = 16; }, f => { f.call.returnReg = 'x1'; },
    f => { f.call.extra.returnLocations[0].reg = 'x1'; },
    f => { f.ir.values[0].sourceEntityId = 'changed'; }, f => { f.ir.values[0].version++; },
    f => { f.ir.values = [...f.ir.values]; }, f => { f.ir.values.push({}); },
    f => { const index = f.ir.instructions.indexOf(f.call); f.ir.instructions[index] = { ...f.call }; },
  ]) {
    const f = fixture(); assert.ok(readFacadeTypedResultHistory(f.ir)); mutate(f);
    assert.ok(readFacadeTypedResultHistory(f.ir) === null);
    assert.equal(facadeTypedResultTransitionExpected(f.ir), true);
    assert.ok(buildRenderProvenance({ result:{ ir:f.ir, lines:[] }, snapshotId:'typed' }).reasons.includes('unavailable-typed-call-result-history'));
  }
  const f = fixture(); let reads = 0;
  Object.defineProperty(f.ir.values[0], 'version', { configurable:true, enumerable:true, get:() => { reads++; return 0; } });
  assert.ok(readFacadeTypedResultHistory(f.ir) === null);
  assert.equal(reads, 0);
});

test('typed history is private and only actual range annotation can carry its data observations', () => {
  const f = fixture(), history = readFacadeTypedResultHistory(f.ir);
  assert.equal(readFacadeTypedResultHistory({ ...f.ir }), null);
  assert.equal(readFacadeTypedResultHistory(f.ir, { ...f.call }), null);
  for (let index = 0; index < 2; index++) { annotateValueRanges(f.ir); assert.equal(readFacadeTypedResultHistory(f.ir), history); }
  f.call.dst.range = { min:0n, max:0n, bits:64, signed:false };
  assert.ok(readFacadeTypedResultHistory(f.ir) === null);
  assert.equal(observeProjectedOperationData(f.ir, history.events)(), true);
  assert.ok(readFacadeTypedResultHistory(f.ir) === null);
});

test('copied typed metadata cannot issue records, canonical values or rendered deletion', () => {
  const f = fixture(), map = buildRenderProvenance({ result:{ ir:f.ir, lines:[] }, snapshotId:'typed' });
  const record = map.ledger.find(record => record.kind === 'typed-call-result');
  const copied = buildRenderProvenance({ result:{ lines:[], phase8Projection:{ transforms:[structuredClone(record)] } }, snapshotId:'typed' });
  assert.ok(copied.reasons.includes('unissued-typed-call-result-history'));
  for (const mutate of [r => { r.producedRefs = ['L0:stmt']; }, r => { r.removedRefs = ['ir:1']; },
    r => { r.typedCallResultTransition.newCanonicalValue = true; }, r => { r.typedCallResultTransition.before = {}; },
    r => { r.typedCallResultTransition.after.bits = 16; }, r => { r.typedCallResultTransition.removedFields = ['def']; },
    r => { r.typedCallResultTransition.producedRefs = [`ssa:def:${f.call.dst.id}`]; }]) {
    const changed = structuredClone(map); mutate(changed.ledger.find(item => item.kind === record.kind));
    assert.ok(validateRenderProvenance(changed).reasons.includes('invalid-typed-call-result-history'));
  }
});

test('typed result observation bounds preserve actual writes and never produce skip-green history', () => {
  const f = fixture({ mutate:ir => { while (ir.values.length <= 512) ir.values.push({ id:ir.values.length, reg:null, def:null }); } });
  assert.equal(f.call.dst.compatDerived, 'typed-abi-call-result');
  assert.equal(facadeTypedResultTransitionExpected(f.ir), true);
  assert.equal(readFacadeTypedResultHistory(f.ir), null);
  assert.ok(buildRenderProvenance({ result:{ ir:f.ir, lines:[] }, snapshotId:'typed' }).reasons.includes('unavailable-typed-call-result-history'));
});

test('typed ledger budgets, cancellation and late source mutation remain explicitly incomplete', () => {
  const f = fixture(), before = clone(f.ir), result = { ir:f.ir, lines:[] };
  for (const budget of [{ maxTransformRecords:1 }, { maxOriginsPerEntity:1 }]) {
    assert.equal(buildRenderProvenance({ result, snapshotId:'typed', budget }).completeness, 'incomplete');
  }
  assert.equal(buildRenderProvenance({ result, shouldAbort:() => true }).completeness, 'incomplete');
  assert.deepEqual(clone(f.ir), before);
  let calls = 0;
  const map = buildRenderProvenance({ result, snapshotId:'typed', shouldAbort:() => { if (++calls === 2) f.call.returnReg = 'x1'; return false; } });
  assert.ok(map.reasons.includes('stale-typed-call-result-history'));
});

test('typed direct history is navigable without a rendered entity and stale query snapshots are rejected', async () => {
  const f = fixture(), map = buildRenderProvenance({ result:{ ir:f.ir, lines:[] }, snapshotId:'typed' });
  let epoch = 1;
  const api = new AnalysisQueryAPI({ currentIdentity:async () => ({ binaryId:'typed', projectRevision:1, analysisEpoch:epoch, artifactVersions:{} }),
    decompile:async () => ({ value:{ lines:[], pseudocode:'', renderProvenance:map }, status:{ completeness:'complete' } }) });
  const query = await api.decompile(await api.snapshot(), 'function');
  const navigation = createDecompilerNavigation(query, { currentSnapshot:() => api.snapshot() });
  const selected = await navigation.selectOrigin('ir', f.call.id);
  assert.equal(selected.state, 'ready', JSON.stringify({ selected, reasons:map.reasons }));
  assert.deepEqual(selected.entities, []);
  assert.ok(selected.transforms.some(record => record.kind === 'typed-call-result'));
  epoch++;
  assert.equal((await navigation.selectOrigin('ir', f.call.id)).reason, 'stale-query-snapshot');
});

test('pure matcher accepts only explicit data-field deletion chains and never grants writer authority', () => {
  const value = { keep:1, undefined:true }, observation = captureProjectionIrData([value]);
  delete value.undefined;
  const deletion = { object:value, key:'undefined', before:true, after:undefined, beforePresent:true, afterPresent:false };
  assert.equal(observation.matches(), false);
  assert.equal(observation.matchesThroughWrites([{ ...deletion, afterPresent:undefined }]), false);
  assert.equal(observation.matchesThroughWrites([{ ...deletion, before:false }]), false);
  assert.equal(observation.matchesThroughWrites([deletion]), true);
  value.unrecorded = 2;
  assert.equal(observation.matchesThroughWrites([deletion]), false, 'same key count cannot hide an undescribed replacement field');
  delete value.unrecorded;
  value.undefined = false;
  const added = { object:value, key:'undefined', before:undefined, after:false, beforePresent:false, afterPresent:true };
  assert.equal(observation.matchesThroughWrites([deletion, added]), true);
  assert.equal(observation.matchesThroughWrites([deletion, { ...added, beforePresent:true }]), false);
  assert.equal(observation.matchesThroughWrites([{ ...deletion, after:1 }, added]), false);
  delete value.keep;
  assert.equal(observation.matchesThroughWrites([deletion, added]), false);
  const array = [1], bounded = captureProjectionIrData([array]);
  delete array[0];
  assert.equal(bounded.matchesThroughWrites([{ object:array, key:'0', before:1, after:undefined, afterPresent:false }]), false);
});

test('dense array append matching requires exact length and every new index without weakening ordinary matching', () => {
  const array = [{ id:1 }], observation = captureProjectionIrData([array]), added = { id:2 };
  array.push(added);
  const index = { object:array, key:'1', before:undefined, after:added, beforePresent:false };
  const length = { object:array, key:'length', before:1, after:2 };
  assert.equal(observation.matches(), false);
  for (const writes of [[index], [length], [index, { ...length, before:0 }],
    [{ ...index, beforePresent:true }, length], [{ ...index, key:'2' }, length], [index, { ...length, afterPresent:false }]]) {
    assert.equal(observation.matchesThroughWrites(writes), false);
  }
  assert.equal(observation.matchesThroughWrites([index, length]), true);
  array.push(3);
  const second = { object:array, key:'2', before:undefined, after:3, beforePresent:false };
  const nextLength = { object:array, key:'length', before:2, after:3 };
  assert.equal(observation.matchesThroughWrites([index, length, second, nextLength]), true);
  assert.equal(observation.matchesThroughWrites([index, second, nextLength]), false);
  delete array[1];
  assert.equal(observation.matchesThroughWrites([index, length, second, nextLength]), false);
  const object = { removed:undefined }, original = captureProjectionIrData([object]);
  delete object.removed;
  assert.equal(original.matchesThroughWrites([{ object, key:'removed', before:undefined, after:undefined, afterPresent:false }]), true);
  assert.equal(original.matchesThroughWrites([{ object, key:'removed', before:undefined, after:undefined }]), false);
});

test('typed history uses one exact owned provenance test path', () => {
  const manifest = loadRoadmapManifest(), file = 'tests/phase8/provenance/typed-call-result-history.test.mjs';
  assert.deepEqual(validateRoadmapInventory(BRANCH, 'phase8', [file], manifest), [file]);
  assert.throws(() => validateRoadmapInventory(BRANCH, 'phase8', ['tests/phase8/provenance/unowned-typed-history.test.mjs'], manifest));
});

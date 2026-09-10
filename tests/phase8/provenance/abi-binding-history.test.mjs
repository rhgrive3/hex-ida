import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';

// Only selection/bounds controls use this worker seam. Positive decoded inputs
// invoke the unchanged production ABI adapter and writer without an override.
const loader = registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (!url.endsWith('/js/ir-core.js')) return result;
  const source = String(result.source), marker = 'const callBindingObserver = attachCanonicalCallArguments(';
  assert.equal(source.split(marker).length, 2);
  return { ...result, source:source.replace(marker, 'opts.__abiFixture?.(result.legacyV1);\n  ' + marker) };
} });
const { buildIR, readFacadeAbiBindingHistory, facadeAbiBindingExpected, readFacadeStateNormalization,
  readFacadeTypedResultHistory, readFacadePreservedStateHistory } = await import('../../../js/ir-core.js');
const { buildSemanticModel } = await import('../../../js/blocks.js');
const { annotateValueRanges } = await import('../../../js/semantics/compat/legacy-value-ranges.js');
const { observeProjectedOperationData } = await import('../../../js/semantics/compat/semantic-ir-v2-to-v1.js');
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
const callRule = 'attach-canonical-call-arguments', returnRule = 'attach-canonical-function-return';
function fixture({ bits = 32, fp = false, returnType = undefined, prototype = undefined, lines = null, mutate = null, onPrototype = null } = {}) {
  returnType = returnType === undefined ? fp ? bits === 32 ? 'float' : 'double' : bits === 32 ? 'int32' : 'int64' : returnType;
  prototype = prototype === undefined ? { returnType, returnBits:bits, returnsValue:true, args:[{ type:'int32', bits:32 }] } : prototype;
  lines ??= ['mov w0, #7', 'bl #0x100001000', 'ret'];
  const rows = lines.map((line, row) => { const split = line.indexOf(' '); return { row, address:0x100000000n + BigInt(row * 4), mn:split < 0 ? line : line.slice(0, split), ops:split < 0 ? '' : line.slice(split + 1) }; });
  const rowOfAddress = address => rows.find(row => row.address === BigInt(address))?.row ?? null;
  const model = buildSemanticModel(rows, { rowOfAddress, startRow:0, endRow:rows.length - 1 });
  let callbacks = 0;
  const ir = buildIR(model, { rowOfAddress, ...(returnType ? { returnType } : {}), semanticMigrationMode:'semantic-v2-compat',
    ...(prototype ? { callPrototypeFor:() => { callbacks++; onPrototype?.(); return prototype; } } : {}), ...(mutate ? { __abiFixture:mutate } : {}) });
  return { ir, model, callbacks, call:ir.instructions.find(inst => inst.op === 'call'), ret:ir.instructions.find(inst => inst.op === 'ret') };
}
function render(f, publicPipeline = false) {
  const seed = { semantic:true, ir:f.ir, types:{ values:new Map(), locations:new Map() },
    lines:[{ kind:'stmt', indent:1, text:'return old;', row:f.ret.row, addr:f.ret.address }],
    warnings:[], evidence:[], coverage:{ mode:'structured' }, summary:'' };
  f.result = (publicPipeline ? enhancePublic : enhanceSemanticDecompilation)(seed, f.model, { deterministicTransforms:true });
  return f;
}

test('normal integer and FP calls/returns record the actual old and new argument lists', () => {
  for (const bits of [32, 64]) for (const fp of [false, true]) {
    const f = fixture({ bits, fp }), before = clone(f.ir), history = readFacadeAbiBindingHistory(f.ir);
    assert.ok(history, `${bits}/${fp}`);
    assert.equal(history.completeness, 'complete');
    assert.deepEqual(history.events.map(event => event.direction), ['call', 'return']);
    for (const event of history.events) {
      assert.equal(event.source, event.direction === 'call' ? f.call : f.ret);
      assert.equal(event.afterArguments, event.source.args);
      assert.notEqual(event.beforeArguments, event.afterArguments);
      assert.equal(event.beforeArguments.length, event.direction === 'call' ? 1 : 0,
        'the decoded projector already leaves RET arguments empty; do not invent a displaced target');
      assert.equal(event.outcome, 'bound');
      assert.ok(event.selections.some(item => item.outcome === 'selected' && item.candidates[0].value === item.value));
      assert.ok(event.afterArguments.every(arg => f.ir.values.includes(arg.value)));
      assert.ok(Object.isFrozen(event) && Object.isFrozen(event.selections));
      assert.equal(readFacadeAbiBindingHistory(f.ir, event.source).events[0], event);
    }
    assert.deepEqual(clone(f.ir), before);
  }
});

test('unknown, void and aggregate function returns retain the actual empty result without inventing a scalar', () => {
  for (const returnType of [null, 'void', 'struct Pair']) {
    const f = fixture({ lines:['add w0, w0, #1', 'ret'], returnType, prototype:null });
    const event = readFacadeAbiBindingHistory(f.ir)?.events[0];
    assert.ok(event);
    assert.equal(event.direction, 'return');
    assert.equal(event.outcome, 'no-scalar-location');
    assert.equal(event.afterArguments.length, 0);
    assert.equal(event.returnReg, null);
    assert.equal(event.selections.length, 0);
    assert.equal(event.beforeArguments.length, 0);
    const map = buildRenderProvenance({ result:{ ir:f.ir, lines:[] }, snapshotId:'abi' });
    assert.deepEqual(validateRenderProvenance(map).reasons, []);
  }
});

test('a supplied nonempty return view retains its displaced canonical value without deleting it', () => {
  // Synthetic compatibility-view control only: the ordinary decoded projector
  // above has already cleared RET args before this facade writer runs.
  let original;
  const f = fixture({ mutate(ir) {
    const ret = ir.instructions.find(inst => inst.op === 'ret');
    const call = ir.instructions.find(inst => inst.op === 'call');
    original = call.args[0].value;
    ret.args = [{ value:original, bits:original.bits }];
  } });
  const event = readFacadeAbiBindingHistory(f.ir, f.ret)?.events[0];
  assert.ok(event);
  assert.equal(event.beforeArguments[0].value, original);
  assert.ok(f.ir.values.includes(original));
  assert.notEqual(event.afterArguments[0].value, original);
});

test('descriptor selection records duplicates, missing registers and missing reaching values in actual order', () => {
  const f = fixture({ mutate(ir) {
    const call = ir.instructions.find(inst => inst.op === 'call');
    const actual = call.callArguments.find(item => item.reg === 'x0'); assert.ok(actual);
    call.callArguments = [actual, { ...actual, possible:true, exact:false }, { reg:null }, { reg:'not-a-register', bits:32 }];
  } });
  const event = readFacadeAbiBindingHistory(f.ir, f.call)?.events[0];
  assert.ok(event);
  assert.deepEqual(event.selections.map(item => item.outcome), ['selected', 'duplicate-value', 'no-register', 'no-reaching-value']);
  assert.equal(event.afterArguments.length, 1);
});

test('an empty canonical call descriptor list records removal of the old target argument only from the public view', () => {
  const f = fixture({ mutate(ir) { ir.instructions.find(inst => inst.op === 'call').callArguments = []; } });
  const event = readFacadeAbiBindingHistory(f.ir, f.call)?.events[0];
  assert.ok(event);
  assert.equal(event.outcome, 'empty');
  assert.equal(event.beforeArguments.length, 1);
  assert.equal(event.afterArguments.length, 0);
  assert.ok(f.ir.values.includes(event.beforeArguments[0].value));
});

test('selected possible arguments preserve explicit uncertainty instead of inventing exactness', () => {
  const f = fixture({ mutate(ir) {
    const call = ir.instructions.find(inst => inst.op === 'call');
    call.callArguments = [{ ...call.callArguments.find(item => item.reg === 'x0'), possible:true, exact:false, mustUse:false }];
  } });
  const event = readFacadeAbiBindingHistory(f.ir, f.call)?.events[0];
  assert.ok(event);
  assert.equal(f.call.extra.abiPossibleArgumentValueIds.length, 1);
  const map = buildRenderProvenance({ result:{ ir:f.ir, lines:[] }, snapshotId:'abi' });
  const selected = map.ledger.find(record => record.rule === callRule).abiBindingTransition.selections[0];
  assert.equal(selected.possible, true); assert.equal(selected.exact, false); assert.equal(selected.mustUse, false);
  // This synthetic descriptor mutation intentionally invalidates an earlier
  // normalization observation. It must not be quietly promoted back to green.
  assert.deepEqual(validateRenderProvenance(map).reasons, ['unavailable-public-state-history']);
});

test('a typed return without any reaching register value records the actual empty selection', () => {
  const f = fixture({ lines:['ret'], prototype:null, returnType:'int32' });
  const event = readFacadeAbiBindingHistory(f.ir, f.ret)?.events[0];
  assert.ok(event);
  assert.equal(event.outcome, 'no-reaching-value');
  assert.equal(event.afterArguments.length, 0);
  assert.equal(event.selections.length, 1);
  assert.equal(event.selections[0].value, null);
  assert.equal(event.selections[0].candidates.length, 0);
});

test('an actual later prototype callback cannot reissue mutated call-binding before-images', () => {
  let call, changed = false;
  const f = fixture({ mutate(ir) { call = ir.instructions.find(inst => inst.op === 'call'); },
    onPrototype() {
      if (call?.extra?.abiProjectedArgumentValueIds) {
        call.extra.abiProjectedArgumentValueIds.push('unexpected-intermediate-write'); changed = true;
      }
    } });
  assert.equal(changed, true);
  assert.ok(readFacadeAbiBindingHistory(f.ir, f.call) === null);
  assert.equal(facadeAbiBindingExpected(f.ir, f.call), true);
  assert.notEqual(readFacadeAbiBindingHistory(f.ir)?.completeness, 'complete');
});

test('multiple typed calls retain actual preceding state restoration and both binding selections', () => {
  const f = fixture({ lines:['mov x19, #5', 'bl #0x100001000', 'bl #0x100002000', 'add x0, x19, #3', 'ret'] });
  assert.equal(readFacadeAbiBindingHistory(f.ir)?.completeness, 'complete');
  assert.equal(readFacadeAbiBindingHistory(f.ir).events.length, 3);
  assert.ok(readFacadeStateNormalization(f.ir));
  assert.equal(readFacadeTypedResultHistory(f.ir)?.events.length, 2);
  assert.ok(readFacadePreservedStateHistory(f.ir));
});

test('direct binding ledgers retain both old and new canonical references without fabricating rendered consumers', () => {
  const f = fixture(), before = clone(f.ir), map = buildRenderProvenance({ result:{ ir:f.ir, lines:[] }, snapshotId:'abi' });
  const records = map.ledger.filter(record => record.kind === 'abi-argument-binding');
  assert.equal(records.length, 2);
  assert.equal(map.completeness, 'complete', JSON.stringify(map.reasons));
  for (const record of records) {
    assert.deepEqual(record.producedRefs, []); assert.deepEqual(record.removedRefs, []);
    assert.equal(record.abiBindingTransition.newCanonicalValue, false);
    for (const ref of [...record.abiBindingTransition.beforeRefs, ...record.abiBindingTransition.afterRefs]) assert.ok(map.transformReverse[ref]?.includes(map.ledger.indexOf(record)));
  }
  assert.deepEqual(validateRenderProvenance(map).reasons, []);
  assert.deepEqual(clone(f.ir), before);
});

test('actual core and public return consumers retain call and return bindings through repeated projection', () => {
  for (const publicPipeline of [false, true]) {
    const f = render(fixture(), publicPipeline);
    let result = applyPhase8Projection(f.result, analysis());
    assert.equal(result.renderProvenance.completeness, 'complete', JSON.stringify({ publicPipeline, reasons:result.renderProvenance.reasons, binding:f.result.expressionHistoryBinding }));
    for (const rule of [callRule, returnRule]) assert.ok(result.renderProvenance.ledger.some(record => record.kind === 'expression-rewrite' && record.rule === rule && record.producedRefs.length), rule);
    const ledger = result.renderProvenance.ledger;
    result = applyPhase8Projection(result, analysis());
    assert.deepEqual(result.renderProvenance.ledger, ledger);
  }
});

test('changed selected/rejected candidates, descriptors, uses, metadata and positions revoke private bindings', () => {
  for (const mutate of [
    (f, history) => { history.events[0].beforeArguments[0].bits = 8; },
    (f, history) => { history.events[0].beforeExtra.name = 'other'; },
    f => { f.call.callArguments[0].bits = 8; }, f => { f.call.args = [...f.call.args]; },
    f => { f.call.args[0].value.uses.push(f.ret); }, f => { f.ir.values[0].id = 9999; },
    f => { f.ir.values[0].reg = 'x28'; }, f => { f.ir.dominators[0].add(99); },
    f => { f.ir.instructions = [...f.ir.instructions]; }, f => { f.ir.blocks[0].insts.reverse(); },
  ]) {
    const f = fixture(), history = readFacadeAbiBindingHistory(f.ir); assert.ok(history);
    mutate(f, history);
    assert.ok(readFacadeAbiBindingHistory(f.ir) === null);
    assert.equal(facadeAbiBindingExpected(f.ir), true);
    assert.ok(buildRenderProvenance({ result:{ ir:f.ir, lines:[] }, snapshotId:'abi' }).reasons.includes('unavailable-abi-binding-history'));
  }
  const f = fixture(); let reads = 0;
  Object.defineProperty(f.ir.values[0], 'id', { configurable:true, enumerable:true, get() { reads++; return 0; } });
  assert.ok(readFacadeAbiBindingHistory(f.ir) === null);
  assert.equal(reads, 0);
});

test('range annotation is carried but caller-created matchers and copies cannot reseal stale ABI records', () => {
  const f = fixture(), history = readFacadeAbiBindingHistory(f.ir);
  assert.equal(readFacadeAbiBindingHistory({ ...f.ir }), null);
  assert.equal(readFacadeAbiBindingHistory(f.ir, { ...f.call }), null);
  annotateValueRanges(f.ir); annotateValueRanges(f.ir);
  assert.equal(readFacadeAbiBindingHistory(f.ir), history);
  f.call.args[0].bits = 8;
  assert.ok(readFacadeAbiBindingHistory(f.ir) === null);
  assert.equal(observeProjectedOperationData(f.ir, history.events)(), true);
  assert.ok(readFacadeAbiBindingHistory(f.ir) === null);
});

test('a scanned but unrelated physical-register candidate stays part of selection history', () => {
  const f = fixture({ lines:['mov x27, #9', 'mov w0, #7', 'bl #0x100001000', 'ret'] });
  const history = readFacadeAbiBindingHistory(f.ir); assert.ok(history);
  const unrelated = f.ir.values.find(value => value.reg === 'x27' && value.def);
  assert.ok(unrelated);
  assert.ok(history.events.every(event => !event.beforeInputs.includes(unrelated)));
  unrelated.reg = 'x0';
  assert.ok(readFacadeAbiBindingHistory(f.ir) === null);
});

test('copied and malformed ABI ledgers do not issue a binding or a new ABI/SSA theorem', () => {
  const f = fixture(), map = buildRenderProvenance({ result:{ ir:f.ir, lines:[] }, snapshotId:'abi' });
  const record = map.ledger.find(record => record.kind === 'abi-argument-binding');
  const copied = buildRenderProvenance({ result:{ lines:[], phase8Projection:{ transforms:[structuredClone(record)] } }, snapshotId:'abi' });
  assert.ok(copied.reasons.includes('unissued-abi-binding-history'));
  for (const mutate of [r => { r.producedRefs = ['L0:stmt']; }, r => { r.removedRefs = ['ir:0']; },
    r => { r.abiBindingTransition.newCanonicalValue = true; }, r => { r.abiBindingTransition.direction = 'other'; },
    r => { r.abiBindingTransition.afterRefs = []; }, r => { r.abiBindingTransition.beforeRefs = ['ssa:def:missing']; },
    r => { r.abiBindingTransition.selections[0].candidateRefs = []; }, r => { r.abiBindingTransition.selections[0].possible = 'true'; }]) {
    const changed = structuredClone(map); mutate(changed.ledger.find(item => item.kind === record.kind));
    assert.ok(validateRenderProvenance(changed).reasons.includes('invalid-abi-binding-history'));
  }
});

test('oversized selection retains actual argument writes and reports missing history', () => {
  const f = fixture({ mutate(ir) { while (ir.values.length <= 512) ir.values.push({ id:ir.values.length, reg:null, def:null }); } });
  assert.ok(f.call.args.length && f.ret.args.length);
  assert.equal(facadeAbiBindingExpected(f.ir), true);
  assert.ok(readFacadeAbiBindingHistory(f.ir) === null);
  assert.ok(buildRenderProvenance({ result:{ ir:f.ir, lines:[] }, snapshotId:'abi' }).reasons.includes('unavailable-abi-binding-history'));
});

test('ABI ledger budgets and cancellation remain incomplete without changing public IR', () => {
  const f = fixture(), before = clone(f.ir), result = { ir:f.ir, lines:[] };
  for (const budget of [{ maxTransformRecords:1 }, { maxOriginsPerEntity:1 }]) {
    const map = buildRenderProvenance({ result, snapshotId:'abi', budget });
    assert.equal(map.completeness, 'incomplete'); assert.ok(map.reasons.includes('truncated'));
  }
  assert.equal(buildRenderProvenance({ result, shouldAbort:() => true }).completeness, 'incomplete');
  assert.deepEqual(clone(f.ir), before);
});

test('late descriptor mutation is detected after ledger serialization', () => {
  const f = fixture(); let polls = 0;
  const map = buildRenderProvenance({ result:{ ir:f.ir, lines:[] }, snapshotId:'abi', shouldAbort() { if (++polls === 2) f.call.callArguments[0].bits = 8; return false; } });
  assert.ok(map.reasons.includes('stale-abi-binding-history'));
});

test('query navigation reaches discarded control values and rejects old snapshots', async () => {
  const f = fixture(), before = readFacadeAbiBindingHistory(f.ir).events[0].beforeArguments[0].value;
  const map = buildRenderProvenance({ result:{ ir:f.ir, lines:[] }, snapshotId:'abi' });
  let epoch = 1;
  const api = new AnalysisQueryAPI({ currentIdentity:async () => ({ binaryId:'abi', projectRevision:1, analysisEpoch:epoch, artifactVersions:{} }),
    decompile:async () => ({ value:{ lines:[], pseudocode:'', renderProvenance:map }, status:{ completeness:'complete' } }) });
  const query = await api.decompile(await api.snapshot(), 'function');
  const navigation = createDecompilerNavigation(query, { currentSnapshot:() => api.snapshot() });
  const selected = await navigation.selectOrigin('ssa', `def:${before.id}`);
  assert.equal(selected.state, 'ready');
  assert.ok(selected.transforms.some(record => record.kind === 'abi-argument-binding'));
  assert.deepEqual(selected.entities, []);
  epoch++;
  assert.equal((await navigation.selectOrigin('ssa', `def:${before.id}`)).reason, 'stale-query-snapshot');
});

test('ABI binding history uses one exact owned path in the canonical provenance subtree', () => {
  const file = 'tests/phase8/provenance/abi-binding-history.test.mjs', manifest = loadRoadmapManifest();
  assert.deepEqual(validateRoadmapInventory(BRANCH, 'phase8', [file], manifest), [file]);
  assert.throws(() => validateRoadmapInventory(BRANCH, 'phase8', ['tests/phase8/provenance/unowned-abi-binding.test.mjs'], manifest));
});

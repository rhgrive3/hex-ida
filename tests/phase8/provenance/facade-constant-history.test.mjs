import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSemanticModel } from '../../../js/blocks.js';
import { buildIR, readFacadeConstantTransitions, facadeConstantTransitionExpected,
  readFacadePreservedStateHistory, facadePreservedStateTransitionExpected, readFacadeStateNormalization } from '../../../js/ir-core.js';
import { captureProjectionIrData } from '../../../js/core/identity/live-data.js';
import { observeProjectedOperationData, readProjectedConstantTransitions } from '../../../js/semantics/compat/semantic-ir-v2-to-v1.js';
import { annotateValueRanges } from '../../../js/semantics/compat/legacy-value-ranges.js';
import { enhanceSemanticDecompilation, readExpressionHistoryConsumer } from '../../../js/decompiler/pipeline-core.js';
import { enhanceSemanticDecompilation as enhancePublic } from '../../../js/decompiler/pipeline.js';
import { applyPhase8Projection } from '../../../js/decompiler/phase8/projection.js';
import { buildRenderProvenance, validateRenderProvenance } from '../../../js/decompiler/phase8/render-provenance.js';
import { AnalysisQueryAPI } from '../../../js/analysis/query/api.js';
import { createDecompilerNavigation } from '../../../js/ui/decompiler-provenance.js';
import { analysis } from './fixture.js';
import { BRANCH, loadRoadmapManifest, validateRoadmapInventory } from '../../../tools/validation/analysis-roadmap/ownership.mjs';

const rule = 'fold-facade-constant';
const preservedRule = 'restore-abi-preserved-state';
const clone = ir => structuredClone(Object.fromEntries(Object.entries(ir).filter(([, value]) => typeof value !== 'function')));

function fixture({ bits = 64, op = 'add', lines = null } = {}) {
  const register = bits === 32 ? 'w' : 'x';
  lines ??= ['mov x19, #5', 'bl #0x100001000', `${op} ${register}0, ${register}19, #3`, 'ret'];
  const base = 0x100000000n;
  const rows = lines.map((line, row) => {
    const split = line.indexOf(' ');
    return { row, address:base + BigInt(row * 4), mn:split < 0 ? line : line.slice(0, split), ops:split < 0 ? '' : line.slice(split + 1) };
  });
  const rowOfAddress = address => {
    const delta = BigInt(address) - base;
    return delta < 0n || delta >= BigInt(rows.length * 4) ? null : Number(delta / 4n);
  };
  const model = buildSemanticModel(rows, { startRow:0, endRow:rows.length - 1, rowOfAddress });
  const ir = buildIR(model, { rowOfAddress, returnType:bits === 32 ? 'int32' : 'int64', semanticMigrationMode:'semantic-v2-compat' });
  const sources = ir.instructions.filter(source => facadeConstantTransitionExpected(ir, source));
  return { ir, model, sources, operation:sources.find(source => source.op === 'bin'), ret:ir.instructions.find(source => source.op === 'ret') };
}

function render(f, opts = {}, publicPipeline = false) {
  const seed = { semantic:true, ir:f.ir, types:{ values:new Map(), locations:new Map() },
    lines:[{ kind:'stmt', indent:1, text:'return old;', row:f.ret.row, addr:f.ret.address }],
    warnings:[], evidence:[], coverage:{ mode:'structured' }, summary:'' };
  f.result = (publicPipeline ? enhancePublic : enhanceSemanticDecompilation)(seed, f.model, { deterministicTransforms:true, ...opts });
  return f;
}

test('actual ABI preserved-state restoration retains replaced operands and the actual reaching candidate order', () => {
  for (const bits of [32, 64]) {
    const f = fixture({ bits }), before = clone(f.ir), history = readFacadePreservedStateHistory(f.ir);
    assert.ok(history?.events.length, `${bits}: actual restoration must be observed`);
    assert.equal(history.completeness, 'complete');
    assert.ok(Object.isFrozen(history) && Object.isFrozen(history.events));
    for (const event of history.events) {
      assert.equal(event.stage, 'facade-preserved-state');
      assert.equal(event.source.args[0], event.argument);
      assert.equal(event.argument.value, event.after);
      assert.notEqual(event.before, event.after);
      assert.equal(event.before.def, event.call);
      assert.equal(event.call.op, 'call');
      assert.equal(event.candidates[0].value, event.after);
      assert.equal(event.abiId, 'aapcs64');
      assert.equal(event.registerId, 'x19');
      assert.equal(event.callerSaved.includes(event.registerId), false);
      assert.ok(event.candidates.every(input => event.beforeInputs.includes(input.value)));
      assert.ok(event.inputs.some(input => input.value === event.before));
      assert.ok(event.inputs.some(input => input.value === event.after));
      assert.ok(f.ir.values.includes(event.before) && f.ir.values.includes(event.after));
      assert.equal(facadePreservedStateTransitionExpected(f.ir, event.source), true);
      assert.equal(readFacadePreservedStateHistory(f.ir, event.source).events[0], event);
    }
    assert.deepEqual(clone(f.ir), before);
  }
});

test('ordinary values, caller-clobbered registers and copied ABI metadata cannot issue restoration history', () => {
  for (const lines of [['mov x0, #5', 'ret'], ['mov x9, #5', 'bl #0x100001000', 'add x0, x9, #3', 'ret']]) {
    const f = fixture({ lines });
    assert.equal(facadePreservedStateTransitionExpected(f.ir), false);
    assert.equal(readFacadePreservedStateHistory(f.ir), null);
  }
  const f = fixture(), history = readFacadePreservedStateHistory(f.ir);
  assert.ok(history);
  assert.equal(readFacadePreservedStateHistory({ ...f.ir }), null);
  assert.equal(readFacadePreservedStateHistory(f.ir, { ...history.events[0].source }), null);
  const legacy = buildIR(f.model, { semanticMigrationMode:'legacy-v1' });
  assert.equal(readFacadePreservedStateHistory(legacy), null);
});

test('ABI restoration observes rejected candidates, dominance sets, live operands, input positions and getter mutations', () => {
  for (const mutate of [
    (f, e) => { e.argument.value = e.before; },
    (f, e) => { e.source.extra.abiPreservedStateEvidence = 'copied'; },
    (f, e) => { e.call.args = [...e.call.args]; },
    (f, e) => { e.after.const = 99n; },
    (f, e) => { e.call.row++; },
    f => { f.ir.values.push({ id:'new-candidate', reg:'x19', kind:'arg', bits:64 }); },
    (f, e) => { f.ir.values.find(value => !e.beforeInputs.includes(value) && value !== e.output).reg = 'x19'; },
    f => { f.ir.dominators[0].add(999); },
    f => { f.ir.dominators = [...f.ir.dominators]; },
    f => { f.ir.values = [...f.ir.values]; },
    f => { f.ir.instructions = [...f.ir.instructions]; },
  ]) {
    const f = fixture(), history = readFacadePreservedStateHistory(f.ir);
    assert.ok(history);
    mutate(f, history.events[0]);
    assert.equal(history.isCurrent(), false);
    assert.equal(readFacadePreservedStateHistory(f.ir), null);
    assert.equal(facadePreservedStateTransitionExpected(f.ir), true);
    assert.ok(buildRenderProvenance({ result:{ ir:f.ir, lines:[] }, snapshotId:'abi' }).reasons.includes('unavailable-abi-state-history'));
  }
  const f = fixture(), event = readFacadePreservedStateHistory(f.ir).events[0];
  let reads = 0;
  Object.defineProperty(event.after, 'reg', { configurable:true, enumerable:true, get:() => { reads++; return 'x19'; } });
  assert.equal(readFacadePreservedStateHistory(f.ir), null);
  assert.equal(reads, 0);
});

test('ABI restoration history follows only actual range annotation and cannot be reissued by a data matcher', () => {
  const f = fixture(), history = readFacadePreservedStateHistory(f.ir);
  for (let i = 0; i < 2; i++) {
    annotateValueRanges(f.ir);
    assert.equal(readFacadePreservedStateHistory(f.ir), history);
  }
  history.events[0].after.range = { min:0n, max:0n, bits:64, signed:false };
  assert.equal(readFacadePreservedStateHistory(f.ir), null);
  assert.equal(observeProjectedOperationData(f.ir, history.events)(), true);
  assert.equal(readFacadePreservedStateHistory(f.ir), null, 'pure data matching does not reseal');
});

test('ABI restoration reaches direct reverse history without a rendered line or a deleted canonical value', () => {
  const f = fixture(), events = readFacadePreservedStateHistory(f.ir).events, before = clone(f.ir);
  const map = buildRenderProvenance({ result:{ ir:f.ir, lines:[] }, snapshotId:'abi' });
  const records = map.ledger.filter(record => record.kind === 'abi-state-restoration');
  assert.equal(records.length, events.length);
  for (const record of records) {
    const transition = record.abiStateTransition;
    assert.equal(record.rule, preservedRule);
    assert.equal(transition.canonicalValuesRetained, true);
    assert.deepEqual(record.producedRefs, []);
    assert.deepEqual(record.removedRefs, []);
    for (const ref of transition.consumedRefs) assert.ok(map.transformReverse[ref].includes(map.ledger.indexOf(record)));
    assert.ok(map.transformReverse[transition.callRef].includes(map.ledger.indexOf(record)));
  }
  assert.deepEqual(clone(f.ir), before);
});

test('actual rendered consumers retain ABI restoration inputs through core/public projection and replay', () => {
  for (const publicPipeline of [false, true]) {
    const f = render(fixture(), {}, publicPipeline), events = readFacadePreservedStateHistory(f.ir).events;
    let result = applyPhase8Projection(f.result, analysis());
    const records = result.renderProvenance.ledger.filter(record => record.rule === preservedRule && record.kind === 'expression-rewrite');
    assert.ok(records.length);
    for (const event of events) assert.ok(records.some(record => record.producedRefs.length
      && record.originHistory.consumedRefs.includes(`ssa:def:${event.before.id}`)
      && record.originHistory.consumedRefs.includes(`ssa:def:${event.after.id}`)));
    const ledger = result.renderProvenance.ledger;
    result = applyPhase8Projection(result, analysis());
    assert.deepEqual(result.renderProvenance.ledger, ledger);
  }
});

test('ABI restoration direct metadata cannot bind visible lines, claim deletions or survive copied admission', () => {
  const f = fixture(), original = buildRenderProvenance({ result:{ ir:f.ir, lines:[] }, snapshotId:'abi' });
  const record = original.ledger.find(record => record.kind === 'abi-state-restoration');
  const visible = buildRenderProvenance({ result:{ ir:f.ir, lines:[{ kind:'stmt', row:record.origin.rows[0], text:'copied;' }] }, snapshotId:'abi' });
  assert.ok(visible.ledger.filter(item => item.kind === record.kind).every(item => !item.producedRefs.length));
  const forged = buildRenderProvenance({ result:{ lines:[], phase8Projection:{ transforms:[structuredClone(record)] } }, snapshotId:'abi' });
  assert.ok(forged.reasons.includes('unissued-abi-state-history'));
  for (const mutate of [
    r => { r.producedRefs = ['L0:stmt']; }, r => { r.removedRefs = ['ssa:def:1']; },
    r => { r.abiStateTransition.beforeRef = r.abiStateTransition.afterRef; },
    r => { r.abiStateTransition.canonicalValuesRetained = false; },
    r => { r.abiStateTransition.argumentIndex = -1; },
    r => { r.abiStateTransition.consumedRefs = []; },
    r => { r.proof = 'equivalent'; },
  ]) {
    const changed = structuredClone(original);
    mutate(changed.ledger.find(item => item.kind === record.kind));
    assert.ok(validateRenderProvenance(changed).reasons.includes('invalid-abi-state-history'));
  }
});

test('ABI history budgets, cancellation and mutations during ledger construction stay explicit', () => {
  const f = fixture(), before = clone(f.ir), result = { ir:f.ir, lines:[] };
  for (const budget of [{ maxTransformRecords:1 }, { maxOriginsPerEntity:1 }]) {
    const map = buildRenderProvenance({ result, snapshotId:'abi', budget });
    assert.equal(map.completeness, 'incomplete');
    assert.ok(map.reasons.includes('truncated'));
  }
  assert.equal(buildRenderProvenance({ result, snapshotId:'abi', shouldAbort:() => true }).completeness, 'incomplete');
  assert.deepEqual(clone(f.ir), before);
  let calls = 0;
  const map = buildRenderProvenance({ result, snapshotId:'abi', shouldAbort:() => {
    if (++calls === 2) readFacadePreservedStateHistory(f.ir).events[0].source.row++;
    return false;
  } });
  assert.ok(map.reasons.includes('stale-abi-state-history'));
});

test('query navigation reaches replaced ABI input history with no current entity and rejects stale snapshots', async () => {
  const f = fixture(), event = readFacadePreservedStateHistory(f.ir).events[0];
  const map = buildRenderProvenance({ result:{ ir:f.ir, lines:[] }, snapshotId:'abi' });
  assert.ok(readFacadeStateNormalization(f.ir), 'actual restoration and constant writes must carry predecessor state history');
  assert.equal(map.completeness, 'complete', JSON.stringify(map.reasons));
  let epoch = 1;
  const api = new AnalysisQueryAPI({ currentIdentity:async () => ({ binaryId:'abi', projectRevision:1, analysisEpoch:epoch, artifactVersions:{} }),
    decompile:async () => ({ value:{ lines:[], pseudocode:'', renderProvenance:map }, status:{ completeness:'complete' } }) });
  const snapshot = await api.snapshot(), query = await api.decompile(snapshot, 'function');
  const navigation = createDecompilerNavigation(query, { currentSnapshot:() => api.snapshot() });
  const selected = await navigation.selectOrigin('ssa', `def:${event.before.id}`);
  assert.equal(selected.state, 'ready', JSON.stringify({ selected, reasons:map.reasons }));
  assert.deepEqual(selected.entities, []);
  assert.ok(selected.transforms.some(record => record.rule === preservedRule));
  epoch++;
  assert.equal((await navigation.selectOrigin('ssa', `def:${event.before.id}`)).reason, 'stale-query-snapshot');
});

test('pure live-data matching requires explicit absent-field writes and cannot admit arbitrary added metadata', () => {
  const value = { existing:1 }, observation = captureProjectionIrData([value]);
  value.added = 2;
  const write = { object:value, key:'added', before:undefined, after:2, beforePresent:false };
  assert.equal(observation.matches(), false);
  assert.equal(observation.matchesThroughWrites([{ ...write, beforePresent:undefined }]), false);
  assert.equal(observation.matchesThroughWrites([{ ...write, before:1 }]), false);
  assert.equal(observation.matchesThroughWrites([write]), true);
  value.added = 3;
  assert.equal(observation.matchesThroughWrites([write]), false);
  const next = { object:value, key:'added', before:2, after:3 };
  assert.equal(observation.matchesThroughWrites([write, next]), true);
  assert.equal(observation.matchesThroughWrites([write, { ...next, before:9 }]), false);
  let reads = 0;
  Object.defineProperty(value, 'added', { configurable:true, enumerable:true, get:() => { reads++; return 3; } });
  assert.equal(observation.matchesThroughWrites([write, next]), false);
  assert.equal(reads, 0);
  const array = [], arrayObservation = captureProjectionIrData([array]);
  array.push(1);
  assert.equal(arrayObservation.matchesThroughWrites([{ object:array, key:'0', before:undefined, after:1, beforePresent:false }]), false);
});

test('actual public facade writes preserve recursive read facts rather than hypothetical intermediate writes', () => {
  const f = fixture(), before = clone(f.ir);
  assert.equal(f.sources.length, 3);
  for (const source of f.sources) {
    const record = readFacadeConstantTransitions(f.ir, source);
    assert.ok(record);
    assert.ok(Object.isFrozen(record) && Object.isFrozen(record.events));
    assert.equal(record.events.length, 1);
    const [event] = record.events;
    assert.equal(event.source, source);
    assert.equal(event.output, source.dst);
    assert.equal(event.stage, 'facade-exact-constants');
    assert.equal(event.beforeConstant, null);
    assert.equal(event.afterConstant, source.dst.const);
    assert.ok(Object.isFrozen(event) && Object.isFrozen(event.inputs) && event.inputs.every(Object.isFrozen));
    assert.equal(event.inputs[0].value, source.dst);
    assert.equal(event.inputs[0].constant, null);
  }
  const event = readFacadeConstantTransitions(f.ir, f.operation).events[0];
  assert.equal(event.afterConstant, 8n);
  assert.equal(event.inputs.length, 4);
  const intermediate = event.inputs.find(input => input.value !== event.output && input.constant === null);
  assert.ok(intermediate, 'recursive evaluation reached an as-yet-unwritten MOV');
  assert.equal(intermediate.value.const, 5n);
  assert.ok(readFacadeConstantTransitions(f.ir, intermediate.definition).events[0].ordinal > event.ordinal,
    'value iteration writes the evaluated dependency later; recursion itself is not a write');
  assert.deepEqual(clone(f.ir), before, 'reading history never changes IR');
});

test('ordinary preprojected constants, unknown call-clobbered inputs and explicit legacy mode acquire no facade events', () => {
  for (const lines of [
    ['mov w0, #5', 'ret'],
    ['mov x9, #5', 'bl #0x100001000', 'add x0, x9, #3', 'ret'],
    ['add x0, x0, #3', 'ret'],
  ]) assert.deepEqual(fixture({ lines }).sources, []);
  const f = fixture();
  const legacy = buildIR(f.model, { semanticMigrationMode:'legacy-v1' });
  for (const source of legacy.instructions) assert.equal(readFacadeConstantTransitions(legacy, source), null);
});

test('facade fold arithmetic is observed at both native register widths', () => {
  let cells = 0;
  for (const bits of [32, 64]) for (const [op, expected] of [['add', 8n], ['sub', 2n], ['and', 1n], ['orr', 7n], ['eor', 6n], ['lsl', 40n], ['lsr', 0n]]) {
    const f = fixture({ bits, op });
    assert.ok(f.operation, `${bits}/${op}`);
    const event = readFacadeConstantTransitions(f.ir, f.operation)?.events[0];
    assert.ok(event, `${bits}/${op}`);
    assert.equal(event.afterConstant, expected, `${bits}/${op}`);
    assert.equal(event.bits, bits);
    cells++;
  }
  assert.equal(cells, 14, 'actual operation/width fixtures, not equivalence or compiler coverage');
});

test('root, source, recursive dependency, positions and getters revoke facade history without getter invocation', () => {
  for (const mutate of [
    f => { f.operation.dst.const = 9n; },
    f => { f.operation.sub = 'sub'; },
    f => { f.operation.args[0] = { ...f.operation.args[0] }; },
    f => { readFacadeConstantTransitions(f.ir, f.operation).events[0].inputs.at(-1).value.const = 7n; },
    f => { f.ir.values = [...f.ir.values]; },
    f => { f.ir.instructions = [...f.ir.instructions]; },
    f => { f.ir.blocks[0].insts = [...f.ir.blocks[0].insts]; },
  ]) {
    const f = fixture();
    assert.ok(readFacadeConstantTransitions(f.ir, f.operation));
    mutate(f);
    assert.equal(readFacadeConstantTransitions(f.ir, f.operation), null);
    assert.equal(facadeConstantTransitionExpected(f.ir, f.operation), true);
  }
  const f = fixture();
  let reads = 0;
  Object.defineProperty(f.operation.dst, 'const', { enumerable:true, configurable:true, get:() => { reads++; return 8n; } });
  assert.equal(readFacadeConstantTransitions(f.ir, f.operation), null);
  assert.equal(reads, 0);
});

test('copied roots and pure-data observation cannot issue or reseal facade/projector authority', () => {
  const f = fixture(), copied = { ...f.ir };
  const event = readFacadeConstantTransitions(f.ir, f.operation).events[0];
  assert.equal(observeProjectedOperationData(copied, [event])(), true);
  assert.equal(readFacadeConstantTransitions(copied, f.operation), null);
  assert.equal(readProjectedConstantTransitions(copied, f.operation), null);
  assert.equal(readFacadeConstantTransitions(f.ir, { ...f.operation }), null);
  f.operation.dst.const = 9n;
  assert.equal(observeProjectedOperationData(f.ir, [event])(), true, 'new data matcher has no authority');
  assert.equal(readFacadeConstantTransitions(f.ir, f.operation), null);
});

test('real range annotation carries facade records, but a manual new range or later range mutation cannot', () => {
  const f = fixture();
  for (let i = 0; i < 2; i++) {
    annotateValueRanges(f.ir);
    assert.ok(readFacadeConstantTransitions(f.ir, f.operation));
  }
  f.operation.dst.range.max++;
  assert.equal(readFacadeConstantTransitions(f.ir, f.operation), null);
  const g = fixture();
  g.operation.dst.range = { min:8n, max:8n, bits:64, signed:false };
  assert.equal(readFacadeConstantTransitions(g.ir, g.operation), null);
});

test('actual facade histories bind to rendered consumers and survive repeat projection', () => {
  for (const publicPipeline of [false, true]) {
    const f = render(fixture(), {}, publicPipeline), before = clone(f.ir);
    let result = applyPhase8Projection(f.result, analysis());
    const records = result.renderProvenance.ledger.filter(record => record.rule === rule);
    assert.ok(records.length >= f.sources.length);
    const rendered = records.filter(record => record.producedRefs.includes('L0:stmt'));
    assert.equal(rendered.length, f.sources.length);
    for (const record of rendered) {
      assert.equal(record.proof, 'observed-facade-constant-write-not-equivalence');
      assert.equal(record.renderedBinding, 'producer-bound');
      assert.match(record.before, /^facade-exact-constants:0:/);
    }
    for (const source of f.sources) assert.ok(rendered.some(record => record.originHistory.consumedRefs.includes(`ir:${source.id}`)));
    const ledger = result.renderProvenance.ledger;
    for (let i = 0; i < 3; i++) result = applyPhase8Projection(result, analysis());
    assert.deepEqual(result.renderProvenance.ledger, ledger);
    assert.deepEqual(clone(f.ir), before);
  }
});

test('source mutation before/after render withholds facade records or revokes their consumers', () => {
  const f = fixture();
  f.operation.sub = 'sub';
  const result = applyPhase8Projection(render(f).result, analysis());
  assert.deepEqual(result.renderProvenance.ledger.filter(record => record.rule === rule), []);
  assert.equal(result.renderProvenance.completeness, 'incomplete');
  const g = render(fixture());
  const consumer = g.result.cAst.body[0].semantic;
  assert.ok(readExpressionHistoryConsumer(consumer, g.ir));
  g.operation.dst.const = 9n;
  assert.equal(readExpressionHistoryConsumer(consumer, g.ir), null);
});

test('consumer budgets and cancellation preserve facade pseudocode without inventing a complete history', () => {
  const baseline = render(fixture()).result.pseudocode;
  for (const opts of [
    { renderProvenanceBudget:{ maxTransformRecords:0 } },
    { renderProvenanceBindingBudget:{ maxEdges:0 } },
    { renderProvenanceBindingBudget:{ maxConsumers:0 } },
    { shouldAbort:() => true },
  ]) {
    const f = render(fixture(), opts);
    assert.equal(f.result.pseudocode, baseline);
    assert.equal(applyPhase8Projection(f.result, analysis()).renderProvenance.completeness, 'incomplete');
  }
});

test('facade provenance ownership is explicit with neighboring paths still rejected', () => {
  const manifest = loadRoadmapManifest(), files = Object.values(manifest.owners).flat();
  assert.ok(manifest.owners.semanticCompat.includes('js/ir-core.js'));
  assert.ok(manifest.owners.phase8.includes('tests/phase8/provenance/facade-constant-history.test.mjs'));
  for (const phase of ['phase7', 'phase8']) {
    assert.doesNotThrow(() => validateRoadmapInventory(BRANCH, phase, files));
    assert.throws(() => validateRoadmapInventory(BRANCH, phase, [...files, 'js/semantics/compat/unreviewed-facade.js']), /undeclared/);
  }
});

test('a large actual facade pass preserves constants when bounded history is unavailable', () => {
  const count = 350;
  const f = fixture({ lines:['mov x19, #5', 'bl #0x100001000',
    ...Array.from({ length:count }, () => 'add x0, x19, #3'), 'ret'] });
  assert.ok(f.sources.length > 1024, 'real writes exceed the operation-description allowance');
  const operations = f.sources.filter(source => source.op === 'bin');
  assert.equal(operations.length, count);
  assert.ok(operations.every(source => source.dst.const === 8n), 'history bounds must not change arithmetic');
  assert.ok(f.sources.some(source => readFacadeConstantTransitions(f.ir, source) === null));
});

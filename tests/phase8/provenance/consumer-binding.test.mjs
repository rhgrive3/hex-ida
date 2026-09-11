import assert from 'node:assert/strict';
import test from 'node:test';
import { readExpressionHistoryConsumer } from '../../../js/decompiler/pipeline-core.js';
import { applyPhase8Projection } from '../../../js/decompiler/phase8/projection.js';
import { buildRenderProvenance, validateRenderProvenance } from '../../../js/decompiler/phase8/render-provenance.js';
import { AnalysisQueryAPI } from '../../../js/analysis/query/api.js';
import { createDecompilerNavigation } from '../../../js/ui/decompiler-provenance.js';
import { structuralKey } from '../../../js/decompiler/ast/nodes.js';
import { captureProjectionIrData, createProjectionIrObserver, PROJECTION_LIMITS } from '../../../js/core/identity/live-data.js';
import { captureRecoveryIrData } from '../../../js/decompiler/phase8/projection-origin.js';
import { observeProjectedOperationData } from '../../../js/semantics/compat/semantic-ir-v2-to-v1.js';
import { createExpressionOriginHistoryRecorder, expressionOriginHistory } from '../../../js/decompiler/rewrite/engine.js';
import { analysis, consumerFixture as fixture, expr, resultWith, source } from './fixture.js';



test('C4-03 immutable history payloads share storage without sharing operations or mutable inputs', () => {
  const record = createExpressionOriginHistoryRecorder();
  const input = { source:{ ir:['one'], addresses:[1n] } };
  const first = record(input, input), second = record(input, input);
  assert.notEqual(first, second);
  assert.equal(first.before, first.after);
  assert.equal(first.before, second.before);
  assert.ok(Object.isFrozen(first.before) && Object.values(first.before).every(Object.isFrozen));
  assert.equal(Object.isFrozen(input.source), false);
  assert.deepEqual(first, expressionOriginHistory(input, input));
  input.source.ir[0] = 'two';
  const changed = record(input, input);
  assert.deepEqual(first.before.ir, ['one']);
  assert.deepEqual(changed.before.ir, ['two']);
  assert.notEqual(changed.before, first.before);
  assert.notEqual(createExpressionOriginHistoryRecorder()(input, input).before, changed.before,
    'independent producers do not share a global pool');
});

test('C4-03 storage keys retain typed identities and fresh truncation flags', () => {
  const record = createExpressionOriginHistoryRecorder();
  const node = value => ({ source:{ ir:[value] } });
  assert.notEqual(record(node(1), node(1)).before, record(node('1'), node('1')).before);
  assert.notEqual(record(node(0), node(0)).before, record(node(-0), node(-0)).before);
  assert.notEqual(record({ source:{ ir:[1, 2] } }, {}).before, record({ source:{ ir:[2, 1] } }, {}).before);
  assert.notEqual(record(node('1,2'), {}).before, record({ source:{ ir:[1, 2] } }, {}).before);
  assert.notEqual(record({ source:{ addresses:[1n] } }, {}).before, record({ source:{ addresses:[1] } }, {}).before);
  const two = { source:{ ir:[1, 2] } }, one = node(1);
  const truncated = record(two, two, 1), complete = record(one, one);
  assert.equal(truncated.before, complete.before);
  assert.equal(truncated.truncated, true);
  assert.equal(complete.truncated, false);
  for (const cap of [0, 1, 2, 512]) assert.deepEqual(record(two, two, cap), expressionOriginHistory(two, two, cap));
  let reads = 0;
  const getter = { source:{ get ir() { reads++; return [reads]; } } };
  record(getter, getter);
  assert.equal(reads, 2, 'every source is normalized again, even when its object identity is unchanged');
});

test('C4-03 storage keys do not evaluate ambient JSON conversion hooks', () => {
  for (const prototype of [Array.prototype, Object.prototype]) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'toJSON');
    let calls = 0;
    try {
      Object.defineProperty(prototype, 'toJSON', { configurable:true, value:() => { calls++; return 'same'; } });
      const record = createExpressionOriginHistoryRecorder();
      const first = record({ source:{ ir:['first'] } }, {});
      const second = record({ source:{ ir:['second'] } }, {});
      assert.deepEqual(first.before.ir, ['first']);
      assert.deepEqual(second.before.ir, ['second']);
      assert.notEqual(first.before, second.before);
      assert.equal(calls, 0);
    } finally {
      if (descriptor) Object.defineProperty(prototype, 'toJSON', descriptor);
      else delete prototype.toJSON;
    }
  }
});

test('C4-03 history payload storage has bounded entries and volume, not an observation exemption', () => {
  for (const [count, width] of [[600, 1], [40, 256]]) {
    const record = createExpressionOriginHistoryRecorder();
    const node = index => ({ source:{ ir:Array.from({ length:width }, (_, item) => `${index}:${item}`) } });
    const input = node(0), first = record(input, input);
    for (let index = 1; index < count; index++) record(node(index), node(index));
    const later = record(input, input);
    assert.notEqual(first.before, later.before, `${count}/${width} evicts the old storage entry`);
    assert.deepEqual(first, later);
  }
  const record = createExpressionOriginHistoryRecorder();
  const long = { source:{ ir:['x'.repeat(PROJECTION_LIMITS.string + 1)] } };
  const history = record(long, long);
  assert.notEqual(history.before, history.after, 'oversized keys do not enter storage');
  assert.throws(() => captureProjectionIrData([history]), /string-budget/);
  const huge = record({ source:{ addresses:[1n << 1024n] } }, {});
  assert.throws(() => captureProjectionIrData([huge]), /bigint-budget/);
});

function graphFixture() {
  const values = Array.from({ length:200 }, (_, id) => ({ id }));
  const instructions = values.map((dst, index) => ({ dst, args:[{ value:values[(index + 1) % values.length] }] }));
  for (let index = 0; index < values.length; index++) values[index].def = instructions[index];
  return { values, instructions };
}

function producerGraphFixture() {
  const ir = graphFixture();
  for (const instruction of ir.instructions) instruction.block = 0;
  ir.blocks = [{ index:0, phis:[], insts:[...ir.instructions] }];
  ir.idom = [0];
  ir.dominators = [new Set([0])];
  const transitions = ir.instructions.map(source => ({ source, beforeInputs:[] }));
  return { ir, transitions };
}

test('C4-03 operation and recovery producers observe cyclic SSA roots without reusing stale captures', () => {
  for (const capture of [
    ({ ir, transitions }) => observeProjectedOperationData(ir, transitions),
    ({ ir }) => { const observation = captureRecoveryIrData(ir, []); return () => observation.matches(); },
  ]) for (const mutate of [
    ir => { ir.values = [...ir.values]; },
    ir => { ir.values[170] = { ...ir.values[170] }; },
    ir => { ir.instructions[180] = { ...ir.instructions[180] }; },
    ir => { ir.blocks[0].insts = [...ir.blocks[0].insts]; },
    ir => { ir.instructions[190].args[0].value.id++; },
    ir => { Object.setPrototypeOf(ir.values[150], null); },
    ir => { Object.defineProperty(ir.values[150], 'id', { get:() => 150 }); },
  ]) {
    const fixture = producerGraphFixture(), matches = capture(fixture);
    assert.equal(matches(), true);
    mutate(fixture.ir);
    assert.equal(matches(), false);
  }
});

test('C4-03 graph operation matching observes only selected roots and never authorizes caller writes', () => {
  const { ir, transitions } = producerGraphFixture();
  const matches = observeProjectedOperationData(ir, transitions);
  const object = ir.instructions[175].args[0], before = object.value, after = ir.values[2];
  object.value = after;
  const writes = [{ object, key:'value', before, after }];
  assert.equal(matches(writes), false);
  assert.equal(matches.matchesThroughWrites(writes), true);
  assert.equal(observeProjectedOperationData(ir, transitions)(), true);
  assert.equal(matches(), false, 'a fresh capture cannot refresh the predecessor');
  object.extra = 1;
  assert.equal(matches.matchesThroughWrites(writes), false);
  const selected = producerGraphFixture();
  assert.throws(() => observeProjectedOperationData(selected.ir, [selected.transitions[0]]), /depth/,
    'unselected canonical members do not become roots to bypass depth');
});

test('C4-03 recovery and operation graph producers retain nested-data and volume limits', () => {
  const cases = [
    [() => { let value = {}; for (let i = 0; i <= PROJECTION_LIMITS.depth; i++) value = { child:value }; return value; }, /depth/],
    [() => Array.from({ length:PROJECTION_LIMITS.nodes }, () => ({})), /node-budget/],
    [() => Array(PROJECTION_LIMITS.edges + 1).fill(0), /entry-budget/],
    [() => 'x'.repeat(PROJECTION_LIMITS.string + 1), /string-budget/],
    [() => 1n << 1024n, /bigint-budget/],
    [() => new Map(), /prototype/],
    [() => Array(1), /sparse/],
  ];
  for (const [value, error] of cases) for (const capture of [
    ({ ir, transitions }) => observeProjectedOperationData(ir, transitions),
    ({ ir }) => captureRecoveryIrData(ir, []),
  ]) {
    const fixture = producerGraphFixture();
    fixture.ir.values[170].metadata = value();
    assert.throws(() => capture(fixture), error);
  }
  const { ir } = producerGraphFixture();
  assert.throws(() => captureRecoveryIrData(ir, [], () => true), /cancelled/);
  const extra = { value:1 }, observation = captureRecoveryIrData(ir, [extra]);
  extra.value = 2;
  assert.equal(observation.matches(), false, 'additional caller roots remain observed');
});

test('C4-03 complete SSA graphs are observed by root distance, including every cyclic edge', () => {
  for (const reverse of [false, true]) {
    const { values, instructions } = graphFixture();
    if (reverse) { values.reverse(); instructions.reverse(); }
    const observer = createProjectionIrObserver();
    assert.throws(() => observer.capture([values, instructions]), /depth/);
    const observation = observer.captureGraph([values, instructions]);
    assert.equal(observation.matches(), true);
    assert.equal(observation.metrics.nodes, 802);
    assert.equal(observation.metrics.edges, 1600);
    const target = instructions[175].args[0], before = target.value;
    target.value = values[2];
    assert.equal(observation.matches(), false);
    assert.equal(observation.matchesThroughWrites([{ object:target, key:'value', before, after:values[2] }]), true);
    target.extra = 'unobserved writer';
    assert.equal(observation.matchesThroughWrites([{ object:target, key:'value', before, after:values[2] }]), false);
  }
});

test('C4-03 graph traversal retains root slots, descriptors, prototypes and array lengths', () => {
  for (const mutate of [
    ({ values }) => { values[170] = { ...values[170] }; },
    ({ instructions }) => { instructions.pop(); },
    ({ instructions }) => { instructions[190].args[0].value.id++; },
    ({ values }) => { Object.setPrototypeOf(values[150], null); },
    ({ values }) => { Object.defineProperty(values[150], 'id', { get:() => 150 }); },
  ]) {
    const fixture = graphFixture();
    const observation = createProjectionIrObserver().captureGraph([fixture.values, fixture.instructions]);
    mutate(fixture);
    assert.equal(observation.matches(), false);
  }
});

test('C4-03 graph traversal preserves nested depth, total volume and plain-data limits', () => {
  const capture = value => createProjectionIrObserver().captureGraph([value]);
  let deep = { value:1 };
  for (let index = 1; index < PROJECTION_LIMITS.depth; index++) deep = { child:deep };
  assert.equal(capture(deep).matches(), true);
  assert.throws(() => capture({ child:deep }), /depth/);
  assert.throws(() => capture(Array.from({ length:PROJECTION_LIMITS.nodes }, () => ({}))), /node-budget/);
  assert.throws(() => capture(Array(PROJECTION_LIMITS.edges + 1).fill(0)), /entry-budget/);
  assert.throws(() => capture('a'.repeat(PROJECTION_LIMITS.string + 1)), /string-budget/);
  assert.throws(() => capture({ ['a'.repeat(PROJECTION_LIMITS.string + 1)]:1 }), /key-budget/);
  assert.throws(() => capture(Array(50).fill('a'.repeat(50000))), /expansion-budget/);
  assert.throws(() => capture(1n << 1024n), /bigint-budget/);
  assert.throws(() => capture(new Map()), /prototype/);
  assert.throws(() => capture(Array(1)), /sparse/);
  assert.throws(() => capture({ [Symbol('key')]:1 }), /symbol/);
  assert.throws(() => capture({ method() {} }), /non-data/);
  let called = false;
  assert.throws(() => capture({ get field() { called = true; return 1; } }), /accessor/);
  assert.equal(called, false);
  assert.throws(() => createProjectionIrObserver().captureGraph([{}], () => true), /cancelled/);
});

test('C4-03 graph and nested captures charge the same fully observed data', () => {
  const shared = { id:42, attributes:[1, 2, 'name'] }, roots = [{ shared }, { shared }];
  assert.deepEqual(createProjectionIrObserver().captureGraph(roots).metrics, captureProjectionIrData(roots).metrics);
});

test('C4-03 graph warming retains the ordinary immutable height and mutable-cycle checks', () => {
  const observer = createProjectionIrObserver(), roots = [];
  let deep = Object.freeze({ value:1 });
  for (let index = 0; index < 150; index++) { roots.push(deep); deep = Object.freeze({ child:deep }); }
  roots.push(deep);
  const first = observer.captureGraph(roots), second = observer.captureGraph(roots);
  assert.deepEqual(first.metrics, second.metrics, 'graph captures do not skip cached subtrees');
  assert.throws(() => observer.capture([deep]), /depth/);
  assert.throws(() => observer.captureGraph([deep]), /depth/);
  const frozen = Object.freeze({ payload:Object.freeze([1, 2, 3]) });
  observer.captureGraph([frozen]);
  assert.equal(observer.capture([frozen]).metrics.edges, 0);
  for (const wrap of [child => Object.freeze({ child }), child => {
    const parent = { child }; child.parent = parent; return Object.freeze(parent);
  }]) {
    const child = { value:1 }, parent = wrap(child);
    const original = observer.captureGraph([parent]), current = observer.capture([parent]);
    assert.ok(current.metrics.edges > 0);
    child.value = 2;
    assert.equal(original.matches(), false);
    assert.equal(current.matches(), false);
  }
  const left = {}, right = { left }; left.right = right;
  Object.freeze(left); Object.freeze(right);
  observer.captureGraph([left]);
  assert.ok(observer.capture([left]).metrics.edges > 0, 'even a frozen cycle is not a cached tree');
});

function identityRecord(map) { return map.ledger.find(record => record.rule === 'add-zero-right' && record.valueId === 3); }

test('C4-03 one producer reuses only recursively immutable observations', () => {
  const observer = createProjectionIrObserver();
  const immutable = Object.freeze(Array.from({ length:80 }, (_, id) => Object.freeze({ id, source:Object.freeze([id]) })));
  const first = observer.capture([immutable]), second = observer.capture([immutable]);
  assert.ok(first.metrics.edges > 200);
  assert.equal(second.metrics.edges, 0, 'warm immutable data needs no repeated graph observation');
  assert.equal(second.matches(), true);
  assert.equal(createProjectionIrObserver().capture([immutable]).metrics.edges, first.metrics.edges,
    'observations are scoped to a producer, not a global cache');
  assert.equal(captureProjectionIrData([immutable]).metrics.edges, first.metrics.edges);
});

test('C4-03 a frozen envelope cannot exempt mutable children or cycles from live checks', () => {
  for (const wrap of [child => Object.freeze({ child }), child => Object.freeze([child]),
    child => { const root = { child }; child.back = root; return Object.freeze(root); }]) {
    const observer = createProjectionIrObserver(), child = { value:1 }, root = wrap(child);
    const first = observer.capture([root]), second = observer.capture([root]);
    assert.ok(second.metrics.edges > 0);
    assert.equal(first.matches(), true); assert.equal(second.matches(), true);
    child.value = 2;
    assert.equal(first.matches(), false); assert.equal(second.matches(), false);
  }
});

test('C4-03 warm immutable observations preserve depth, descriptor and cancellation boundaries', () => {
  const observer = createProjectionIrObserver();
  let deep = Object.freeze({ value:1 });
  for (let i = 0; i < 60; i++) deep = Object.freeze({ child:deep });
  observer.capture([deep]);
  let nested = deep;
  for (let i = 0; i < PROJECTION_LIMITS.depth - 60; i++) nested = { child:nested };
  assert.throws(() => observer.capture([nested]), /depth/);
  assert.throws(() => observer.capture([deep], () => true), /cancelled/);
  let invoked = false;
  const accessor = Object.freeze({ get value() { invoked = true; return 1; } });
  assert.throws(() => observer.capture([accessor]), /accessor/);
  assert.equal(invoked, false);
  assert.throws(() => observer.capture([Object.freeze(new Map())]), /prototype/);
});

test('C4-03 sharing never caches mutable descriptor checks across consumer reads', () => {
  const f = fixture();
  const semantic = f.enhanced.cAst.body[0].semantic;
  assert.ok(readExpressionHistoryConsumer(semantic, f.enhanced.ir));
  semantic.unobserved = 'new descriptor field';
  assert.equal(readExpressionHistoryConsumer(semantic, f.enhanced.ir), null);
});

test('C4-03 actual store and return consumers bind the same rewritten value, not an unrelated shared input', () => {
  const f = fixture();
  const result = applyPhase8Projection(f.enhanced, analysis());
  const map = result.renderProvenance, record = identityRecord(map);
  assert.equal(record.renderedBinding, 'producer-bound');
  assert.deepEqual(record.producedRefs, ['L0:stmt', 'L2:stmt']);
  assert.deepEqual(map.reverse[`addr:${f.add.address}`], ['L0:stmt', 'L2:stmt']);
  assert.deepEqual(map.entities['L1:stmt'].recordRefs, [], 'reading the same input does not consume the add rewrite');
  assert.equal(validateRenderProvenance(map).state, 'complete');
});

test('C4-03 consumer binding preserves the surviving load identity and source arrays', () => {
  const f = fixture({ load:true });
  const expression = f.enhanced.cAst.body[0].semantic.expression;
  assert.equal(expression.kind, 'load');
  const key = structuralKey(expression), source = structuredClone(expression.source);
  const result = applyPhase8Projection(f.enhanced, analysis());
  assert.equal(identityRecord(result.renderProvenance).renderedBinding, 'producer-bound');
  assert.equal(structuralKey(expression), key);
  assert.deepEqual(expression.source, source);
  assert.equal(structuralKey(result.cAst.body[0].semantic.expression), key);
});

test('C4-03 printed source spans retain only their producer-bound consumed histories', () => {
  const f = fixture({ load:true });
  const expression = f.enhanced.cAst.body[0].semantic.expression;
  const originalSource = structuredClone(expression.source);
  for (const result of [f.enhanced, applyPhase8Projection(f.enhanced, analysis())]) {
    const mapped = result.sourceMap.flatMap((entry, index) => entry.source.addresses.includes(f.add.address) ? [index] : []);
    assert.deepEqual(mapped, [0,2], 'an unrelated shared-input store is not a consumer of the removed add');
    assert.deepEqual(result.sourceMap.map(entry => [entry.outputStartLine, entry.outputEndLine]), [[1,1],[2,2],[3,3]]);
  }
  assert.deepEqual(expression.source, originalSource);
  const foreign = source(999, 900), raw = resultWith(expr.variable('foreign', 64, false, source(1)));
  raw.rewriteProof = [{ ...f.enhanced.rewriteProof[0], originHistory:{ before:foreign, after:foreign } }];
  const unbound = applyPhase8Projection(raw, analysis());
  assert.ok(Array.isArray(unbound.sourceMap));
  assert.equal(unbound.sourceMap.some(entry => entry.source.addresses.includes(foreign.addresses[0])), false,
    'copied metadata cannot create a source-map edge');
});

test('C4-03 query navigation reaches the real consumers of an elided operator origin', async () => {
  const f = fixture();
  const result = applyPhase8Projection(f.enhanced, analysis());
  let epoch = 1;
  const api = new AnalysisQueryAPI({
    currentIdentity:async () => ({ binaryId:'bound-expression', projectRevision:1, analysisEpoch:epoch, artifactVersions:{} }),
    decompile:async () => ({ value:result, status:{ completeness:'complete' } }),
  });
  const snapshot = await api.snapshot(), query = await api.decompile(snapshot, 'function');
  const navigation = createDecompilerNavigation(query, { currentSnapshot:() => api.snapshot() });
  const selected = await navigation.selectOrigin('addr', f.add.address);
  assert.equal(selected.state, 'ready');
  assert.deepEqual(selected.entities.map(entity => entity.lineIndex), [0, 2]);
  assert.equal(selected.transforms.find(record => record.rule === 'add-zero-right').renderedBinding, 'producer-bound');
  const opened = [];
  await navigation.openAddress(f.add.address, address => opened.push(address));
  assert.deepEqual(opened, [f.add.address]);
  epoch++;
  assert.equal((await navigation.selectOrigin('addr', f.add.address)).reason, 'stale-query-snapshot');
});

test('C4-03 replacement, in-place mutation, changed IR and altered records invalidate producer bindings', () => {
  for (const mutate of [
    f => { f.enhanced.cAst.body[0].semantic.expression = { ...f.enhanced.cAst.body[0].semantic.expression }; },
    f => { f.enhanced.cAst.body[0].semantic.expression.bits = 32; },
    f => { f.sum.def.args[1].value = f.input; },
    f => { f.enhanced.rewriteProof.find(record => record.rule === 'add-zero-right').rule = 'changed'; },
    f => { f.enhanced.ir = { ...f.ir }; },
  ]) {
    const f = fixture();
    assert.ok(readExpressionHistoryConsumer(f.enhanced.cAst.body[0].semantic, f.enhanced.ir));
    mutate(f);
    assert.equal(readExpressionHistoryConsumer(f.enhanced.cAst.body[0].semantic, f.enhanced.ir), null);
  }
});

test('C4-03 copying a producer descriptor or record does not copy binding authority', () => {
  for (const mode of ['descriptor', 'record']) {
    const f = fixture();
    if (mode === 'descriptor') {
      f.enhanced.cAst.body = f.enhanced.cAst.body.map(node => ({ ...node, semantic:{ ...node.semantic } }));
    } else f.enhanced.rewriteProof = f.enhanced.rewriteProof.map(record => ({ ...record }));
    const map = applyPhase8Projection(f.enhanced, analysis()).renderProvenance;
    assert.equal(identityRecord(map).renderedBinding, 'unresolved');
    assert.deepEqual(identityRecord(map).producedRefs, []);
  }
});

test('C4-03 a recovered/replaced consumer does not inherit the previous expression history', () => {
  const f = fixture();
  // Both values legitimately reduce to the same input object. A replacement
  // must actually change the expression, not assign that identical object.
  f.enhanced.cAst.body[0].semantic.expression = { ...f.enhanced.cAst.body[1].semantic.expression };
  const map = applyPhase8Projection(f.enhanced, analysis()).renderProvenance;
  assert.deepEqual(identityRecord(map).producedRefs, ['L2:stmt']);
});

test('C4-03 copied or edited rendered lines cannot replay a producer binding', () => {
  for (const mode of ['copy', 'edit']) {
    const f = fixture();
    const projected = applyPhase8Projection(f.enhanced, analysis());
    if (mode === 'copy') projected.lines = projected.lines.map(line => ({ ...line }));
    else projected.lines[0].text = 'unrelated();';
    const map = buildRenderProvenance({ result:projected, snapshotId:projected.renderProvenance.snapshotId });
    assert.deepEqual(identityRecord(map).producedRefs, mode === 'copy' ? [] : ['L2:stmt']);
  }
});

test('C4-03 a late IR mutation invalidates the map instead of publishing stale bound edges', () => {
  const f = fixture();
  const projected = applyPhase8Projection(f.enhanced, analysis());
  let checks = 0;
  const map = buildRenderProvenance({ result:projected, snapshotId:projected.renderProvenance.snapshotId,
    shouldAbort:() => { if (++checks === 5) f.sum.def.sub = 'sub'; return false; } });
  assert.equal(map.completeness, 'incomplete');
  assert.ok(map.reasons.includes('stale-expression-binding'));
});

test('C4-03 validator rejects a bound record whose actual consumer back-reference is missing', () => {
  const map = structuredClone(applyPhase8Projection(fixture().enhanced, analysis()).renderProvenance);
  assert.equal(validateRenderProvenance(map).state, 'complete');
  map.entities['L0:stmt'].recordRefs = [];
  assert.equal(validateRenderProvenance(map).state, 'incomplete');
});

test('C4-03 direct-value branch conditions carry the actual nested expression consumer', () => {
  const f = fixture({ branch:true });
  const map = applyPhase8Projection(f.enhanced, analysis()).renderProvenance;
  assert.deepEqual(identityRecord(map).producedRefs, ['L0:stmt', 'L2:ctrl', 'L3:stmt']);
  assert.deepEqual(map.entities['L4:stmt'].recordRefs, [], 'the other branch returns the shared input without consuming the add');
});

test('C4-03 already-correct condition text binds, but malformed or ambiguous replacements do not', () => {
  for (const mode of ['same-text', 'malformed', 'ambiguous']) {
    const f = fixture({ branch:true });
    if (mode === 'same-text') {
      f.enhanced.cAst.body[2].text = `if (${f.enhanced.semanticAst.conditions[0].text}) goto loc_taken;`;
    } else if (mode === 'malformed') f.enhanced.cAst.body[2].text = 'if (missing closing parenthesis';
    else f.enhanced.semanticAst.conditions.push({ ...f.enhanced.semanticAst.conditions[0] });
    const map = applyPhase8Projection(f.enhanced, analysis()).renderProvenance;
    assert.equal(identityRecord(map).producedRefs.includes('L2:ctrl'), mode === 'same-text', mode);
  }
});

test('C4-03 bound consumer origins retain the existing truncation and cancellation boundary', () => {
  const limited = applyPhase8Projection(fixture().enhanced, analysis(), { renderProvenanceBudget:{ maxOriginsPerEntity:2 } });
  assert.equal(identityRecord(limited.renderProvenance).renderedBinding, 'producer-bound');
  assert.equal(limited.renderProvenance.completeness, 'incomplete');
  assert.equal(validateRenderProvenance(limited.renderProvenance).state, 'incomplete');
  const cancelled = applyPhase8Projection(fixture().enhanced, analysis(), { shouldAbort:() => true });
  assert.deepEqual(cancelled.renderProvenance.reasons, ['cancelled']);
  assert.deepEqual(cancelled.renderProvenance.ledger, []);
});

test('C4-03 cumulative binding budgets stop new observations without changing decompilation', () => {
  const normal = fixture();
  for (const [bindingBudget, expected] of [
    [{ maxConsumers:1 }, ['L0:stmt']],
    [{ maxEdges:0 }, []],
    [{ maxEdges:1 }, []],
  ]) {
    const f = fixture({ bindingBudget });
    assert.equal(f.enhanced.pseudocode, normal.enhanced.pseudocode);
    assert.equal(f.enhanced.expressionHistoryBinding.completeness, 'incomplete');
    assert.ok(f.enhanced.expressionHistoryBinding.reasons.includes('binding-budget'));
    const map = applyPhase8Projection(f.enhanced, analysis()).renderProvenance;
    assert.deepEqual(identityRecord(map).producedRefs, expected);
    assert.equal(identityRecord(map).renderedBinding, expected.length ? 'producer-bound' : 'unresolved');
    assert.equal(map.completeness, 'incomplete');
    assert.ok(map.reasons.includes('incomplete-expression-binding'));
  }
});

test('C4-03 successive owned projections retain store, return and branch history without accumulating records', () => {
  const f = fixture({ branch:true });
  let result = f.enhanced;
  let originalText, originalCount;
  for (let generation = 0; generation < 12; generation++) {
    result = applyPhase8Projection(result, analysis());
    assert.equal(result.phase8Projection.history.completeness, 'complete');
    assert.equal(result.renderProvenance.completeness, 'complete');
    assert.deepEqual(identityRecord(result.renderProvenance).producedRefs, ['L0:stmt', 'L2:ctrl', 'L3:stmt']);
    originalText ??= result.pseudocode;
    originalCount ??= result.renderProvenance.ledger.length;
    assert.equal(result.pseudocode, originalText);
    assert.equal(result.renderProvenance.ledger.length, originalCount);
  }
});

test('C4-03 no-op re-projection retains actual earlier view transforms and their reverse map', () => {
  const value = expr.variable('a1', 64, true, source(1, 1));
  const expression = expr.unary('trunc', expr.unary('trunc', value, 32, false, source(2, 2)), 8, false, source(3, 3));
  let result = applyPhase8Projection(resultWith(expression), analysis());
  assert.equal(result.phase8Projection.transforms.length, 1);
  const record = result.phase8Projection.transforms[0];
  const reverse = result.renderProvenance.reverse;
  for (let generation = 0; generation < 8; generation++) {
    result = applyPhase8Projection(result, analysis());
    assert.equal(result.phase8Projection.transforms.length, 0, 'old transforms must not be counted as newly applied');
    assert.equal(result.phase8Projection.history.transforms.length, 1);
    assert.equal(result.phase8Projection.history.transforms[0], record, 'retain the actual record, not a guessed equivalent');
    assert.equal(result.renderProvenance.ledger.length, 1);
    assert.deepEqual(result.renderProvenance.reverse, reverse);
  }
});

test('C4-03 ordinary result envelopes preserve the exact owned AST transition', () => {
  let result = applyPhase8Projection(fixture({ branch:true }).enhanced, analysis());
  result = applyPhase8Projection({ ...result, ctx:{ ...result.ctx, wrapper:'phase-envelope' } }, analysis());
  assert.equal(result.phase8Projection.history.completeness, 'complete');
  assert.deepEqual(identityRecord(result.renderProvenance).producedRefs, ['L0:stmt', 'L2:ctrl', 'L3:stmt']);
});

test('C4-03 re-projection refuses altered or copied transition data, even when expressions look equal', () => {
  for (const mutate of [
    result => { result.cAst = { ...result.cAst }; },
    result => { result.cAst.body = [...result.cAst.body]; },
    result => { result.cAst.body[0].semantic.expression = { ...result.cAst.body[0].semantic.expression }; },
    result => { result.semanticAst.conditions[0].row++; },
    result => { result.rewriteProof = result.rewriteProof.map(record => ({ ...record })); },
    result => { result.phase8Projection = { ...result.phase8Projection }; },
    result => { result.expressionHistoryBinding = { ...result.expressionHistoryBinding }; },
    result => { result.ir = { ...result.ir }; },
  ]) {
    let result = applyPhase8Projection(fixture({ branch:true }).enhanced, analysis());
    mutate(result);
    result = applyPhase8Projection(result, analysis());
    assert.equal(result.phase8Projection.history.completeness, 'incomplete');
    assert.equal(result.renderProvenance.completeness, 'incomplete');
    assert.equal(identityRecord(result.renderProvenance).renderedBinding, 'unresolved');
  }
});

test('C4-03 projection retention caps and cancellation cannot become complete on a later no-op', () => {
  let result = applyPhase8Projection(fixture({ branch:true }).enhanced, analysis(), { renderProvenanceBindingBudget:{ maxEdges:1 } });
  assert.ok(result.phase8Projection.history.reasons.includes('projection-history-budget'));
  assert.equal(result.renderProvenance.completeness, 'incomplete');
  result = applyPhase8Projection(result, analysis());
  assert.equal(result.renderProvenance.completeness, 'incomplete');
  const valid = applyPhase8Projection(fixture({ branch:true }).enhanced, analysis());
  const cancelled = applyPhase8Projection(valid, analysis(), { shouldAbort:() => true });
  assert.deepEqual(cancelled.renderProvenance.reasons, ['cancelled']);
  assert.deepEqual(cancelled.renderProvenance.ledger, []);
});

test('C4-03 repeated projection leaves the original surviving load and canonical IR unchanged', () => {
  const f = fixture({ load:true, branch:true });
  const original = f.enhanced.cAst.body[0].semantic.expression;
  const key = structuralKey(original), originalSource = structuredClone(original.source);
  let result = f.enhanced;
  for (let generation = 0; generation < 6; generation++) result = applyPhase8Projection(result, analysis());
  assert.equal(result.ir, f.ir);
  assert.equal(f.sum.def.sub, 'add');
  assert.equal(structuralKey(original), key);
  assert.deepEqual(original.source, originalSource);
  assert.equal(identityRecord(result.renderProvenance).renderedBinding, 'producer-bound');
});

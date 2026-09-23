import assert from 'node:assert/strict';
import test from 'node:test';
import { PassManager } from '../../../js/decompiler/passes/manager.js';

test('optional passes preserve canonical roots and private producer identities across success', () => {
  const instruction = { id:1 }, ir = { instructions:[instruction] };
  const producers = new WeakMap();
  const state = { ir, opts:{ deterministicTransforms:true }, memo:new Map([[instruction, 'canonical']]) };
  new PassManager([
    { name:'producer', run(s) {
      assert.equal(s.ir, ir);
      s.expression = { kind:'var', instruction };
      producers.set(s.expression, instruction);
    } },
    { name:'consumer', run(s) {
      assert.equal(s.ir.instructions[0], instruction);
      assert.equal(s.memo.get(instruction), 'canonical');
      assert.equal(producers.get(s.expression), instruction);
      s.bound = true;
    } },
  ]).run(state);
  assert.equal(state.bound, true);
  assert.ok(state.passMetrics.every(row => row.ok));
  assert.equal(state.ir, ir);
  assert.equal(producers.get(state.expression), instruction);
});

test('failed optional passes restore aliases, cycles, descriptors and collection keys in place', () => {
  const key = { value:1 }, symbol = Symbol('retained');
  const root = Object.assign(Object.create(null), { key });
  root.self = root;
  Object.defineProperty(root, symbol, { value:key, configurable:true });
  let getterReads = 0;
  Object.defineProperty(root, 'getter', { get() { getterReads++; return key; }, configurable:true });
  const rows = [key, , root], map = new Map([[key, root]]), set = new Set([key]);
  const date = new Date(123), regexp = /x/g; regexp.lastIndex = 2;
  const state = { root, rows, map, set, date, regexp, opts:{ deterministicTransforms:true } };
  new PassManager([{ name:'broken', run(s) {
    s.root.key.value = 2; delete s.root[symbol]; delete s.root.getter;
    s.root.added = true; s.rows.length = 0;
    s.map.clear(); s.set.clear(); s.date.setTime(999); s.regexp.lastIndex = 9;
    s.root = {}; throw new Error('rollback');
  } }]).run(state);
  assert.equal(state.root, root);
  assert.equal(root.self, root);
  assert.equal(Object.getPrototypeOf(root), null);
  assert.equal(root[symbol], key);
  assert.equal(key.value, 1);
  assert.equal('added' in root, false);
  assert.equal(state.rows, rows);
  assert.equal(rows.length, 3);
  assert.equal(1 in rows, false);
  assert.equal(rows[2], root);
  assert.equal(map.get(key), root);
  assert.equal(set.has(key), true);
  assert.equal(date.getTime(), 123);
  assert.equal(regexp.lastIndex, 2);
  assert.equal(getterReads, 0);
  assert.equal(state.passMetrics[0].ok, false);
});

test('an irreversible optional mutation fails closed before finalization', () => {
  let finalized = false;
  const manager = new PassManager([
    { name:'irreversible', run(s) {
      Object.defineProperty(s.root, 'unrecoverable', { value:true, configurable:false });
      throw new Error('cannot restore');
    } },
    { name:'finalizer', required:true, run() { finalized = true; } },
  ]);
  assert.throws(() => manager.run({ root:{}, opts:{ deterministicTransforms:true } }), /optional-pass-rollback-failed/);
  assert.equal(finalized, false);
});

test('a returned state delta preserves unchanged roots and frozen observations', () => {
  const root = Object.freeze({ id:1 });
  const state = { root, opts:{ deterministicTransforms:true } };
  new PassManager([
    { name:'delta', run(s) { assert.equal(s.root, root); return { result:root }; } },
    { name:'failed', run(s) { s.result = null; throw new Error('restore frozen root'); } },
  ]).run(state);
  assert.equal(state.root, root);
  assert.equal(state.result, root);
  assert.deepEqual(state.passMetrics.map(row => row.ok), [true, false]);
});

test('failed optional passes restore plain array and object fast paths faithfully', () => {
  const arr = [10, 20, 30];
  const obj = { a: 1, b: 2 };
  const state = { arr, obj, opts: { deterministicTransforms: true } };
  new PassManager([{
    name: 'mutate-plain-records',
    run(s) {
      s.arr.push(40);
      s.arr[0] = 999;
      s.obj.a = 888;
      s.obj.c = 3;
      delete s.obj.b;
      throw new Error('rollback');
    },
  }]).run(state);
  assert.equal(state.arr, arr);
  assert.equal(state.arr.length, 3);
  assert.deepEqual(state.arr, [10, 20, 30]);
  assert.equal(state.obj, obj);
  assert.deepEqual(state.obj, { a: 1, b: 2 });
  assert.equal(state.passMetrics[0].ok, false);
});

test('native consumer history shares one live input observation within each read', async () => {
  const [{ loadCorpus }, { decompileEntry }, { readLineExpressionHistory }] = await Promise.all([
    import('../../../tools/validation/phase8/build-corpus.mjs'),
    import('../../../tools/validation/phase8/decompile-corpus.mjs'),
    import('../../../js/decompiler/phase8/projection.js'),
  ]);
  const corpus = loadCorpus(), index = corpus.functions.findIndex(entry => entry.id === 'quality.loop_decrement_step.O1');
  assert.ok(index >= 0);
  const { result, failure } = decompileEntry(corpus.functions[index], { index, deterministicTransforms:true });
  assert.equal(failure, undefined);
  assert.equal(result.renderProvenance.completeness, 'complete');
  const candidate = result.lines.map(line => ({ line, records:readLineExpressionHistory(line, result.ir) }))
    .filter(item => item.records?.length).sort((left, right) => right.records.length - left.records.length)[0];
  assert.ok(candidate.records.length > 250, 'exercise the frozen native loop with its full history');
  const descriptor = Object.getOwnPropertyDescriptor;
  let reads = 0;
  try {
    Object.getOwnPropertyDescriptor = (object, key) => { reads++; return descriptor(object, key); };
    assert.deepEqual(readLineExpressionHistory(candidate.line, result.ir), candidate.records);
  } finally { Object.getOwnPropertyDescriptor = descriptor; }
  // Count work, not wall time. The pre-fix native read performs over a million
  // descriptor probes by rechecking the same whole IR for each selection.
  assert.ok(reads < 300000, `repeated native input observations: ${reads}`);
  assert.equal(readLineExpressionHistory({ ...candidate.line }, result.ir), null);
  const input = result.ir.values[0], originalId = input.id;
  let kindReads = 0, changed = false;
  try {
    Object.getOwnPropertyDescriptor = (object, key) => {
      const data = descriptor(object, key);
      if (object === input && key === 'kind' && ++kindReads === 2) {
        input.id = 'changed-during-live-observation'; changed = true;
      }
      return data;
    };
    assert.equal(readLineExpressionHistory(candidate.line, result.ir), null);
  } finally { Object.getOwnPropertyDescriptor = descriptor; input.id = originalId; }
  assert.equal(changed, true, 'mutation occurs after the first live input observation');
  assert.deepEqual(readLineExpressionHistory(candidate.line, result.ir), candidate.records);
  result.ir.values = [...result.ir.values];
  assert.equal(readLineExpressionHistory(candidate.line, result.ir), null, 'no truth cache survives the read');
});

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

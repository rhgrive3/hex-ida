import test from 'node:test';
import assert from 'node:assert/strict';
import { PassManager as Current } from '../../js/decompiler/passes/manager.js';
import { PassManager as Baseline } from '../helpers/mobile-final-baseline/js/decompiler/passes/manager.js';

const callback = () => 'shared live callback';
class Adapter { constructor() { this.id = 'adapter'; } }
// Linear-time graph spelling avoids deep-equality revisiting cycles through
// object-valued Map keys; alias topology remains part of the comparison.
function spelling(root) {
  const seen = new Map(), records = [];
  function visit(value) {
    if (value === null) return ['null'];
    if (typeof value !== 'object') {
      if (typeof value === 'number') return ['number', Object.is(value, -0) ? '-0' : String(value)];
      if (typeof value === 'function') return ['function', value.name];
      return [typeof value, String(value)];
    }
    if (seen.has(value)) return ['ref', seen.get(value)];
    const id = records.length; seen.set(value, id); records.push(null);
    let record;
    if (value instanceof Map) record = ['Map', [...value].map(([k, v]) => [visit(k), visit(v)])];
    else if (value instanceof Set) record = ['Set', [...value].map(visit)];
    else if (value instanceof Date) record = ['Date', value.getTime()];
    else if (value instanceof RegExp) record = ['RegExp', value.source, value.flags, value.lastIndex];
    else record = [Array.isArray(value) ? 'Array' : Object.getPrototypeOf(value)?.constructor?.name ?? 'null-prototype',
      Array.isArray(value) ? value.length : null, Object.keys(value).map(k => [k, visit(value[k])])];
    records[id] = record;
    return ['ref', id];
  }
  const reference = visit(root);
  return JSON.stringify({ root: reference, records });
}
function comparable(state) {
  delete state.passElapsedMs;
  delete state.passDeadlineExceeded;
  state.passMetrics = state.passMetrics.map(({ elapsedMs: _elapsedMs, ...record }) => record);
  return state;
}
function execute(Manager, payload, mutate = () => {}, fail = false) {
  const initial = { payload, opts: { deterministicTransforms: true } };
  const manager = new Manager([
    { name: 'optional', run(state) { mutate(state.payload); if (fail) throw new Error('rollback'); } },
    { name: 'final', required: true, run(state) { state.finished = true; } },
  ], { timeBudgetMs: 100000 });
  return { state: comparable(manager.run(initial)), original: payload };
}

test('mobile final: primitive-rich forks preserve every value, aliases and cycles', () => {
  function build() {
    const shared = { id: 1, value: -0, callback };
    const payload = { shared, again: shared, rows: Array.from({ length: 20000 }, (_, i) => i % 3 ? i : `v${i}`),
      values: [null, undefined, true, false, NaN, Infinity, -Infinity, -0, 1n, callback],
      date: new Date(123), regexp: /a+/gi, adapter: new Adapter() };
    payload.map = new Map([[shared, payload], ['id', 17n], [1n, shared]]);
    payload.set = new Set([shared, null, 17n]);
    payload.self = payload;
    return payload;
  }
  const actual = execute(Current, build()), expected = execute(Baseline, build());
  assert.equal(spelling(actual.state), spelling(expected.state));
  assert.notEqual(actual.state.payload, actual.original);
  assert.equal(actual.state.payload.self, actual.state.payload);
  assert.equal(actual.state.payload.shared, actual.state.payload.again);
  assert.equal(actual.state.payload.map.get(actual.state.payload.shared), actual.state.payload);
  assert.equal(actual.state.payload.adapter, actual.original.adapter);
  assert.equal(actual.state.payload.values.at(-1), callback);
  assert.ok(Object.is(actual.state.payload.shared.value, -0));
});

test('mobile final: failed optional passes cannot mutate original nested containers', () => {
  function build() { const item = { x: 1 }; return { item, rows: [item], map: new Map([['x', item]]), set: new Set([item]),
    date: new Date(123), regexp: /a/gi }; }
  const mutate = p => { p.item.x = 99; p.rows.push('wrong'); p.map.set('new', 99); p.set.clear(); p.date.setTime(99); p.regexp.lastIndex = 99; };
  const actual = execute(Current, build(), mutate, true), expected = execute(Baseline, build(), mutate, true);
  assert.equal(spelling(actual.state), spelling(expected.state));
  assert.equal(actual.state.payload, actual.original);
  assert.equal(actual.original.item.x, 1);
  assert.equal(actual.original.date.getTime(), 123);
  assert.equal(actual.original.rows.length, 1);
});

test('mobile final: sparse arrays, getters and null prototypes keep original traversal semantics', () => {
  function run(Manager) {
    const reads = [], child = Object.create(null);
    Object.defineProperty(child, 'x', { enumerable: true, get() { reads.push('child.x'); return 12; } });
    const rows = new Array(4); rows[1] = child; rows.extra = 'ignored by historical array fork';
    const payload = { rows };
    Object.defineProperty(payload, 'late', { enumerable: true, get() { reads.push('late'); return child; } });
    Object.defineProperty(payload, 'hidden', { value: 'not copied' });
    payload[Symbol('hidden')] = 1;
    return { result: execute(Manager, payload).state, reads };
  }
  const actual = run(Current), expected = run(Baseline);
  assert.deepEqual(actual, expected);
  assert.deepEqual(actual.reads, ['child.x', 'late']);
  assert.ok(Object.hasOwn(actual.result.payload.rows, 0));
  assert.equal(actual.result.payload.rows.extra, undefined);
});

test('mobile final: frozen sources still yield independent mutable pass-local copies', () => {
  const create = () => Object.freeze({ nested: Object.freeze({ x: 1 }), rows: Object.freeze([1, 2, 3]) });
  const mutate = p => { p.nested.x = 2; p.rows.push(4); };
  const actual = execute(Current, create(), mutate), expected = execute(Baseline, create(), mutate);
  assert.equal(spelling(actual.state), spelling(expected.state));
  assert.equal(actual.original.nested.x, 1);
  assert.equal(actual.original.rows.length, 3);
  assert.equal(actual.state.payload.nested.x, 2);
  assert.equal(Object.isFrozen(actual.state.payload.rows), false);
});

test('mobile final: randomized cyclic forks agree with the exact current-main reference', () => {
  for (let trial = 1; trial <= 80; trial++) {
    function build() {
      let seed = trial;
      const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
      const nodes = Array.from({ length: 32 }, (_, i) => ({ id: i, value: next(), callback }));
      for (const node of nodes) {
        node.next = nodes[next() % nodes.length];
        node.rows = [next(), nodes[next() % nodes.length], null, BigInt(next())];
        node.map = new Map([[node.id, nodes[next() % nodes.length]]]);
      }
      return { nodes };
    }
    const mutate = p => { p.nodes[0].value = 42; p.nodes[2].map.set('new', p.nodes[4]); };
    assert.equal(spelling(execute(Current, build(), mutate, trial % 2 === 0).state),
      spelling(execute(Baseline, build(), mutate, trial % 2 === 0).state), `trial ${trial}`);
  }
});


test('mobile final: Map set lookup precedes recursive argument visits', () => {
  function run(Manager) {
    const nativeSet = Map.prototype.set, calls = [];
    const entry = {};
    Object.defineProperty(entry, 'value', { enumerable: true, get() {
      Map.prototype.set = function (key, value) {
        calls.push(String(key));
        return nativeSet.call(this, key, value);
      };
      return 7;
    } });
    const payload = new Map([['key', entry]]);
    try {
      const result = execute(Manager, payload);
      return { spelling: spelling(result.state), calls };
    } finally { Map.prototype.set = nativeSet; }
  }
  assert.deepEqual(run(Current), run(Baseline));
});

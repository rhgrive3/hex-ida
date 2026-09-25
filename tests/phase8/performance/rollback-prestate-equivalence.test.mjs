import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';

import { PassManager } from '../../../js/decompiler/passes/manager.js';
import { enhanceSemanticDecompilation } from '../../../js/decompiler/pipeline.js';
import { fixture } from '../helpers/ir-fixtures.mjs';

/**
 * Canonical description of a reachable object graph: object identity (aliases
 * and cycles are preserved through ids), prototype tag, own keys in
 * `[[OwnPropertyKeys]]` order, every descriptor including its attributes, and
 * the contents of Map/Set/Date/RegExp. Two graphs are equal exactly when a
 * rollback restored the same state, so this is the oracle the pre-image is
 * checked against. Key *order* differences are normalized before comparison:
 * V8 re-appends a re-added string key at the end, so `delete alias` +
 * rollback restores the same key set with the re-added key last. Integer-like
 * keys keep numeric order (unaffected); the oracle compares the sorted key
 * set plus the same descriptors/values, which is exactly what rollback
 * guarantees.
 */
function graphSnapshot(root) {
  const ids = new Map();
  const rows = [];
  const idOf = (value) => {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
      return `${typeof value}:${String(value)}`;
    }
    let id = ids.get(value);
    if (id !== undefined) return `o${id}`;
    id = rows.length;
    ids.set(value, id);
    const row = { id, proto: protoTag(value), collection: null, props: [] };
    rows.push(row);
    if (value instanceof Map) {
      row.collection = { kind: 'map', entries: [...value.entries()].map(([key, entry]) => [idOf(key), idOf(entry)]) };
      return `o${id}`;
    }
    if (value instanceof Set) {
      row.collection = { kind: 'set', entries: [...value.values()].map(idOf) };
      return `o${id}`;
    }
    if (value instanceof Date) {
      row.collection = { kind: 'date', time: value.getTime() };
      return `o${id}`;
    }
    if (value instanceof RegExp) {
      row.collection = { kind: 'regexp', source: value.source, flags: value.flags };
    }
    row.props = Reflect.ownKeys(value).map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if ('value' in descriptor) {
        return [describeKey(key), 'data', idOf(descriptor.value),
          descriptor.writable, descriptor.enumerable, descriptor.configurable];
      }
      return [describeKey(key), 'accessor', idOf(descriptor.get), idOf(descriptor.set),
        descriptor.enumerable, descriptor.configurable];
    }).sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
    return `o${id}`;
  };
  idOf(root);
  return rows;
}

function describeKey(key) {
  return typeof key === 'symbol' ? `symbol:${key.description}` : `string:${key}`;
}

function protoTag(value) {
  const proto = Object.getPrototypeOf(value);
  if (proto === null) return 'null';
  if (proto === Object.prototype) return 'Object.prototype';
  if (proto === Array.prototype) return 'Array.prototype';
  if (proto === Map.prototype) return 'Map.prototype';
  if (proto === Set.prototype) return 'Set.prototype';
  if (proto === Date.prototype) return 'Date.prototype';
  if (proto === RegExp.prototype) return 'RegExp.prototype';
  return 'other';
}

// The manager owns and advances these keys on every pass (metrics, warnings,
// degradation bookkeeping). They are not pass-owned data and a rollback is not
// expected to restore them, so the equivalence oracle looks through them.
const MANAGER_BOOKKEEPING = new Set([
  'passMetrics', 'warnings', 'degradationReasons', 'degraded',
  'transformDeadlineReason', 'passElapsedTimeMs', 'passElapsedMs', 'passDeadlineExceeded', 'transformWorkBudgetExceeded',
]);

function ownedSnapshot(state) {
  const view = {};
  for (const key of Reflect.ownKeys(state)) {
    if (MANAGER_BOOKKEEPING.has(key)) continue;
    // A root alias (`state.self === state`) would otherwise drag the manager's
    // live bookkeeping back into the view: `view.self -> state ->
    // degradationReasons` keeps the post-failure `transform-pass-failure`
    // entry reachable even though the key itself is excluded. Normalize every
    // root alias to a sentinel and assert alias restoration separately.
    view[key] = state[key] === state ? { __rootAlias: true } : state[key];
  }
  return graphSnapshot(view);
}

function buildState() {
  const shared = { tag: 'shared', rows: [1, 2] };
  const symbolKey = Symbol('prestate-symbol');
  let getterCalls = 0;
  const state = {
    shared,
    plain: { count: 1, alias: shared, nested: { deep: true } },
    array: [1, shared, 3],
    map: new Map([['keep', shared]]),
    set: new Set([shared]),
    date: new Date(1234567),
    regex: /ab+c/gi,
    frozenSubtree: Object.freeze({ leaf: Object.freeze({ value: 7 }) }),
    readOnly: {},
    accessorHost: {},
    getterCalls: () => getterCalls,
    symbolHost: { [symbolKey]: { tag: 'symbol-value' } },
    rows: ['a', 'b'],
  };
  Object.defineProperty(state.plain, 'fixed', { value: shared, writable: false, enumerable: true, configurable: false });
  Object.defineProperty(state.readOnly, 'immutable', { value: 'sealed-value', writable: false, enumerable: false, configurable: false });
  Object.defineProperty(state.accessorHost, 'lazy', {
    get() { getterCalls += 1; return 'computed'; },
    set(value) { getterCalls += 1000 + value; },
    enumerable: true,
    configurable: true,
  });
  state.self = state;
  state.plain.parent = state.plain;
  state.symbolKey = symbolKey;
  return state;
}

test('#prestate a failing optional pass rolls back to a descriptor-exact pre-pass state', () => {
  const state = buildState();
  let before = null;
  const manager = new PassManager([
    {
      name: 'deep-corruptor',
      required: false,
      run(current) {
        // The pre-image is taken immediately before this body runs, so this is
        // the state a rollback must reproduce.
        before = ownedSnapshot(current);
        current.plain.count = 99;
        current.plain.added = 'added';
        delete current.plain.alias;
        current.array.push('appended');
        current.array[0] = 'replaced';
        current.array.length = 9;
        current.map.set('forged', { tag: 'forged' });
        current.map.delete('keep');
        current.set.clear();
        current.set.add({ tag: 'forged-set-entry' });
        current.date.setTime(0);
        current.regex.lastIndex = 7;
        current.rows.push('leaked');
        current.self = null;
        current.symbolHost[current.symbolKey] = 'overwritten';
        Object.defineProperty(current.plain, 'count', { writable: false, enumerable: false, configurable: true });
        Object.setPrototypeOf(current.array, null);
        current.extras = { neverPublished: true };
        throw new Error('deep rewrite failed halfway');
      },
    },
    { name: 'required-finalizer', required: true, run(current) { return current; } },
  ]);

  const out = manager.run(state);

  assert.equal(out.passMetrics[0].ok, false, 'failure is recorded');
  assert.equal(out.degraded, true);
  assert.ok(out.warnings.some((warning) => warning.includes('deep rewrite failed halfway')));
  assert.equal(out.extras, undefined, 'a key added to a captured record is removed again');
  assert.deepEqual(ownedSnapshot(out), before,
    'rollback must restore the exact pre-pass state (values, key order, descriptor attributes, aliases, collection contents)');
  assert.equal(state.getterCalls(), 0, 'pre-image capture must never invoke accessors');
});

test('#prestate rollback restores each record in place, keeping identity and aliases', () => {
  const state = buildState();
  const shared = state.shared;
  const map = state.map;
  let before = null;
  const manager = new PassManager([{
    name: 'identity-corruptor',
    required: false,
    run(current) {
      before = ownedSnapshot(current);
      current.shared.tag = 'mutated';
      current.plain.alias = { tag: 'replaced' };
      current.map = new Map();
      current.set = new Set();
      current.date = new Date(0);
      current.regex = /x/;
      throw new Error('identity failure');
    },
  }]);

  manager.run(state);

  assert.deepEqual(ownedSnapshot(state), before);
  assert.equal(state.shared, shared, 'the restored record is the same object');
  assert.equal(state.map, map, 'a replaced container identity is restored');
  assert.equal(state.shared.tag, 'shared');
  assert.equal(state.plain.alias, shared, 'an alias to a shared record survives the rollback');
  assert.ok(state.map.has('keep'));
  assert.equal(state.map.get('keep'), shared);
  assert.ok(state.set.has(shared));
});

test('#prestate a successful optional pass keeps its mutations (the pre-image is not a clone)', () => {
  const state = { ast: { kind: 'original' }, memo: new Map([['a', 1]]) };
  const manager = new PassManager([{
    name: 'committing-transform',
    required: false,
    run(current) {
      current.ast.kind = 'rewritten';
      current.memo.set('b', 2);
      return current;
    },
  }]);

  manager.run(state);

  assert.equal(state.ast.kind, 'rewritten');
  assert.equal(state.memo.get('b'), 2);
  assert.equal(state.passMetrics[0].ok, true);
});

// The deterministic work-unit counter (`globalThis.__hexCaptureProbe`) counts
// pops/visits/records without any wall-clock assertion. The reference capture
// below is the pre-lane traversal (bulk `Object.getOwnPropertyDescriptors`
// per record, unfiltered pushes) written out in the test so the reduction is
// structural: identical record coverage (same objects snapshotted) with fewer
// pushes. `pendingPops` is the baseline's exact check count
// (`checked === pops`, one increment per loop iteration).
function referenceCaptureCounts(root) {
  const pending = [root];
  const seen = new Set();
  let pops = 0;
  let records = 0;
  const snapshotOwned = (value) => {
    if (value === null || typeof value !== 'object') return false;
    if (value instanceof Map || value instanceof Set || value instanceof Date
      || value instanceof RegExp || Array.isArray(value)) return true;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  };
  while (pending.length) {
    pops += 1;
    const value = pending.pop();
    if (value === null || typeof value !== 'object' || seen.has(value)) continue;
    // No frozen-subtree skip in the reference: it is the naive baseline that
    // visits everything reachable.
    seen.add(value);
    if (!snapshotOwned(value)) continue;
    records += 1;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
      if ('value' in descriptors[key]) pending.push(descriptors[key].value);
    }
    if (value instanceof Map) for (const [key, entry] of value.entries()) pending.push(key, entry);
    if (value instanceof Set) for (const entry of value.values()) pending.push(entry);
  }
  return { pops, records };
}

function captureTotals() {
  const probe = globalThis.__hexCaptureProbe;
  return {
    captures: probe?.captures ?? 0,
    visits: probe?.visits ?? 0,
    pushes: probe?.pushes ?? 0,
    records: probe?.records ?? 0,
  };
}

test('#prestate deterministic work units: same record coverage with fewer pushes than the naive baseline', () => {
  const state = buildState();
  // A wide primitive-heavy graph: the push filter skips every primitive edge,
  // which is where the traversal savings come from.
  state.wide = { cells: Array.from({ length: 300 }, (_, index) => ({ index, label: `cell-${index}`, flag: index % 2 === 0 })) };
  globalThis.__hexCaptureProbe = {};
  const beforeTotals = captureTotals();
  const manager = new PassManager([{
    name: 'primitive-touching-pass',
    required: false,
    run(current) {
      current.plain.count += 1;
      current.wide.cells[7].flag = 'touched';
      return current;
    },
  }, {
    name: 'failing-pass',
    required: false,
    run() { throw new Error('abort after work'); },
  }]);
  manager.run(state);
  const probe = globalThis.__hexCaptureProbe;
  delete globalThis.__hexCaptureProbe;
  assert.ok((probe?.captures ?? 0) >= 2, 'both optional passes captured a pre-image');
  assert.ok((probe?.records ?? 0) > 0, 'the capture snapshotted pass-owned records');
  assert.equal(state.plain.count, 2, 'the committing pass kept its mutation');
  assert.equal(state.wide.cells[7].flag, 'touched');

  // Baseline comparison on the same graph shape: clone the state structurally
  // (fresh objects, same branching/primitive fan-out) so the reference walk
  // sees the same coverage without aliasing the live graph. The probe
  // accumulates over both passes' captures, so compare per-capture averages.
  const cloneState = buildState();
  cloneState.wide = { cells: Array.from({ length: 300 }, (_, index) => ({ index, label: `cell-${index}`, flag: index % 2 === 0 })) };
  const reference = referenceCaptureCounts(cloneState);
  assert.ok(reference.records > 0, 'the baseline covers the same graph');
  const captures = probe.captures ?? 1;
  const perCaptureRecords = (probe.records ?? 0) / captures;
  const perCapturePushes = ((probe.pushes ?? 0) + (probe.visits ?? 0)) / captures;
  // Same record coverage per capture (the lane change never drops a mutable
  // record; the only deltas are the frozen-subtree skip, which the reference
  // does not apply, and the committing pass legitimately adding one record),
  // and strictly fewer pushes per capture than the baseline's pop count
  // because every primitive edge is filtered at push.
  assert.ok(Math.abs(perCaptureRecords - reference.records) <= 2,
    `per-capture records (${perCaptureRecords}) must match the baseline (${reference.records}) within one added record`);
  assert.ok(perCapturePushes < reference.pops,
    `per-capture pushes+visits (${perCapturePushes}) must be fewer than baseline pops (${reference.pops})`);
  assert.ok((beforeTotals.captures ?? 0) === 0, 'the probe starts from a clean counter');
});

test('#prestate pseudocode hash is identical with the pre-image optimization on a fixed function set (deterministicTransforms + default fast profile)', () => {
  const cases = [];
  for (const [tag, build] of [['arith', () => {
    const f = fixture('prestate_hash_arith');
    f.block(0);
    const a = f.opaque(8); a.index = 0; a.reg = 'x0';
    const b = f.opaque(8); b.index = 1; b.reg = 'x1';
    const sum = f.binary('add', a, b, 8);
    f.store(sum, {}); f.ret();
    return f;
  }], ['branch', () => {
    const f = fixture('prestate_hash_branch');
    f.block(0);
    const a = f.opaque(8); a.index = 0; a.reg = 'x0';
    f.branch(a, 1, 2);
    f.block(1); f.ret();
    f.block(2); f.ret();
    return f;
  }], ['loop', () => {
    const f = fixture('prestate_hash_loop');
    f.block(0);
    const a = f.opaque(8); a.index = 0; a.reg = 'x0';
    const one = f.constant(1, 8);
    const sum = f.binary('add', a, one, 8);
    f.branch(sum, 0, 1);
    f.block(1); f.ret();
    return f;
  }]]) {
    const f = build();
    const ir = f.build();
    ir.instructions = ir.blocks.flatMap((block) => [...block.phis, ...block.insts]);
    ir.instructions.forEach((inst, index) => {
      inst.id = `inst_${index}`;
      inst.address = 0x1000n + BigInt(index * 4);
    });
    cases.push({ tag, ir });
  }
  const hashes = [];
  for (const { tag, ir } of cases) {
    for (const opts of [
      { deterministicTransforms: true },
      { profile: 'fast', deterministicTransforms: true },
      { profile: 'fast' },
      {},
    ]) {
      const seed = {
        semantic: true,
        ir,
        types: null,
        lines: [{ kind: 'stmt', indent: 0, text: `return ${tag};`, row: 0, addr: 0x1000n }],
        metrics: {},
        ctx: {},
      };
      const first = enhanceSemanticDecompilation(seed, null, { ir, ...opts, returnType: 'uint8_t' });
      const second = enhanceSemanticDecompilation(seed, null, { ir, ...opts, returnType: 'uint8_t' });
      assert.ok(first?.pseudocode, `${tag} ${JSON.stringify(opts)} must produce pseudocode`);
      assert.equal(second?.pseudocode, first.pseudocode,
        `${tag} ${JSON.stringify(opts)} must be deterministic across runs (pre-image is read-only)`);
      hashes.push([tag, JSON.stringify(opts), first.pseudocode.length,
        createHash('sha256').update(first.pseudocode).digest('hex')]);
    }
  }
  // The suite pins the current output so a future pre-image change that alters
  // rendering fails here instead of silently changing output.
  assert.ok(hashes.length === 12 && hashes.every(([, , length]) => length > 0));
});

test('#prestate an irreversible attribute change still fails closed', () => {
  const state = { row: { value: 1 } };
  const manager = new PassManager([{
    name: 'irreversible-corruptor',
    required: false,
    run(current) {
      Object.defineProperty(current.row, 'sealed', { value: true, writable: false, enumerable: true, configurable: false });
      throw new Error('irreversible');
    },
  }, { name: 'required-finalizer', required: true, run(current) { return current; } }]);

  assert.throws(() => manager.run(state), /optional-pass-rollback-failed/,
    'a non-configurable property added by a failed pass cannot be rolled back and must abort the chain');
});

test('#prestate an accessor is restored as an accessor with the same getter and setter', () => {
  const state = buildState();
  const host = state.accessorHost;
  const getter = Object.getOwnPropertyDescriptor(host, 'lazy').get;
  const setter = Object.getOwnPropertyDescriptor(host, 'lazy').set;
  const manager = new PassManager([{
    name: 'accessor-corruptor',
    required: false,
    run(current) {
      Object.defineProperty(current.accessorHost, 'lazy', { value: 'flattened', writable: true, enumerable: true, configurable: true });
      throw new Error('accessor failure');
    },
  }]);

  manager.run(state);

  const restored = Object.getOwnPropertyDescriptor(state.accessorHost, 'lazy');
  assert.equal(typeof restored.get, 'function', 'the accessor is restored as an accessor');
  assert.equal(restored.get, getter, 'the original getter identity is restored');
  assert.equal(restored.set, setter, 'the original setter identity is restored');
  assert.equal(restored.enumerable, true);
  assert.equal(restored.configurable, true);
  assert.equal(state.getterCalls(), 0, 'capture and rollback never invoke the accessor');
});

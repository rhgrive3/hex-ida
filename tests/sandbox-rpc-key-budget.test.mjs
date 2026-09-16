import assert from 'node:assert/strict';
import test from 'node:test';
import { INPUT_BUDGET, loadSandboxRpcEstimators } from './support/sandbox-rpc-estimators.mjs';

const { measure, prepareRpcArgs, valueSize } = loadSandboxRpcEstimators();

function oversizedKeyObject() {
  return { ['k'.repeat(Math.floor(INPUT_BUDGET / 2) + 64)]: null };
}

function oversizedKeyArray() {
  const value = [];
  value['k'.repeat(Math.floor(INPUT_BUDGET / 2) + 64)] = null;
  return value;
}

test('worker and host reject an RPC object whose property names exceed 4 MiB', () => {
  const args = [oversizedKeyObject()];
  assert.ok(measure(args) > INPUT_BUDGET, 'worker budget must include property names');
  assert.ok(
    valueSize(args, new Set(), INPUT_BUDGET + 1) > INPUT_BUDGET,
    'host budget must independently include property names',
  );
});

test('worker and host reject custom Array property names that exceed 4 MiB', () => {
  const args = [oversizedKeyArray()];
  assert.ok(measure(args) > INPUT_BUDGET, 'worker budget must include Array custom property names');
  assert.ok(
    valueSize(args, new Set(), INPUT_BUDGET + 1) > INPUT_BUDGET,
    'host budget must independently include Array custom property names',
  );
});

test('property-name units accumulate across otherwise-small RPC objects', () => {
  const half = Math.floor(INPUT_BUDGET / 4) + 64;
  const first = [{ ['a'.repeat(half)]: null }];
  const second = [{ ['b'.repeat(half)]: null }];
  const workerTotal = measure(first) + measure(second);
  const hostTotal = valueSize(first, new Set(), INPUT_BUDGET + 1)
    + valueSize(second, new Set(), INPUT_BUDGET + 1);
  assert.ok(workerTotal > INPUT_BUDGET);
  assert.ok(hostTotal > INPUT_BUDGET);
});

test('normal objects stay below budget and worker/host key accounting agrees', () => {
  const args = [{ alpha: 1, beta: 'ok', nested: { gamma: true } }];
  const workerSize = measure(args);
  const hostSize = valueSize(args, new Set(), INPUT_BUDGET + 1);
  assert.equal(workerSize, hostSize);
  assert.ok(workerSize < INPUT_BUDGET);
});

test('worker rejects accessor mutation before cloning caller-owned RPC input', () => {
  const huge = 'k'.repeat(Math.floor(INPUT_BUDGET / 2) + 64);
  const payload = {};
  let getterCalls = 0;
  Object.defineProperty(payload, 'x', {
    enumerable: true,
    get() {
      getterCalls++;
      Object.defineProperty(payload, huge, { value: null, enumerable: true });
      return null;
    },
  });

  assert.equal(prepareRpcArgs([payload], INPUT_BUDGET), null);
  assert.equal(getterCalls, 0, 'preflight must inspect descriptors without invoking accessors');
  assert.equal(Object.hasOwn(payload, huge), false, 'rejected input must not mutate before transport');
});

test('worker sends an owned snapshot for accepted RPC input', () => {
  const payload = { nested: { alpha: 'ok' } };
  const prepared = prepareRpcArgs([payload], INPUT_BUDGET);
  assert.ok(prepared);
  assert.notEqual(prepared.args[0], payload);
  assert.notEqual(prepared.args[0].nested, payload.nested);
  assert.equal(prepared.units, measure(prepared.args));

  payload.nested.alpha = 'mutated-after-prepare';
  payload.extra = oversizedKeyObject();
  assert.deepEqual(prepared.args, [{ nested: { alpha: 'ok' } }]);
});

test('worker rejects SharedArrayBuffer-backed views before creating an RPC snapshot', () => {
  if (typeof SharedArrayBuffer !== 'function') return;

  const shared = new SharedArrayBuffer(8);
  const typed = new Uint8Array(shared);
  const sharedClone = structuredClone(typed);
  typed[0] = 0x5a;
  assert.equal(
    sharedClone[0],
    0x5a,
    'structuredClone alone must demonstrate the shared-backing counterexample',
  );

  assert.equal(prepareRpcArgs([typed], INPUT_BUDGET), null);
  assert.equal(prepareRpcArgs([new DataView(shared)], INPUT_BUDGET), null);

  Object.defineProperty(typed, 'buffer', { value:new ArrayBuffer(8) });
  assert.equal(
    prepareRpcArgs([typed], INPUT_BUDGET),
    null,
    'native backing inspection must ignore a shadowed buffer property',
  );
});

test('worker fails closed on opaque cloneables before RPC transport', () => {
  assert.equal(prepareRpcArgs([new Map([['hidden', 'payload']])], INPUT_BUDGET), null);
});

test('sparse Arrays visit only enumerable own entries instead of iterating length', () => {
  const sparse = [];
  sparse.length = 2 ** 32 - 1;
  sparse[7] = 'x';
  Object.defineProperty(sparse, Symbol.iterator, {
    value() { throw new Error('RPC estimator must not invoke Array iteration'); },
  });

  assert.equal(measure(sparse), 18);
  assert.equal(valueSize(sparse, new Set(), INPUT_BUDGET + 1), 18);
});

test('arrays, strings, ArrayBuffer/views, and cyclic termination semantics are preserved', () => {
  assert.equal(measure([1, 'x', null]), 34);
  assert.equal(valueSize([1, 'x', null], new Set(), INPUT_BUDGET + 1), 34);

  const buffer = new ArrayBuffer(32);
  const view = new Uint8Array([1, 2, 3]);
  assert.equal(measure(buffer), 32, 'worker ArrayBuffer estimate costs the transported store (#8668)');
  assert.equal(measure(view), 3, 'worker typed-array estimate costs the backing store (#8668)');
  assert.equal(valueSize(buffer, new Set(), INPUT_BUDGET + 1), 32);
  assert.equal(valueSize(view, new Set(), INPUT_BUDGET + 1), 3);

  const cycle = {};
  cycle.self = cycle;
  assert.ok(Number.isFinite(measure(cycle)));
  assert.ok(Number.isFinite(valueSize(cycle, new Set(), INPUT_BUDGET + 1)));
});

/*
 * #8668 — RPC input budgets must account ArrayBuffer backing stores.
 *
 * structuredClone() transports a view's complete backing store, so a direct
 * ArrayBuffer or a 1-byte view over an oversized buffer must be costed, and
 * rejected, by both declared ingress budgets before the first clone/send.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { INPUT_BUDGET, buildWorkerProgram, loadSandboxRpcEstimators } from './support/sandbox-rpc-estimators.mjs';

const { measure, prepareRpcArgs, valueSize, cloneCalls } = loadSandboxRpcEstimators();

const MEBIBYTE = 1024 * 1024;
const hostSize = (value) => valueSize(value, new Set(), INPUT_BUDGET + 1);

function oversizedBacking() {
  return new ArrayBuffer(2 * INPUT_BUDGET);
}

test('a direct ArrayBuffer above the RPC input budget is rejected before the first clone', () => {
  cloneCalls.count = 0;
  const args = [new ArrayBuffer(INPUT_BUDGET + 1)];
  assert.equal(prepareRpcArgs(args, INPUT_BUDGET), null);
  assert.equal(cloneCalls.count, 0, 'preflight must reject before nativeStructuredClone()');
  assert.ok(measure(args) > INPUT_BUDGET);
});

test('a direct ArrayBuffer keeps working while it fits the RPC input budget', () => {
  const prepared = prepareRpcArgs([new ArrayBuffer(INPUT_BUDGET - 4096)], INPUT_BUDGET);
  assert.ok(prepared);
  assert.equal(prepared.units, 16 + INPUT_BUDGET - 4096);
  assert.equal(measure([new ArrayBuffer(1024)]), 16 + 1024);
});

test('a 1-byte DataView over an oversized backing store is rejected by both budgets', () => {
  cloneCalls.count = 0;
  const view = new DataView(oversizedBacking(), 0, 1);
  assert.equal(view.byteLength, 1, 'the visible view length must stay the counterexample');
  assert.ok(measure([view]) > INPUT_BUDGET, 'worker preflight must charge the backing store');
  assert.ok(hostSize([view]) > INPUT_BUDGET, 'host ingress must charge the backing store');
  assert.equal(prepareRpcArgs([view], INPUT_BUDGET), null);
  assert.equal(cloneCalls.count, 0, 'rejection must precede the first clone');
});

test('a 1-byte typed view and a non-byte typed view over an oversized backing store are rejected', () => {
  for (const view of [
    new Uint8Array(oversizedBacking(), 0, 1),
    new Float64Array(oversizedBacking(), 0, 1),
  ]) {
    assert.ok(measure([view]) > INPUT_BUDGET, `${view.constructor.name} backing must be charged`);
    assert.equal(hostSize([view]), measure([view]));
    assert.equal(prepareRpcArgs([view], INPUT_BUDGET), null);
  }
});

test('oversized backing stores are charged at any nesting depth of the RPC arguments', () => {
  cloneCalls.count = 0;
  const args = [{ batch: [[{ payload: new Uint8Array(oversizedBacking(), 0, 1) }]] }];
  assert.ok(measure(args) > INPUT_BUDGET);
  assert.ok(hostSize(args) > INPUT_BUDGET);
  assert.equal(prepareRpcArgs(args, INPUT_BUDGET), null);
  assert.equal(cloneCalls.count, 0);
});

test('host defense in depth rejects a bypassed Worker RPC carrying a tiny view over an oversized backing store', () => {
  const forged = [{ id: 1, method: 'emulatorRun', args: [new DataView(oversizedBacking(), 0, 1)] }];
  assert.ok(hostSize(forged) > INPUT_BUDGET);
});

test('a small view over an in-budget backing store keeps working and costs the backing store', () => {
  const backing = new ArrayBuffer(4096);
  const view = new Uint8Array(backing, 0, 1);
  const prepared = prepareRpcArgs([view], INPUT_BUDGET);
  assert.ok(prepared);
  assert.equal(prepared.units, 16 + 4096);
  assert.equal(measure([view]), 16 + 4096);
  assert.equal(hostSize([view]), 16 + 4096);
});

test('aliased views share one backing-store charge instead of undercounting or multiplying', () => {
  const backing = new ArrayBuffer(3 * MEBIBYTE);
  const views = [
    new Uint8Array(backing, 0, 1),
    new Uint8Array(backing, 3 * MEBIBYTE - 1, 1),
    new DataView(backing, 1024, 1),
    new Float64Array(backing, 0, 1),
  ];
  const aliased = measure(views);
  assert.equal(aliased, 16 + 3 * MEBIBYTE, 'one clone transports one copy of the backing store');
  assert.equal(measure([views[0], null, null, null]), aliased);
  assert.ok(aliased < 4 * MEBIBYTE, 'aliasing must not multiply into a false rejection');
  assert.equal(hostSize(views), aliased);
  assert.ok(prepareRpcArgs([views], INPUT_BUDGET));
});

test('a buffer and its own alias are charged once, and cycles terminate deterministically', () => {
  const backing = new ArrayBuffer(3 * MEBIBYTE);
  assert.equal(measure([backing, new Uint8Array(backing)]), 16 + 3 * MEBIBYTE);
  assert.equal(hostSize([backing, new Uint8Array(backing)]), 16 + 3 * MEBIBYTE);

  const cycle = { views: [new Uint8Array(backing, 0, 1)] };
  cycle.self = cycle;
  const workerSize = measure(cycle);
  const host = hostSize(cycle);
  assert.ok(Number.isFinite(workerSize) && Number.isFinite(host));
  assert.equal(workerSize, host);
});

test('the shipped Worker program carries the shared transport contract and parses', () => {
  const workerProgram = buildWorkerProgram();
  assert.ok(workerProgram.includes('function binaryTransportBytes(value, buffers, N)'),
    'the Worker realm must receive the same transport contract as the host');
  assert.equal(workerProgram.match(/function binaryTransportBytes/g).length, 1);
  assert.ok(workerProgram.includes('BINARY_TRANSPORT_NATIVES_FOR_WORKER'),
    'the Worker realm must bind the contract to its own captured natives');
  assert.doesNotThrow(() => new Function(workerProgram));
});

test('worker and host agree on the binary transport cost across the estimator matrix', () => {
  const backing = new ArrayBuffer(2 * MEBIBYTE);
  const matrix = [
    new ArrayBuffer(0),
    new Uint8Array(backing, 0, 0),
    new DataView(backing, 0, 8),
    [new Float64Array(backing, 0, 2)],
    { a: new ArrayBuffer(16), b: new Int16Array(backing, 0, 1) },
    { nested: { deep: [new Uint8Array(backing, 0, 1)] } },
    'text',
    7,
    null,
  ];
  for (const value of matrix) {
    assert.equal(measure([value]), hostSize([value]), `${String(value)} estimator drift`);
  }
});

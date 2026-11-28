import test from 'node:test';
import assert from 'node:assert/strict';
import { probeFunction, summarize, arityFromPseudocode, asReturnInt, inputVectors } from '../js/analysis/io-probe.js';

const traceOf = (fn, extra = {}) => async (_app, _addr, { args }) => {
  if (extra.throwOn && extra.throwOn(args)) throw Object.assign(new Error('boom'), { code: 'emulator-fault' });
  const value = fn(args.map((v) => BigInt.asIntN(32, v)));
  if (value === 'timeout') return { observation: { stop: { kind: 'timeout' } } };
  return {
    observation: { stop: { kind: 'return' }, returnValue: BigInt.asUintN(64, BigInt(value)) & 0xFFFFFFFFn },
    trace: { events: extra.writes ? [{ type: 'memory-write', region: 'globals' }, { type: 'memory-write', region: 'stack' }] : [] },
  };
};

test('linear, sum and constant rules are found only when every row agrees', async () => {
  let r = await probeFunction({}, 0n, { trace: traceOf(([x]) => 3n * x + 1n), arity: 1 });
  assert.equal(summarize(r.rows), '引数1 × 3 + 1 を返す');
  r = await probeFunction({}, 0n, { trace: traceOf(([a, b]) => a + b), arity: 2 });
  assert.equal(summarize(r.rows), '引数1 + 引数2 を返す');
  r = await probeFunction({}, 0n, { trace: traceOf(() => 7n), arity: 1 });
  assert.equal(summarize(r.rows), 'いつも 7 を返す');
  r = await probeFunction({}, 0n, { trace: traceOf(([x]) => (x > 0n ? 2n * x : x)), arity: 1 });
  assert.equal(summarize(r.rows), null, 'piecewise behaviour has no single rule');
  r = await probeFunction({}, 0n, { trace: traceOf(([x]) => (x > 2n ? 1n : 0n)), arity: 1 });
  assert.equal(summarize(r.rows), '0 か 1 を返す');
});

test('negative int results are shown as signed values', async () => {
  const r = await probeFunction({}, 0n, { trace: traceOf(([x]) => -x), arity: 1 });
  assert.equal(r.rows.find((row) => row.args[0] === 3n).out, -3n);
  assert.equal(summarize(r.rows), '-引数1 を返す');
  assert.equal(asReturnInt(0xFFFFFFFFn), -1n);
});

test('timeouts, errors and side effects are reported, and block rules', async () => {
  const r = await probeFunction({}, 0n, { trace: traceOf(([x]) => (x === 10n ? 'timeout' : x), { throwOn: ([x]) => x === 100n, writes: true }), arity: 1 });
  assert.equal(r.rows.find((row) => row.args[0] === 10n).stop, 'timeout');
  assert.equal(r.rows.find((row) => row.args[0] === 100n).stop, 'error');
  assert.equal(r.rows[0].writes, 1, 'stack writes are not side effects');
  assert.equal(summarize(r.rows), null);
});

test('cancellation stops the run', async () => {
  const controller = new AbortController();
  let calls = 0;
  const trace = async (...args) => { calls++; if (calls === 2) controller.abort(); return traceOf(([x]) => x)(...args); };
  const r = await probeFunction({}, 0n, { trace, arity: 1, signal: controller.signal });
  assert.equal(calls, 2);
  assert.equal(r.rows.length, 2);
});

test('arity comes from the decompiled signature', () => {
  assert.equal(arityFromPseudocode('#include <a.h>\nint f(uint64 a1, uint64 a2)\n{\n}'), 2);
  assert.equal(arityFromPseudocode('void g(void)\n{\n}'), 0);
  assert.equal(arityFromPseudocode('no signature'), null);
  assert.equal(inputVectors(9)[0].length, 4);
});

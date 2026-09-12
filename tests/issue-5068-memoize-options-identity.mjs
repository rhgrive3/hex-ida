import assert from 'node:assert/strict';
import test from 'node:test';

import { memoizeAnalysis } from '../js/auto.js';

test('differing options must not reuse another configuration cached analysis (#5068)', async () => {
  const memo = memoizeAnalysis(async (_addr, _end, options) => options.mode);
  assert.equal(await memo(1, 2, { mode: 'A' }), 'A');
  assert.equal(await memo(1, 2, { mode: 'B' }), 'B');
});

test('option-bearing calls must not share identity with option-less calls (#5068)', async () => {
  let calls = 0;
  const memo = memoizeAnalysis(async (_addr, _end, options) => {
    calls++;
    return { options: options ?? null, call: calls };
  });
  const plain = await memo(0x1000n, 0x2000n);
  assert.equal(plain.options, null);
  const configured = await memo(0x1000n, 0x2000n, { mode: 'high' });
  assert.deepEqual(configured.options, { mode: 'high' }, 'the configured call must reach the analyzer with its own options');
  const again = await memo(0x1000n, 0x2000n);
  assert.equal(again.call, plain.call, 'option-less calls must stay memoized');
});

test('an options object that repeats must still observe its own execution semantics (#5068)', async () => {
  let observed = [];
  const memo = memoizeAnalysis(async (_addr, _end, options) => {
    observed.push(options);
    return { mode: options.mode };
  });
  const options = { mode: 'A' };
  assert.equal((await memo(1, 2, options)).mode, 'A');
  assert.equal((await memo(1, 2, { mode: 'A' })).mode, 'A');
  assert.equal(observed.length, 2, 'option-bearing calls must not be shared through the options-free cache identity');
});

test('AbortSignal-bearing calls stay unshared and forward the caller signal (#5068)', async () => {
  const controller = new AbortController();
  let calls = 0;
  let lastOptions = null;
  const memo = memoizeAnalysis(async (_addr, _end, options) => {
    calls++;
    lastOptions = options;
    return { ok: true };
  });
  await memo(0x9000n, 0x9040n, { signal: controller.signal, maxInstructions: 7 });
  await memo(0x9000n, 0x9040n, { signal: controller.signal, maxInstructions: 7 });
  assert.equal(calls, 2);
  assert.equal(lastOptions.signal, controller.signal);
  assert.equal(lastOptions.maxInstructions, 7);
});

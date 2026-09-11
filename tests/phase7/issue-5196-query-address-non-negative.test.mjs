import test from 'node:test';
import assert from 'node:assert/strict';

import { __demandDrivenInternalsForTests } from '../../js/analysis/demand-driven-runtime.js';
import { createAppAnalysisQueryAdapter } from '../../js/analysis/query/app-adapter.js';

// #5196: the canonical address query boundary must enforce one invariant
// regardless of representation — an address is a non-negative integer.
// Only the number branch checked the sign, so -1n / '-1' / 'function:-1'
// reached backend calls that the same logical value as a number could not.

const { addressOf } = __demandDrivenInternalsForTests;

test('#5196 addressOf rejects negative BigInt/string addresses like negative numbers', () => {
  assert.equal(addressOf(-1), null);
  assert.equal(addressOf(-1n), null);
  assert.equal(addressOf('-1'), null);
  assert.equal(addressOf('function:-1'), null);
  assert.equal(addressOf('  -0x10  '), null);
  assert.equal(addressOf({ address: '-1' }), null, 'negative spellings inside object wrappers fail closed too');
});

test('#5196 addressOf keeps accepting valid non-negative representations', () => {
  assert.equal(addressOf(16), 16n);
  assert.equal(addressOf(0n), 0n);
  assert.equal(addressOf(0x10n), 16n);
  assert.equal(addressOf('16'), 16n);
  assert.equal(addressOf('0x10'), 16n);
  assert.equal(addressOf('fn:0x10'), 16n);
  assert.equal(addressOf({ address: 0x10n }), 16n);
  assert.equal(addressOf(null), null);
  assert.equal(addressOf(''), null);
});

test('#5196 query adapter instructions() fails closed for negative string starts', async () => {
  const calls = [];
  const app = {
    backend: {
      async disassembleAt(address) { calls.push(address); return { supported: false, found: false }; },
    },
    store: { get() { return null; } },
  };
  const adapter = createAppAnalysisQueryAdapter(app);
  const result = await adapter.instructions({}, { start: '-1', length: 4 }, {}, {});
  assert.deepEqual(calls, [], 'a negative string start must never reach the backend');
  assert.equal(result.status?.completeness, 'unsupported');
});

test('#5196 query adapter instructions() still serves valid non-negative starts', async () => {
  const calls = [];
  const app = {
    backend: {
      async disassembleAt(address) { calls.push(address); return { supported: true, found: true }; },
    },
    store: { get() { return null; } },
  };
  const adapter = createAppAnalysisQueryAdapter(app);
  await adapter.instructions({}, { start: '0x1000', length: 4 }, {}, {});
  assert.deepEqual(calls, [0x1000n]);
});

import assert from 'node:assert/strict';
import { addressesEqual, createActionRunner } from '../js/ai/interaction/actions.js';

// Canonical string address vs BigInt instruction identity.
assert.equal(addressesEqual('0x1000', 0x1000n), true, 'hex string matches BigInt');
assert.equal(addressesEqual('4096', 0x1000n), true, 'decimal string matches BigInt');
assert.equal(addressesEqual(0x1000n, 0x1000n), true, 'BigInt identity holds');
assert.equal(addressesEqual(4096, 0x1000n), true, 'number matches BigInt');
assert.equal(addressesEqual('0x1001', 0x1000n), false, 'different addresses stay distinct');
assert.equal(addressesEqual('not-an-address', 0x1000n), false, 'invalid address never throws nor matches');
assert.equal(addressesEqual(null, 0x1000n), false, 'null never matches');

// The trace-value branch must resolve the semantic row without a viewer helper.
{
  const fs = await import('node:fs');
  const source = fs.readFileSync(
    new URL('../js/ai/interaction/actions.js', import.meta.url), 'utf8');
  assert.match(source, /addressesEqual\(i\.address, addr\)/,
    'trace-value must compare instruction addresses canonically');
  assert.doesNotMatch(source, /find\(\(i\) => i\.address === addr\)/,
    'trace-value must not rely on strict-only address equality');
}

// Routing: a strict-BigInt-only viewer simulates an environment where the old
// strict equality missed. With the fix the runner must take the showValueFlow
// path (DOM boundary throws in node) instead of overview fallback navigation.
async function runTrace(target) {
  let navigated = null;
  const app = {
    semantic: { model: { instructions: [{ address: 0x1000n, row: 7 }] } },
    store: { get: () => ({}) },
    // Only exact BigInt lookups succeed here, like a viewer without string support.
    viewer: { rowOfAddress: (addr) => (typeof addr === 'bigint' && addr === 0x1000n ? 7 : null) },
    goToAddress: () => true,
  };
  const ui = { router: { navigate: (path) => { navigated = path; } } };
  const run = createActionRunner(app, { ui });
  let threw = null;
  try {
    await run({ kind: 'trace-value', target });
  } catch (error) { threw = error; }
  return { navigated, threw };
}

for (const target of ['0x1000', '4096', 0x1000n]) {
  const { navigated } = await runTrace(target);
  assert.equal(navigated, null,
    `trace-value ${String(target)} must reach the value-flow path, not overview fallback`);
}

{
  const { navigated, threw } = await runTrace('not-an-address');
  assert.equal(threw, null, 'invalid address must fall back without throwing');
  assert.match(navigated ?? '', /overview/, 'invalid address keeps the existing overview fallback');
}

console.log('issue #6098 trace-value address identity regressions PASS');

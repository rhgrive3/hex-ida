import test from 'node:test';
import assert from 'node:assert/strict';

import { buildIR } from '../../../js/ir-core.js';
import { buildSemanticModel } from '../../../js/blocks.js';
import { decompileSemantic } from '../../../js/decompiler/semantic-core.js';

// A10 regression: a call whose IR proves a direct target address but which has neither a
// symbol nor a model name must render that proven target. The unresolved-call fallback in
// renderCall prints the first argument as the callee, which misattributes the call (the IR
// still holds the direct edge) and drops the only callee identity available. Address-form
// naming (`sub_<HEX>`) matches the function-header fallback of the same module and the
// legacy renderer; a genuinely indirect call has no proven target and must keep the
// unresolved form.
const TARGET = 0x20ACn; // even, so the ARM64 `bl` immediate decoder accepts the fixture.

function render(rows, opts = {}) {
  const raw = rows.map((x, row) => ({ row, address: 0x1000n + BigInt(row * 4), ...x }));
  const rowOfAddress = (address) => raw.find((r) => r.address === BigInt(address))?.row ?? null;
  const addrOfRow = (row) => raw[row]?.address ?? null;
  const model = buildSemanticModel(raw, { rowOfAddress, addrOfRow, startRow: 0, endRow: raw.length - 1 });
  const ir = buildIR(model, { rowOfAddress, returnType: 'void', semanticMigrationMode: 'semantic-v2-compat' });
  const calls = (ir?.instructions ?? []).filter((i) => i.op === 'call').map((i) => ({
    target: i.extra?.target ?? null, indirect: i.extra?.indirect === true,
  }));
  const result = decompileSemantic(model, { ir, addr: 0x1000n, rowOfAddress, addrOfRow, ...opts });
  assert.ok(result, 'semantic renderer must produce a result');
  return { pseudocode: result.pseudocode, calls };
}

test('a direct call with a proven but unnamed target renders the address-form callee', () => {
  const { pseudocode, calls } = render([
    { mn: 'ldr', ops: 'x0, [x0, #0xc8]' },
    { mn: 'bl', ops: '#0x20AC' },
    { mn: 'ret', ops: '' },
  ], { symbolFor: () => null });

  assert.deepEqual(calls, [{ target: TARGET, indirect: false }], 'fixture must lift one direct call to the proven target');
  assert.match(pseudocode, /sub_20AC\(/, pseudocode);
  assert.doesNotMatch(pseudocode, /unknown_call\(/, pseudocode);
});

test('an argument value is never promoted into the callee position of a direct call', () => {
  const { pseudocode, calls } = render([
    { mn: 'mov', ops: 'x2, #7' },
    { mn: 'bl', ops: '#0x20AC' },
    { mn: 'ret', ops: '' },
  ], { symbolFor: () => null });

  assert.deepEqual(calls, [{ target: TARGET, indirect: false }]);
  assert.match(pseudocode, /sub_20AC\(/, pseudocode);
  assert.doesNotMatch(pseudocode, /unknown_call\(/, pseudocode);
});

test('a resolved symbol still wins over the address-form fallback and keeps the argument', () => {
  const { pseudocode } = render([
    { mn: 'ldr', ops: 'x0, [x0, #0xc8]' },
    { mn: 'bl', ops: '#0x20AC' },
    { mn: 'ret', ops: '' },
  ], { symbolFor: (address) => (BigInt(address) === TARGET ? 'free' : null) });

  assert.match(pseudocode, /free\(a1->field_C8\)/, pseudocode);
  assert.doesNotMatch(pseudocode, /sub_20AC\(|unknown_call\(/, pseudocode);
});

test('a genuinely indirect call keeps the unresolved form and gains no address-form callee', () => {
  const { pseudocode, calls } = render([
    { mn: 'ldr', ops: 'x1, [x0, #0xc8]' },
    { mn: 'blr', ops: 'x1' },
    { mn: 'ret', ops: '' },
  ], { symbolFor: () => null });

  assert.deepEqual(calls, [{ target: null, indirect: true }], 'fixture must lift one call with no proven target');
  assert.match(pseudocode, /unknown_call\(a1\)/, pseudocode);
  // The only address-form callee in the text is the function header itself.
  assert.equal((pseudocode.match(/sub_[0-9A-F]+\s*\(/g) ?? []).length, 1, pseudocode);
});

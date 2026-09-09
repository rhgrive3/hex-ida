import assert from 'node:assert/strict';

import { buildSemanticModel } from '../../js/blocks.js';
import { constantComparisons } from '../../js/dataflow.js';

const BASE = 0x100000000n;
function modelOf(lines) {
  const rows = lines.map((line, row) => {
    const split = line.indexOf(' ');
    return {
      row,
      address: BASE + BigInt(row * 4),
      mn: split < 0 ? line : line.slice(0, split),
      ops: split < 0 ? '' : line.slice(split + 1),
    };
  });
  const rowOfAddress = (address) => {
    const delta = address - BASE;
    return delta < 0n || delta >= BigInt(rows.length * 4) ? null : Number(delta / 4n);
  };
  return buildSemanticModel(rows, { startRow:0, endRow:rows.length - 1, rowOfAddress });
}

function multiLocationModel() {
  return modelOf([
    'ldr w8, [x19, #0x20]',
    'add w8, w8, #1',
    'str w8, [x19, #0x20]',
    'ldr w10, [x19, #0x40]',
    'add w10, w10, #1',
    'str w10, [x19, #0x40]',
    'mov w9, #100',
    'cmp w8, w9',
    'ret',
  ]);
}

function propagatedThreshold(model, opts) {
  return constantComparisons(model, opts).find((item) => item.row === 7 && item.propagated);
}

for (const value of [undefined, false, 'false', 'true', [], {}, ['false'], 1]) {
  const opts = value === undefined ? undefined : { allowUnscopedPropagated:value };
  assert.equal(
    propagatedThreshold(multiLocationModel(), opts),
    undefined,
    `allowUnscopedPropagated=${String(value)} must not bypass multi-location filtering`,
  );
}

const explicitlyScoped = propagatedThreshold(multiLocationModel(), { allowUnscopedPropagated:true });
assert.ok(explicitlyScoped, 'primitive true remains the explicit opt-in');
assert.equal(explicitlyScoped.value, 100n);

const oneLocation = modelOf([
  'ldr w8, [x19, #0x20]',
  'add w8, w8, #1',
  'str w8, [x19, #0x20]',
  'mov w9, #100',
  'cmp w8, w9',
  'ret',
]);
const safeSingleLocation = constantComparisons(oneLocation).find((item) => item.row === 4 && item.propagated);
assert.ok(safeSingleLocation, 'one-location propagated comparison remains available by default');
assert.equal(safeSingleLocation.value, 100n);

console.log('issue #3809 strict allowUnscopedPropagated opt-in: PASS');

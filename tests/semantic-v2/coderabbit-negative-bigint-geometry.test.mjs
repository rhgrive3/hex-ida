import assert from 'node:assert/strict';

import { partitionDecodedFunction as partitionBase } from '../../js/analysis/semantic-function-base.js';
import { partitionDecodedFunction as partitionCompat } from '../../js/analysis/semantic-function.js';

const plugin = {
  classifyControlFlow() { return 'fallthrough'; },
  directControlTarget() { return null; },
};

for (const [name, partition] of [
  ['base', partitionBase],
  ['compat', partitionCompat],
]) {
  assert.throws(
    () => partition([{ address: -1n, length: 4n }], plugin),
    /semantic-function-instruction-address-invalid/,
    `${name}: negative bigint address must fail closed`,
  );

  assert.throws(
    () => partition([{ address: 0n, length: -4n }], plugin),
    /semantic-function-instruction-length-invalid/,
    `${name}: negative bigint length must fail closed`,
  );

  const blocks = partition([{ address: 0n, length: 4n }], plugin);
  assert.equal(blocks.length, 1, `${name}: valid non-negative bigint geometry remains accepted`);
  assert.equal(blocks[0].startAddress, 0n);
}

console.log('CodeRabbit negative-bigint semantic geometry regression: PASS');

import assert from 'node:assert/strict';
import { createMemoryRegionRef } from '../../js/semantics/memoryssa/contract.js';

function stack(offset) {
  return createMemoryRegionRef({
    id: 'stack',
    kind: 'stack-fixed',
    functionId: 'function_fixture',
    offset,
  });
}

function rooted(offset) {
  return createMemoryRegionRef({
    id: 'rooted',
    kind: 'rooted-offset',
    functionId: 'function_fixture',
    rootEntityId: 'root_fixture',
    offset,
  });
}

for (const [value, expected] of [
  [-8n, '-8'],
  [-8, '-8'],
  ['-8', '-8'],
  [0n, '0'],
  [0, '0'],
  ['0', '0'],
]) {
  assert.equal(stack(value).offset, expected);
  assert.equal(rooted(value).offset, expected);
}

assert.equal(createMemoryRegionRef({
  id: 'rooted-default',
  kind: 'rooted-offset',
  functionId: 'function_fixture',
  rootEntityId: 'root_fixture',
}).offset, '0');

for (const value of [
  ['8'],
  true,
  false,
  new String('8'),
  8n ? { nested: '8' } : null,
  1.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.MAX_SAFE_INTEGER + 1,
  '+8',
  '08',
  ' 8 ',
  '0x8',
  '-0',
]) {
  assert.throws(() => stack(value), /memory-ssa-invalid-region-offset/);
  assert.throws(() => rooted(value), /memory-ssa-invalid-region-offset/);
}

let coercions = 0;
const coercible = {
  valueOf() { coercions += 1; return 8; },
  toString() { coercions += 1; return '8'; },
};
assert.throws(() => stack(coercible), /memory-ssa-invalid-region-offset/);
assert.throws(() => rooted(coercible), /memory-ssa-invalid-region-offset/);
assert.equal(coercions, 0);

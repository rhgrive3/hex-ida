import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryRegionRef } from '../../js/semantics/memoryssa/contract.js';

test('issue #5829: stack-fixed offset rejects empty, whitespace, booleans, arrays and non-canonical strings', () => {
  const stack = (offset) => createMemoryRegionRef({
    id: 'stack-slot',
    kind: 'stack-fixed',
    functionId: 'fn_test',
    offset,
  });

  // Rejections
  const invalidOffsets = [
    '',
    '   ',
    '\t\n',
    true,
    false,
    [],
    ['12'],
    [0],
    {},
    { valueOf: () => 0 },
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    '+0',
    '-0',
    '+4',
    '04',
    '0x10',
    null,
    undefined,
  ];

  for (const val of invalidOffsets) {
    assert.throws(
      () => stack(val),
      /memory-ssa-invalid-region-offset/,
      `Expected stack offset ${JSON.stringify(val)} to be rejected`,
    );
  }

  // Accepted canonical forms
  assert.equal(stack(0).offset, '0');
  assert.equal(stack(0n).offset, '0');
  assert.equal(stack('0').offset, '0');
  assert.equal(stack(-4).offset, '-4');
  assert.equal(stack(-4n).offset, '-4');
  assert.equal(stack('-4').offset, '-4');
  assert.equal(stack(128).offset, '128');
  assert.equal(stack(128n).offset, '128');
  assert.equal(stack('128').offset, '128');
});

test('issue #5829: rooted-offset rejects empty, whitespace, booleans, arrays and non-canonical strings', () => {
  const rooted = (offset) => createMemoryRegionRef({
    id: 'rooted-slot',
    kind: 'rooted-offset',
    functionId: 'fn_test',
    rootEntityId: 'root_obj',
    offset,
  });

  const invalidOffsets = [
    '',
    '   ',
    '\t\n',
    true,
    false,
    [],
    ['12'],
    [0],
    {},
    { valueOf: () => 0 },
    2.25,
    Number.NaN,
    Number.NEGATIVE_INFINITY,
    Number.MIN_SAFE_INTEGER - 1,
    '+0',
    '-0',
    '+8',
    '08',
    '0x20',
  ];

  for (const val of invalidOffsets) {
    assert.throws(
      () => rooted(val),
      /memory-ssa-invalid-region-offset/,
      `Expected rooted offset ${JSON.stringify(val)} to be rejected`,
    );
  }

  // Accepted canonical forms
  assert.equal(rooted(0).offset, '0');
  assert.equal(rooted(0n).offset, '0');
  assert.equal(rooted('0').offset, '0');
  assert.equal(rooted(-16).offset, '-16');
  assert.equal(rooted(-16n).offset, '-16');
  assert.equal(rooted('-16').offset, '-16');
  assert.equal(rooted(64).offset, '64');
  assert.equal(rooted(64n).offset, '64');
  assert.equal(rooted('64').offset, '64');
});

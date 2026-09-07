import assert from 'node:assert/strict';
import test from 'node:test';

import { partitionDecodedFunction as partitionShared } from '../../js/analysis/semantic-function-base.js';
import { partitionDecodedFunction as partitionPublic } from '../../js/analysis/semantic-function.js';

const routes = [
  ['shared', partitionShared],
  ['public', partitionPublic],
];

const plugin = {
  classifyControlFlow(instruction) { return instruction.kind ?? 'fallthrough'; },
  directControlTarget(instruction) { return instruction.target ?? null; },
};

function expectInvalidLength(partition, instruction, label) {
  assert.throws(
    () => partition([instruction], plugin),
    (error) => error instanceof TypeError && error.message === 'semantic-function-instruction-length-invalid',
    label,
  );
}

test('#3757 zero length fails closed before it can create a fallthrough self-loop', () => {
  for (const [route, partition] of routes) {
    for (const length of [0, 0n, '0', '0x0']) {
      expectInvalidLength(partition, { address:0x1000n, length, kind:'fallthrough' }, `${route}/${String(length)}`);
    }
  }
});

test('#3757 zero size fallback and conditional false-edge geometry fail closed', () => {
  for (const [route, partition] of routes) {
    expectInvalidLength(partition, { address:0x1000n, size:0, kind:'fallthrough' }, `${route}/size`);
    expectInvalidLength(partition, { address:0x1000n, length:0n, kind:'conditional-branch' }, `${route}/conditional`);
  }
});

test('#3757 every decoded instruction is validated, including non-terminal instructions in a block', () => {
  for (const [route, partition] of routes) {
    assert.throws(
      () => partition([
        { address:0x1000n, length:0n, kind:'fallthrough' },
        { address:0x1004n, length:4n, kind:'return' },
      ], plugin),
      (error) => error instanceof TypeError && error.message === 'semantic-function-instruction-length-invalid',
      route,
    );
  }
});

test('#3757 positive primitive length representations preserve exact fallthrough', () => {
  for (const [route, partition] of routes) {
    for (const length of [4n, 4, '4', '0x4']) {
      const blocks = partition([
        { address:0x1000n, length, kind:'conditional-branch' },
        { address:0x1004n, length:4n, kind:'return' },
      ], plugin);
      assert.deepEqual(blocks[0].successors, [{ to:'block-1004', kind:'conditional-false' }], `${route}/${String(length)}`);
    }
  }
});

test('#3757 shared geometry does not hard-code one architecture instruction width', () => {
  for (const [route, partition] of routes) {
    for (const length of [1n, 2n, 4n, 8n, 15n]) {
      const next = 0x1000n + length;
      const blocks = partition([
        { address:0x1000n, length, kind:'conditional-branch' },
        { address:next, length:1n, kind:'return' },
      ], plugin);
      assert.deepEqual(blocks[0].successors, [{ to:`block-${next.toString(16)}`, kind:'conditional-false' }], `${route}/${length}`);
    }
  }
});

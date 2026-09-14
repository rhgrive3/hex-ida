import assert from 'node:assert/strict';
import test from 'node:test';

import { partitionDecodedFunction as partitionShared } from '../../js/analysis/semantic-function-base.js';
import { partitionDecodedFunction as partitionPublic } from '../../js/analysis/semantic-function.js';

const routes = [
  ['shared', partitionShared],
  ['public', partitionPublic],
];
const architectures = ['arm64', 'x86_64', 'riscv64'];

function plugin(id) {
  return {
    id,
    classifyControlFlow(instruction) { return instruction.kind; },
    directControlTarget(instruction) { return instruction.target; },
  };
}

function decoded(entries) {
  return entries.map(([address, kind, target = null, length = 4]) => ({
    address:BigInt(address),
    length:BigInt(length),
    kind,
    target:target == null ? null : BigInt(target),
  }));
}

function blockAt(blocks, address) {
  return blocks.find((block) => block.startAddress === BigInt(address));
}

function eachSharedRoute(assertion) {
  for (const [route, partition] of routes) {
    for (const architecture of architectures) {
      assertion(partition, plugin(architecture), `${route}/${architecture}`);
    }
  }
}

test('#3754 conditional branch does not invent a false edge to the next enumerated block across a gap', () => {
  eachSharedRoute((partition, architecturePlugin, label) => {
    const blocks = partition(decoded([
      [0x1000, 'conditional-branch', 0x3000],
      [0x2000, 'return'],
      [0x3000, 'return'],
    ]), architecturePlugin);
    assert.deepEqual(blockAt(blocks, 0x1000).successors, [
      { to:'block-3000', kind:'conditional-true' },
    ], label);
    assert.equal(
      blocks.some((block) => block.successors.some((edge) => edge.to === 'block-2000')),
      false,
      `${label}: sparse block must not acquire a false predecessor`,
    );
  });
});

test('#3754 ordinary fallthrough does not jump to a distant next enumerated block', () => {
  eachSharedRoute((partition, architecturePlugin, label) => {
    const blocks = partition(decoded([
      [0x0800, 'conditional-branch', 0x2000],
      [0x1000, 'fallthrough'],
      [0x2000, 'return'],
    ]), architecturePlugin);
    assert.deepEqual(blockAt(blocks, 0x1000).successors, [], label);
  });
});

test('#3754 exact physical conditional fallthrough is preserved', () => {
  eachSharedRoute((partition, architecturePlugin, label) => {
    const blocks = partition(decoded([
      [0x1000, 'conditional-branch', 0x2000],
      [0x1004, 'return'],
      [0x2000, 'return'],
    ]), architecturePlugin);
    assert.deepEqual(blockAt(blocks, 0x1000).successors, [
      { to:'block-2000', kind:'conditional-true' },
      { to:'block-1004', kind:'conditional-false' },
    ], label);
  });
});

test('#3754 exact physical ordinary fallthrough is preserved', () => {
  eachSharedRoute((partition, architecturePlugin, label) => {
    const blocks = partition(decoded([
      [0x0800, 'conditional-branch', 0x1004],
      [0x1000, 'fallthrough'],
      [0x1004, 'return'],
    ]), architecturePlugin);
    assert.deepEqual(blockAt(blocks, 0x1000).successors, [
      { to:'block-1004', kind:'fallthrough' },
    ], label);
  });
});

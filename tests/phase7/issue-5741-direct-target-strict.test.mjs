import assert from 'node:assert/strict';
import { partitionDecodedFunction } from '../../js/analysis/semantic-function-base.js';

// Issue #5741: a plugin returning a blank-string direct target ('' / '   ')
// coerced through BigInt('') === 0n, minting a fake direct branch edge to
// address 0 in the partitioned CFG. Direct targets follow the same strict
// non-negative integer contract as instruction addresses.

const instructions = [
  { address: 0n, length: 1 },
  { address: 1n, length: 1 },
  { address: 4n, length: 4 },
  { address: 8n, length: 4 },
];

const pluginFor = (target) => ({
  classifyControlFlow(instruction) {
    if (instruction.address === 4n) return 'branch';
    if (instruction.address === 8n) return 'return';
    return 'fallthrough';
  },
  directControlTarget(instruction) {
    if (instruction.address === 4n) return target;
    return null;
  },
});

const edges = (blocks) => blocks.flatMap((b) => b.successors.map((s) => s.to));

for (const malformed of ['', '   ', 'abc', true, -4n]) {
  const blocks = partitionDecodedFunction(instructions, pluginFor(malformed));
  const blockEdges = edges(blocks);
  const branchBlock = blocks.find((block) => block.instructions.some(
    (entry) => entry.decoded.address === 4n,
  ));
  const branchEdges = branchBlock?.successors.map((successor) => successor.to) ?? [];
  assert.equal(blockEdges.includes('block-0'), false,
    `malformed target ${String(malformed)} must not mint an edge to address 0`);
  assert.equal(branchEdges.includes('block-1'), false,
    `malformed target ${String(malformed)} must not mint a branch edge to address 1`);
}

// Legitimate targets keep working, including explicit 0 and hex strings.
{
  const blockEdges = edges(partitionDecodedFunction(instructions, pluginFor(0)));
  assert.ok(blockEdges.includes('block-0'), 'a genuine target 0 still produces the branch edge');
}
{
  const blockEdges = edges(partitionDecodedFunction(instructions, pluginFor('0x8')));
  assert.ok(blockEdges.includes('block-8'), 'hex string targets resolve to real blocks');
}

console.log('issue-5741 blank direct targets do not fabricate branch edges: ok');

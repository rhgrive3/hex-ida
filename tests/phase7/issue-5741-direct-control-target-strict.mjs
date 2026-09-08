// Regression for #5741: `directControlTarget()` output is a CFG authority, so
// blank/whitespace strings or structured values must never launder into
// address 0 and mint a fake branch edge. Both semantic-function entry points
// (base and plugin) share this strict contract.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { partitionDecodedFunction } from '../../js/analysis/semantic-function-base.js';

const instructions = [
  { address: 0n, length: 4 },
  { address: 4n, length: 4 },
  { address: 8n, length: 4 },
];

function pluginFor(malformedTarget) {
  return {
    classifyControlFlow(instruction) {
      if (instruction.address === 4n) return 'branch';
      if (instruction.address === 8n) return 'return';
      return 'fallthrough';
    },
    directControlTarget(instruction) {
      if (instruction.address === 4n) return malformedTarget;
      return null;
    },
  };
}

function blockContaining(address, malformedTarget) {
  const blocks = partitionDecodedFunction(instructions, pluginFor(malformedTarget));
  // The instruction at 4n falls through into block-0, which starts at 0n.
  return blocks.find((b) => BigInt(b.startAddress) <= BigInt(address) && b.instructions.some((i) => BigInt(i.decoded.address) === BigInt(address)));
}

test('#5741 an explicit zero target still resolves to address 0', () => {
  for (const zero of [0n, 0, '0', '0x0']) {
    const succ = blockContaining(4n, zero)?.successors ?? [];
    assert.ok(succ.some((s) => s.to === 'block-0'), `zero target must resolve: ${String(zero)}`);
  }
});

test('#5741 a blank direct target produces no fake branch edge', () => {
  for (const malformed of ['', '   ', '\t', [], {}, true, -8n, -8, '-8']) {
    const succ = blockContaining(4n, malformed)?.successors ?? [];
    assert.deepEqual(succ, [], `malformed target ${JSON.stringify(String(malformed))} must not mint an edge`);
  }
});

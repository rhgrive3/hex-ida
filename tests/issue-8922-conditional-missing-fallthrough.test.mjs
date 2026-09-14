// Issue #8922 regression: a conditional-branch whose fallthrough block is
// missing must not survive as a 1-target conditional-branch (rejected by the
// #4585 cardinality guard). It becomes a partial branch on the taken edge.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createMachineEffectBundle } from '../js/semantics/effects/index.js';
import { buildSemanticV2CompatibilityPipeline } from '../js/semantics/compat/index.js';
import { partitionDecodedFunction } from '../js/analysis/semantic-function-base.js';

const address = (value) => ({
  kind: 'absolute-address',
  value: `0x${BigInt(value).toString(16)}`,
  widthBits: 64,
});

const plugin = Object.freeze({
  id: 'test-architecture-8922',
  semanticVersion: 'test-semantics-1',
  classifyControlFlow(instruction) { return instruction.kind; },
  directControlTarget(instruction) { return instruction.target; },
  liftExact(decoded) {
    const base = {
      instructionId: decoded.instructionId,
      architectureId: 'test-architecture-8922',
      mode: decoded.mode,
      possibleFaults: [],
      origin: decoded.origin,
    };
    if (decoded.kind === 'conditional-branch') {
      return createMachineEffectBundle({
        ...base,
        operations: [],
        controlEffect: {
          kind: 'conditional-branch',
          target: address(decoded.target),
          fallthrough: address(decoded.address + decoded.length),
          condition: { kind: 'bitvector', widthBits: 1, value: '1' },
        },
        completeness: 'exact',
      });
    }
    if (decoded.kind === 'return') {
      return createMachineEffectBundle({
        ...base,
        operations: [],
        controlEffect: { kind: 'return' },
        completeness: 'exact',
      });
    }
    return null;
  },
});

test('#8922 missing fallthrough never yields 1-target conditional-branch', () => {
  const blocks = partitionDecodedFunction([
    { address: 0x1000n, length: 4n, mode: 'test', kind: 'conditional-branch', target: 0x2000n },
    { address: 0x2000n, length: 4n, mode: 'test', kind: 'return' },
  ], plugin);
  const staleBlocks = blocks.map((block, index) => (index === 0
    ? { ...block, successors: [...block.successors, { to: 'block-2000', kind: 'conditional-false' }] }
    : block));
  const result = buildSemanticV2CompatibilityPipeline({
    architecturePlugin: plugin,
    decoderSemanticVersion: 'test-decoder-8922',
    binaryId: 'binary_8922_fixture',
    sliceId: 'slice_8922_fixture',
    addressWidthBits: 64,
    entryBlockKey: 'block-1000',
    blocks: staleBlocks,
  });
  const singles = result.semanticIr.nodes.filter((node) => node.kind === 'conditional-branch');
  assert.ok(singles.every((node) => node.targets.length === 2), 'no 1-target conditional-branch may survive');
  assert.equal(result.semanticIr.completeness, 'partial');
  assert.equal(
    result.semanticIr.unknowns.some((u) => u.reason === 'semantic-cfg-missing-fallthrough'),
    true,
  );
  assert.equal(
    result.cfg.blocks.some((b) => b.successors.some((e) => e.kind === 'conditional-false')),
    false,
    'missing fallthrough must not become a false CFG edge',
  );
});

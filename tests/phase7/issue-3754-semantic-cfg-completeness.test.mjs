import assert from 'node:assert/strict';

import { createMachineEffectBundle } from '../../js/semantics/effects/index.js';
import { buildSemanticV2CompatibilityPipeline } from '../../js/semantics/compat/index.js';
import {
  partitionDecodedFunction,
  semanticControlUnknowns,
} from '../../js/analysis/semantic-function-base.js';
import { partitionDecodedFunction as partitionPublic } from '../../js/analysis/semantic-function.js';

const address = (value) => ({
  kind: 'absolute-address',
  value: `0x${BigInt(value).toString(16)}`,
  widthBits: 64,
});

const register = {
  kind: 'register',
  registerId: 'state0',
  widthBits: 32,
};

const plugin = Object.freeze({
  id: 'test-architecture',
  semanticVersion: 'test-semantics-1',
  classifyControlFlow(instruction) {
    return instruction.kind;
  },
  directControlTarget(instruction) {
    return instruction.target;
  },
  liftExact(decoded) {
    const base = {
      instructionId: decoded.instructionId,
      architectureId: 'test-architecture',
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
        operations: [{
          id: `${decoded.instructionId}:read`,
          kind: 'register-read',
          register,
          value: { kind: 'bitvector', widthBits: 32 },
        }],
        controlEffect: { kind: 'return' },
        completeness: 'exact',
      });
    }
    return null;
  },
});

const decoded = [
  {
    address: 0x1000n,
    length: 4n,
    mode: 'test',
    kind: 'conditional-branch',
    target: 0x2000n,
  },
  {
    address: 0x2000n,
    length: 4n,
    mode: 'test',
    kind: 'return',
  },
];

const blocks = partitionDecodedFunction(decoded, plugin);
assert.equal(blocks.length, 2, 'a sparse address gap must start a new block');
assert.deepEqual(blocks[0].successors, [
  { to: 'block-2000', kind: 'conditional-true' },
]);

const unknowns = semanticControlUnknowns(blocks, plugin);
assert.deepEqual(unknowns, [{
  reason: 'semantic-cfg-missing-fallthrough',
  categories: ['control'],
  detail: {
    blockKey: 'block-1000',
    instructionAddress: '4096',
    expectedAddress: '4100',
  },
}]);

const ordinaryBlocks = partitionDecodedFunction([
  { address: 0x3000n, length: 4n, mode: 'test', kind: 'fallthrough' },
  { address: 0x4000n, length: 4n, mode: 'test', kind: 'return' },
], plugin);
assert.equal(ordinaryBlocks.length, 2);
assert.equal(semanticControlUnknowns(ordinaryBlocks, plugin).length, 1);

const publicBlocks = partitionPublic([
  { address: 0x3000n, length: 4n, mode: 'test', kind: 'fallthrough' },
  { address: 0x4000n, length: 4n, mode: 'test', kind: 'return' },
], plugin);
assert.equal(publicBlocks.length, 2, 'the public partitioner must preserve sparse block boundaries');
assert.equal(semanticControlUnknowns(publicBlocks, plugin).length, 1);

const staleBlocks = blocks.map((block, index) => index === 0
  ? {
    ...block,
    successors: [...block.successors, { to: 'block-2000', kind: 'conditional-false' }],
  }
  : block);

const result = buildSemanticV2CompatibilityPipeline({
  architecturePlugin: plugin,
  decoderSemanticVersion: 'test-decoder-1',
  binaryId: 'binary_3754_fixture',
  sliceId: 'slice_3754_fixture',
  addressWidthBits: 64,
  entryBlockKey: 'block-1000',
  blocks: staleBlocks,
});

assert.equal(result.semanticIr.completeness, 'partial');
assert.equal(
  result.semanticIr.unknowns.some((unknown) => unknown.reason === 'semantic-cfg-missing-fallthrough'),
  true,
);
assert.equal(result.legacyV1.truncated, true);
assert.equal(
  result.legacyV1.instructions.some(
    (instruction) => instruction.op === 'unknown'
      && instruction.extra?.unknownCategories?.includes('control'),
  ),
  true,
  'control uncertainty must survive the v2-to-v1 projection',
);
assert.equal(
  result.cfg.blocks.some(
    (block) => block.successors.some((edge) => edge.kind === 'conditional-false'),
  ),
  false,
  'the missing physical fallthrough must not become a false CFG edge',
);

const resolvedBlocks = partitionDecodedFunction([
  {
    address: 0x1000n,
    length: 4n,
    mode: 'test',
    kind: 'conditional-branch',
    target: 0x2000n,
  },
  { address: 0x1004n, length: 4n, mode: 'test', kind: 'return' },
  { address: 0x2000n, length: 4n, mode: 'test', kind: 'return' },
], plugin);
const resolvedResult = buildSemanticV2CompatibilityPipeline({
  architecturePlugin: plugin,
  decoderSemanticVersion: 'test-decoder-1',
  binaryId: 'binary_3754_resolved_fixture',
  sliceId: 'slice_3754_resolved_fixture',
  addressWidthBits: 64,
  entryBlockKey: 'block-1000',
  blocks: resolvedBlocks,
});
const resolvedEdgeKinds = resolvedResult.cfg.blocks.flatMap(
  (block) => block.successors.map((edge) => edge.kind),
);
assert.equal(resolvedEdgeKinds.includes('conditional-true'), true);
assert.equal(
  resolvedEdgeKinds.includes('conditional-false'),
  true,
  'an exact decoded fallthrough must retain the false CFG edge',
);

console.log('issue-3754 semantic CFG completeness propagation: PASS');

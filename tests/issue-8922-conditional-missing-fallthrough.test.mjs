// Issue #8922 regression: a conditional-branch whose fallthrough block is
// missing must not survive as a 1-target conditional-branch (rejected by the
// #4585 cardinality guard), and must not be laundered into an unconditional
// `branch` edge either. It becomes a partial control projection that keeps the
// known taken target, the condition, and the missing-fallthrough evidence.
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

function sparseConditionalPipeline() {
  const blocks = partitionDecodedFunction([
    { address: 0x1000n, length: 4n, mode: 'test', kind: 'conditional-branch', target: 0x2000n },
    { address: 0x2000n, length: 4n, mode: 'test', kind: 'return' },
  ], plugin);
  const staleBlocks = blocks.map((block, index) => (index === 0
    ? { ...block, successors: [...block.successors, { to: 'block-2000', kind: 'conditional-false' }] }
    : block));
  return buildSemanticV2CompatibilityPipeline({
    architecturePlugin: plugin,
    decoderSemanticVersion: 'test-decoder-8922',
    binaryId: 'binary_8922_fixture',
    sliceId: 'slice_8922_fixture',
    addressWidthBits: 64,
    entryBlockKey: 'block-1000',
    blocks: staleBlocks,
  });
}

test('#8922 missing fallthrough never yields 1-target conditional-branch', () => {
  const result = sparseConditionalPipeline();
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

test('#8922 missing fallthrough publishes no exact/unconditional branch edge', () => {
  const result = sparseConditionalPipeline();
  const edges = result.cfg.blocks.flatMap((block) => block.successors);
  assert.equal(
    edges.some((edge) => edge.kind === 'branch'),
    false,
    'an unresolved fallthrough must never be published as unconditional control',
  );

  // The unresolved conditional survives as a *partial* control projection:
  // the known taken possibility and the condition stay losslessly visible and
  // the missing-fallthrough evidence is carried on the node itself.
  const partials = result.semanticIr.nodes.filter(
    (node) => node.kind === 'unknown-control-effect'
      && node.unknown?.reason === 'semantic-cfg-missing-fallthrough',
  );
  assert.equal(partials.length, 1, 'exactly one partial control projection is published');
  const [partial] = partials;
  assert.equal(partial.completeness, 'partial');
  assert.ok(partial.targets.length >= 1, 'the known taken target must survive');
  assert.ok(partial.unknown.knownParts.conditionInputs.length >= 1, 'the condition must survive');
  assert.equal(partial.unknown.knownParts.expectedFallthroughAddress, '0x1004');
  assert.deepEqual(partial.unknown.knownParts.takenTargets, partial.targets);

  const conditional = result.cfg.blocks.find((block) => block.successors.some((edge) => edge.kind === 'conditional-true'));
  assert.ok(conditional, 'the known taken edge must remain as a conditional-true possibility');
  assert.ok(
    conditional.successors.some((edge) => edge.kind === 'unknown'),
    'the unresolved successor must stay explicitly unknown',
  );
});

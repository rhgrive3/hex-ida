import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalAnalysisIdentity } from '../../../js/decompiler/phase8/analysis-identity.js';
import { buildSemanticV2CompatibilityPipeline } from '../../../js/semantics/compat/index.js';
import { createMachineEffectBundle } from '../../../js/semantics/effects/index.js';

const plugin = Object.freeze({
  id: 'phase8-canonical-attribute-cache-test',
  semanticVersion: '1',
  fixedInstructionSize: 4,
  liftExact(decoded) {
    return createMachineEffectBundle({
      instructionId: decoded.instructionId,
      architectureId: 'phase8-canonical-attribute-cache-test',
      mode: decoded.mode,
      operations: [{
        id: `${decoded.instructionId}:read`,
        kind: 'register-read',
        register: { kind:'register', registerId:'state0', widthBits:64 },
        value: { kind:'bitvector', widthBits:64 },
      }],
      controlEffect: { kind:'return' },
      possibleFaults: [],
      origin: decoded.origin,
      completeness: 'exact',
    });
  },
});

function pipeline() {
  return buildSemanticV2CompatibilityPipeline({
    architecturePlugin: plugin,
    decoderSemanticVersion: 'phase8-canonical-attribute-cache-decoder-1',
    binaryId: 'binary_phase8_canonical_attribute_cache',
    sliceId: 'slice_phase8_canonical_attribute_cache',
    addressWidthBits: 64,
    blocks: [{
      key: 'body',
      startAddress: 0x4000n,
      instructions: [{ decoded: { address:0x4000n, mode:'test' } }],
      successors: [],
    }],
  });
}

test('issued legacy identity reuses canonical attributes and fails closed on replacement', () => {
  const result = pipeline();
  const legacy = result.legacyV1;
  const canonicalAttributes = new WeakSet(result.semanticIr.nodes.map((node) => node.attributes));

  const countCanonicalAttributeReads = (ir) => {
    const original = Object.getOwnPropertyDescriptor;
    let reads = 0;
    Object.getOwnPropertyDescriptor = function counted(owner, key) {
      if (owner && typeof owner === 'object' && canonicalAttributes.has(owner)) reads += 1;
      return original(owner, key);
    };
    try {
      return { resolved:canonicalAnalysisIdentity({ ir }), reads };
    } finally {
      Object.getOwnPropertyDescriptor = original;
    }
  };

  const issued = countCanonicalAttributeReads(legacy);
  const copied = countCanonicalAttributeReads({ ...legacy });
  assert.equal(issued.resolved.valid, true);
  assert.equal(copied.resolved.valid, true);
  assert.ok(copied.reads > issued.reads,
    `producer-bound attributes were not skipped: issued=${issued.reads}, copied=${copied.reads}`);

  const instruction = legacy.instructions.find((candidate) => candidate?.extra?.attributes != null);
  assert.ok(instruction, 'fixture must project a canonical attributes reference');
  const before = canonicalAnalysisIdentity({ ir:legacy });
  const canonical = instruction.extra.attributes;
  instruction.extra.attributes = { ...canonical, forgedPhase8Field:true };
  const after = canonicalAnalysisIdentity({ ir:legacy });
  assert.equal(after.valid, true);
  assert.notDeepEqual(after.identity, before.identity,
    'replacing a producer-bound canonical attributes reference must invalidate the identity');
});

test('issued legacy identity still observes mutable wrapper metadata', () => {
  const result = pipeline();
  const legacy = result.legacyV1;
  const instruction = legacy.instructions.find((candidate) => candidate?.extra != null);
  assert.ok(instruction);
  const before = canonicalAnalysisIdentity({ ir:legacy });
  assert.equal(before.valid, true);

  instruction.extra.phase8WrapperMutation = 'changed';
  const after = canonicalAnalysisIdentity({ ir:legacy });
  assert.equal(after.valid, true);
  assert.notDeepEqual(after.identity, before.identity);
});

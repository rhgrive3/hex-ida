import assert from 'node:assert/strict';
import test from 'node:test';

import { createMachineEffectBundle } from '../../../js/semantics/effects/index.js';
import { buildSemanticV2CompatibilityPipeline } from '../../../js/semantics/compat/index.js';
import { canonicalAnalysisIdentity } from '../../../js/decompiler/phase8/analysis-identity.js';

const plugin = Object.freeze({
  id: 'phase8-attribute-binding-test',
  semanticVersion: '1',
  fixedInstructionSize: 4,
  liftExact(decoded) {
    return createMachineEffectBundle({
      instructionId: decoded.instructionId,
      architectureId: 'phase8-attribute-binding-test',
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
    decoderSemanticVersion: 'phase8-attribute-binding-decoder-1',
    binaryId: 'binary_phase8_attribute_binding',
    sliceId: 'slice_phase8_attribute_binding',
    addressWidthBits: 64,
    blocks: [{
      key:'body',
      startAddress:0x4000n,
      instructions:[{ decoded:{ address:0x4000n, mode:'test' } }],
      successors:[],
    }],
  });
}

test('issued legacy identity reuses canonical attributes but still detects wrapper/reference mutation', () => {
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
  assert.equal(issued.resolved.valid, true);

  // A shallow copy has identical public content but no private producer
  // association, so it must take the complete legacy hashing path.
  const copied = countCanonicalAttributeReads({ ...legacy });
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

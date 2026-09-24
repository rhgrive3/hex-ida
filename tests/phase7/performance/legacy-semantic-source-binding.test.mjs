import assert from 'node:assert/strict';

import {
  buildSemanticV2CompatibilityPipeline,
  canonicalLegacySemanticSourceBinding,
} from '../../../js/semantics/compat/index.js';

const plugin = Object.freeze({
  id: 'phase7-binding-test',
  semanticVersion: '1',
  fixedInstructionSize: 4,
  liftExact() { return null; },
});

const result = buildSemanticV2CompatibilityPipeline({
  architecturePlugin: plugin,
  decoderSemanticVersion: 'phase7-binding-decoder-1',
  binaryId: 'binary_phase7_binding',
  sliceId: 'slice_phase7_binding',
  addressWidthBits: 64,
  blocks: [{
    key: 'body',
    startAddress: 0x4000n,
    instructions: [{ decoded: { address: 0x4000n, mode: 'test' } }],
    successors: [],
  }],
});

const binding = canonicalLegacySemanticSourceBinding(result.legacyV1);
assert.ok(binding, 'issued legacy projection must recover private producer binding');
assert.equal(binding.semanticIr, result.semanticIr);
assert.match(binding.semanticIrDigest, /^[0-9a-f]+$/);
assert.equal(canonicalLegacySemanticSourceBinding({ ...result.legacyV1 }), null,
  'copied legacy projection must not inherit producer binding');

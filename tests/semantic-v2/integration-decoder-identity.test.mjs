import assert from 'node:assert/strict';
import { ArchitecturePluginV2 } from '../../js/targets/architecture/registry.js';
import { createMachineEffectBundle } from '../../js/semantics/effects/index.js';
import { buildSemanticV2CompatibilityPipeline } from '../../js/semantics/compat/index.js';

// A generic object-identity fixture, not an x86 receiver brand. Real receiver
// authority is independently covered by phase6/browser/wasm-decode.browser.mjs.
const decoded = Object.freeze({ address: 0x1000n, size: 1, mode: 'unit', instructionId: 'caller-id' });
let calls = 0;
const plugin = new ArchitecturePluginV2({
  id: 'decoder-identity-fixture', semanticVersion: 'unit-1',
  liftExact() { assert.fail('identity-preserving hook must be used when supplied'); },
  liftDecodedExact(source, context) {
    calls++;
    assert.equal(source, decoded, 'the original decoder object must reach the owner');
    assert.notEqual(context.instructionId, 'caller-id');
    assert.notEqual(context.instructionId, 'injected-context-id');
    assert.equal(context.mode, 'unit');
    assert.ok(context.origin.instructionIds.includes(context.instructionId));
    return createMachineEffectBundle({
      instructionId: context.instructionId, architectureId: 'decoder-identity-fixture',
      mode: context.mode, origin: context.origin, possibleFaults: [],
      operations: [{
        id: `${context.instructionId}:write`, kind: 'register-write',
        register: { kind: 'register', registerId: 'state0', widthBits: 32 },
        value: { kind: 'bitvector', widthBits: 32, value: '1' },
      }],
      controlEffect: { kind: 'fallthrough' }, completeness: 'exact',
    });
  },
});
const input = {
  architecturePlugin: plugin, decoderSemanticVersion: 'decoder-unit-1',
  binaryId: 'binary:decoder-identity', sliceId: 'slice:decoder-identity', addressWidthBits: 64,
  entryBlockKey: 'entry',
  blocks: [{ key: 'entry', startAddress: 0x1000n, instructions: [{ decoded }], successors: [] }],
  machineEffectsContext: { instructionId: 'injected-context-id', mode: 'injected-mode', origin: {} },
};
const result = buildSemanticV2CompatibilityPipeline(input);
assert.equal(calls, 1);
assert.equal(result.machineEffects.length, 1);
assert.equal(decoded.instructionId, 'caller-id', 'binding canonical metadata must not mutate the caller');
assert.throws(() => buildSemanticV2CompatibilityPipeline({
  ...input, architecturePlugin: { ...plugin, liftDecodedExact: true },
}), /semantic-v2-lift-decoded-exact-invalid/);

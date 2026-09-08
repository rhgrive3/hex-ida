import assert from 'node:assert/strict';
import test from 'node:test';

import { createMachineEffectBundle } from '../../js/semantics/effects/index.js';
import { buildSemanticV2CompatibilityPipeline } from '../../js/semantics/compat/index.js';

const plugin = Object.freeze({
  id: 'issue-4473-architecture',
  semanticVersion: 'issue-4473-semantics-v1',
  fixedInstructionSize: 4,
  liftExact(decoded) {
    return createMachineEffectBundle({
      instructionId: decoded.instructionId,
      architectureId: 'issue-4473-architecture',
      mode: decoded.mode,
      operations: [],
      controlEffect: { kind: 'return' },
      possibleFaults: [],
      origin: decoded.origin,
      completeness: 'exact',
    });
  },
});

function input(overrides = {}) {
  return {
    architecturePlugin: plugin,
    decoderSemanticVersion: 'issue-4473-decoder-v1',
    binaryId: 'binary-issue-4473',
    sliceId: 'slice-issue-4473',
    addressWidthBits: 64,
    blocks: [{
      key: 'entry',
      startAddress: 0x1000n,
      instructions: [{ decoded: { address: 0x1000n, mode: 'a64' } }],
      successors: [],
    }],
    ...overrides,
  };
}

test('#4473 preserves valid primitive protocol strings', () => {
  const result = buildSemanticV2CompatibilityPipeline(input());
  assert.equal(typeof result.functionId, 'string');
  assert.equal(result.machineEffects.length, 1);
  assert.equal(result.machineEffects[0].mode, 'a64');
});

test('#4473 rejects structured and non-string identity fields before canonical ID minting', () => {
  const cases = [
    ['architecture id', { architecturePlugin: { ...plugin, id: ['issue-4473-architecture'] } }, 'semantic-v2-integration-architecture-id-required'],
    ['architecture semantic version', { architecturePlugin: { ...plugin, semanticVersion: { value: 'issue-4473-semantics-v1' } } }, 'semantic-v2-integration-architecture-semantic-version-required'],
    ['decoder semantic version', { decoderSemanticVersion: ['issue-4473-decoder-v1'] }, 'semantic-v2-integration-decoder-semantic-version-required'],
    ['binary id', { binaryId: ['binary-issue-4473'] }, 'semantic-v2-integration-binary-id-required'],
    ['slice id', { sliceId: { value: 'slice-issue-4473' } }, 'semantic-v2-integration-slice-id-required'],
  ];
  for (const [label, overrides, code] of cases) {
    assert.throws(() => buildSemanticV2CompatibilityPipeline(input(overrides)), (error) => {
      assert.equal(error.message, code, label);
      return true;
    });
  }
});

test('#4473 rejects structured block, successor, entry, and instruction mode protocol fields', () => {
  const cases = [
    [{ blocks: [{ ...input().blocks[0], key: ['entry'] }] }, 'semantic-v2-integration-block-key-required'],
    [{ entryBlockKey: ['entry'] }, 'semantic-v2-integration-entry-block-required'],
    [{ blocks: [{ ...input().blocks[0], successors: [{ to: ['entry'], kind: 'fallthrough' }] }] }, 'semantic-v2-integration-successor-target-required'],
    [{ blocks: [{ ...input().blocks[0], successors: [{ to: 'entry', kind: ['fallthrough'] }] }] }, 'semantic-v2-integration-successor-kind-required'],
    [{ blocks: [{ ...input().blocks[0], instructions: [{ decoded: { address: 0x1000n, mode: { value: 'a64' } } }] }] }, 'semantic-v2-integration-instruction-mode-required'],
  ];
  for (const [overrides, code] of cases) {
    assert.throws(() => buildSemanticV2CompatibilityPipeline(input(overrides)), (error) => error.message === code);
  }
});

console.log('issue-4473 Semantic v2 compat identity boundaries: ok');

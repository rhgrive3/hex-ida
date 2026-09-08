import assert from 'node:assert/strict';
import { createMachineEffectBundle } from '../../js/semantics/effects/index.js';
import { buildSemanticV2CompatibilityPipeline } from '../../js/semantics/compat/index.js';

const plugin = Object.freeze({
  id: 'arm64',
  semanticVersion: 'issue-4513-test',
  fixedInstructionSize: 4,
  liftExact(decoded) {
    return createMachineEffectBundle({
      instructionId: decoded.instructionId,
      architectureId: 'arm64',
      mode: 'a64',
      possibleFaults: [],
      origin: decoded.origin,
      metadata: { family: 'arm64-memory', mnemonic: 'ldr' },
      operations: [{
        id: `${decoded.instructionId}:load`,
        kind: 'memory-read',
        access: {
          space: 'memory',
          addressExpr: { kind: 'bitvector', widthBits: 64, value: '20480' },
          widthBits: 64,
          endian: 'little',
        },
        value: { kind: 'bitvector', widthBits: 64 },
      }],
      controlEffect: { kind: 'return' },
      completeness: 'exact',
    });
  },
});

const result = buildSemanticV2CompatibilityPipeline({
  architecturePlugin: plugin,
  decoderSemanticVersion: 'issue-4513-decoder',
  binaryId: 'binary_issue_4513',
  sliceId: 'slice_issue_4513',
  addressWidthBits: 64,
  blocks: [{
    key: 'entry',
    startAddress: 0x1000n,
    instructions: [{ decoded: { address: 0x1000n, mode: 'a64' } }],
    successors: [],
  }],
});
const access = result.memorySsa.accessMetadata[0];
assert.ok(access?.accessProof, 'compatibility pipeline must use its registered canonical provider');
assert.equal(access.memory.volatility, false);
assert.equal(access.memory.atomic, false);

console.log('issue #4513 MemorySSA compatibility provider routing: PASS');

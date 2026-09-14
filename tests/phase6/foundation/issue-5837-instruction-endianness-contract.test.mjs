import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeDecodedSemanticFunction } from '../../../js/analysis/semantic-function-base.js';
import { architecturePluginV2 } from '../../../js/targets/architecture/index.js';
import { ArchitecturePluginV2 } from '../../../js/targets/architecture/registry.js';

test('ArchitecturePluginV2 preserves a canonical frozen instruction-endianness capability', () => {
  const plugin = new ArchitecturePluginV2({
    id:'probe-isa',
    supportedMemoryEndianness:[' BIG ', 'little', 'big'],
    supportedInstructionEndianness:[' LITTLE ', 'little', 'BIG', 'big'],
  });

  assert.deepEqual(plugin.supportedMemoryEndianness, ['big', 'little']);
  assert.deepEqual(plugin.supportedInstructionEndianness, ['little', 'big']);
  assert.equal(Object.isFrozen(plugin.supportedMemoryEndianness), true);
  assert.equal(Object.isFrozen(plugin.supportedInstructionEndianness), true);
  assert.throws(() => plugin.supportedInstructionEndianness.push('middle'), TypeError);
});

test('instruction and memory endianness remain independent capabilities', () => {
  const plugin = new ArchitecturePluginV2({
    id:'split-endian-probe',
    supportedMemoryEndianness:['little', 'big'],
    supportedInstructionEndianness:['big'],
  });

  assert.deepEqual(plugin.supportedMemoryEndianness, ['little', 'big']);
  assert.deepEqual(plugin.supportedInstructionEndianness, ['big']);

  const malformed = new ArchitecturePluginV2({
    id:'malformed-endian-probe',
    supportedMemoryEndianness:'little',
    supportedInstructionEndianness:{ value:'little' },
  });
  assert.deepEqual(malformed.supportedMemoryEndianness, []);
  assert.deepEqual(malformed.supportedInstructionEndianness, []);
});

test('builtin architecture plugins publish the instruction byte order their decoders accept', () => {
  for (const id of ['arm64', 'arm64e', 'x86_64', 'riscv64']) {
    assert.deepEqual(architecturePluginV2(id).supportedInstructionEndianness, ['little'], id);
  }
  assert.deepEqual(architecturePluginV2('unknown').supportedInstructionEndianness, []);
});

test('semantic-function rejects unsupported builtin instruction endianness before analysis', () => {
  for (const architecture of ['arm64', 'arm64e', 'x86_64', 'riscv64']) {
    assert.throws(
      () => analyzeDecodedSemanticFunction({ instructions:[], architecture, instructionEndianness:'big' }),
      { name:'TypeError', message:'semantic-function-unsupported-instruction-endianness:big' },
      architecture,
    );
  }
});

test('instruction and data endianness checks do not collapse into one another', () => {
  assert.throws(
    () => analyzeDecodedSemanticFunction({
      instructions:[], architecture:'x86_64', instructionEndianness:'little', dataEndianness:'big',
    }),
    { name:'TypeError', message:'semantic-function-unsupported-memory-endianness:big' },
  );
});

test('unknown instruction endianness keeps the existing non-reject special case', () => {
  assert.throws(
    () => analyzeDecodedSemanticFunction({ instructions:[], architecture:'x86_64', instructionEndianness:'unknown' }),
    (error) => {
      assert.notEqual(error?.message, 'semantic-function-unsupported-instruction-endianness:unknown');
      return true;
    },
  );
});

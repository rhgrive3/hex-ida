import assert from 'node:assert/strict';
import test from 'node:test';

import { parseOperands } from '../../js/arm64.js';
import { analyzeDecodedSemanticFunction } from '../../js/analysis/semantic-function-base.js';
import { createBinaryIdFromDigest, createInstructionId, createSliceId } from '../../js/core/identity/index.js';

/**
 * Issues #5264 / #5345 (same root cause):
 * `analyzeDecodedSemanticFunction()` built the Semantic V2 pipeline from
 * address-sorted blocks but re-joined `pipeline.machineEffects` with the
 * original unsorted `input.instructions` array by index, attributing each
 * instruction's mnemonic/size/opStr metadata to a different instruction in
 * legacy rows. Entry fallbacks (`sub_<addr>` name, decompiler addr) also read
 * `input.instructions[0]` instead of the lowest-address instruction.
 *
 * The driver must behave as if the caller had passed address-sorted input:
 * analysis results are order-invariant and entry identity always comes from
 * the lowest address.
 */

const { binaryId } = { binaryId: createBinaryIdFromDigest('5264'.repeat(16).slice(0, 64)) };
const sliceId = createSliceId({ binaryId, index: 0, architecture: 'arm64' });

function withIds(rows) {
  return rows.map((row) => ({
    ...row,
    instructionId: createInstructionId({
      binaryId,
      sliceId,
      virtualAddress: BigInt(row.address),
      decodeMode: 'a64',
      decoderSemanticVersion: row.decoderSemanticVersion,
    }),
  }));
}

function decodedRows() {
  return withIds([
    { address: 0x1000n, mnemonic: 'mov', operands: 'x0, x0', size: 4, length: 4, mode: 'a64', ops: parseOperands('x0, x0'), decoderSemanticVersion: 'arm64-test-decoder-v1' },
    { address: 0x1004n, mnemonic: 'add', operands: 'x0, x0, x1', size: 4, length: 4, mode: 'a64', ops: parseOperands('x0, x0, x1'), decoderSemanticVersion: 'arm64-test-decoder-v1' },
    { address: 0x1008n, mnemonic: 'ret', operands: '', size: 4, length: 4, mode: 'a64', ops: parseOperands(''), decoderSemanticVersion: 'arm64-test-decoder-v1' },
  ]);
}

function baseInput(instructions) {
  return {
    architecture: 'arm64',
    abiId: 'aapcs64',
    platform: 'linux',
    binaryId,
    sliceId,
    decoderSemanticVersion: 'arm64-test-decoder-v1',
    instructions,
  };
}

const canonical = (value) => JSON.parse(JSON.stringify(value, (_key, entry) => typeof entry === 'bigint' ? `0x${entry.toString(16)}` : entry));

test('#5264/#5345 reversed decoded input yields the same analysis as sorted input', () => {
  const sorted = analyzeDecodedSemanticFunction(baseInput(decodedRows()));
  const reversed = analyzeDecodedSemanticFunction(baseInput(decodedRows().reverse()));
  assert.deepEqual(canonical(reversed.decompiler), canonical(sorted.decompiler));
  assert.deepEqual(canonical(reversed.pipeline.cfg), canonical(sorted.pipeline.cfg));
});

test('#5264/#5345 entry identity comes from the lowest address, not input order', () => {
  const reversed = analyzeDecodedSemanticFunction(baseInput(decodedRows().reverse()));
  assert.match(reversed.decompiler.pseudocode, /sub_1000\(/);
  assert.ok(!reversed.decompiler.pseudocode.includes('sub_1008'), 'entry must not leak the unsorted first element address');
});

test('#5264/#5345 caller array order is preserved (no in-place sort)', () => {
  const instructions = decodedRows().reverse();
  const before = instructions.map((row) => row.address);
  analyzeDecodedSemanticFunction(baseInput(instructions));
  assert.deepEqual(instructions.map((row) => row.address), before);
});

test('#5264/#5345 invalid decoded inputs still fail closed', () => {
  assert.throws(
    () => analyzeDecodedSemanticFunction(baseInput('not-an-array')),
    /semantic-function-decoded-instructions-required/,
  );
  assert.throws(
    () => analyzeDecodedSemanticFunction(baseInput([{ address: 'nope', length: 4, mnemonic: 'mov', opStr: '' }])),
    /semantic-function-instruction-address-invalid/,
  );
});

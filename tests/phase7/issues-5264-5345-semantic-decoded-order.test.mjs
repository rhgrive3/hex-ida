import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { parseOperands } from '../../js/arm64.js';
import { analyzeDecodedSemanticFunction } from '../../js/analysis/semantic-function-base.js';
import { createBinaryIdFromDigest, createInstructionId, createSliceId } from '../../js/core/identity/index.js';
import { createX86DecodedInstruction } from '../../js/targets/architecture/x86_64/decoded-instruction.js';
import { createCapstoneX86Session } from '../phase5/helpers/capstone-session.mjs';

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

function attachIds(rows, {
  identityBinaryId = binaryId,
  identitySliceId = sliceId,
  mode = 'a64',
} = {}) {
  return rows.map((row) => ({
    ...row,
    instructionId: createInstructionId({
      binaryId: identityBinaryId,
      sliceId: identitySliceId,
      virtualAddress: BigInt(row.address),
      decodeMode: mode,
      decoderSemanticVersion: row.decoderSemanticVersion,
    }),
  }));
}

function decodedRows() {
  return attachIds([
    { address: 0x1000n, mnemonic: 'mov', operands: 'x0, x0', opStr: 'x0, x0', size: 4, length: 4, mode: 'a64', ops: parseOperands('x0, x0'), decoderSemanticVersion: 'arm64-test-decoder-v1' },
    { address: 0x1004n, mnemonic: 'add', operands: 'x0, x0, x1', opStr: 'x0, x0, x1', size: 4, length: 4, mode: 'a64', ops: parseOperands('x0, x0, x1'), decoderSemanticVersion: 'arm64-test-decoder-v1' },
    { address: 0x1008n, mnemonic: 'ret', operands: '', opStr: '', size: 4, length: 4, mode: 'a64', ops: parseOperands(''), decoderSemanticVersion: 'arm64-test-decoder-v1' },
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

function presentationJoinSource() {
  return readFileSync(new URL('../../js/analysis/semantic-function-base.js', import.meta.url), 'utf8');
}

test('#5264/#5345 reversed decoded input yields the same analysis as sorted input', () => {
  const sorted = analyzeDecodedSemanticFunction(baseInput(decodedRows()));
  const reversed = analyzeDecodedSemanticFunction(baseInput(decodedRows().reverse()));
  assert.deepEqual(canonical(reversed.decompiler), canonical(sorted.decompiler));
  assert.deepEqual(canonical(reversed.pipeline.cfg), canonical(sorted.pipeline.cfg));
});

test('#5264/#5345 fixed-width decoded metadata includes distinct opStr and stays permutation-invariant', () => {
  const rows = decodedRows();
  assert.deepEqual(rows.map((row) => [row.mnemonic, row.opStr, row.length]), [
    ['mov', 'x0, x0', 4],
    ['add', 'x0, x0, x1', 4],
    ['ret', '', 4],
  ]);

  const canonicalResult = analyzeDecodedSemanticFunction(baseInput(rows));
  for (const permutation of [
    [rows[1], rows[2], rows[0]],
    [rows[2], rows[0], rows[1]],
    [...rows].reverse(),
  ]) {
    const result = analyzeDecodedSemanticFunction(baseInput(permutation));
    assert.deepEqual(canonical(result.decompiler), canonical(canonicalResult.decompiler));
    assert.deepEqual(canonical(result.pipeline.legacyV1), canonical(canonicalResult.pipeline.legacyV1));
  }
});

test('#5264/#5345 legacy presentation join is pinned to ordered identity candidates', () => {
  // The internal presentation model is intentionally not part of the public
  // analyzer snapshot. Pin the exact owner-local join that supplies its
  // mn/ops/size fields, while the E2E tests above exercise the public result.
  const source = presentationJoinSource();
  assert.match(source, /pipeline\.machineEffects\.map\(\(bundle, index\) => \[bundle\.instructionId, orderedInstructions\[index\]\]\)/);
  assert.match(source, /\(legacy\.origin\?\.instructionIds \|\| \[\]\)\.map\(\(id\) => decodedByInstructionId\.get\(id\)\)\.filter\(Boolean\)/);
  assert.match(source, /const decoded = candidates\.sort\([\s\S]*?\)\[0\] \?\? orderedInstructions\[0\]/);
  assert.match(source, /size:Number\(decoded\.length \?\? decoded\.size\)/);
  assert.match(source, /mn:String\(decoded\.mnemonic \|\| decoded\.instructionFamily \|\| ''\)/);
  assert.match(source, /ops:String\(decoded\.opStr \|\| ''\)/);
});

test('#5264/#5345 variable-length x86 metadata remains order-invariant', async () => {
  const capstone = await createCapstoneX86Session();
  try {
    // nop (1), add rax, 1 (4), ret (1): distinct lengths make an index swap
    // observable at the presentation-geometry boundary guarded above.
    const rows = capstone.decode(Uint8Array.from([
      0x90,
      0x48, 0x83, 0xc0, 0x01,
      0xc3,
    ]), 0x2000n).map((row) => createX86DecodedInstruction(row));
    assert.ok(new Set(rows.map((row) => Number(row.length ?? row.size))).size > 1, 'fixture must contain distinct instruction sizes');
    assert.ok(rows.some((row) => typeof row.opStr === 'string' && row.opStr.length > 0), 'fixture must carry operand text');

    const x86BinaryId = createBinaryIdFromDigest('5345'.repeat(16).slice(0, 64));
    const x86SliceId = createSliceId({ binaryId: x86BinaryId, index: 0, architecture: 'x86_64' });
    const instructions = attachIds(rows, {
      identityBinaryId: x86BinaryId,
      identitySliceId: x86SliceId,
      mode: 'long-64',
    });
    const input = (items) => ({
      architecture: 'x86_64',
      abiId: 'sysv-amd64',
      platform: 'linux',
      binaryId: x86BinaryId,
      sliceId: x86SliceId,
      decoderSemanticVersion: rows[0].decoderSemanticVersion,
      instructions: items,
    });

    const sorted = analyzeDecodedSemanticFunction(input(instructions));
    const reversed = analyzeDecodedSemanticFunction(input([...instructions].reverse()));
    assert.deepEqual(canonical(reversed.decompiler), canonical(sorted.decompiler));
    assert.deepEqual(canonical(reversed.pipeline.legacyV1), canonical(sorted.pipeline.legacyV1));
  } finally {
    capstone.close();
  }
});

test('#5264/#5345 duplicate instruction addresses remain rejected', () => {
  const rows = decodedRows();
  const duplicate = [
    rows[0],
    { ...rows[1], address: rows[0].address },
    rows[2],
  ];
  assert.throws(
    () => analyzeDecodedSemanticFunction(baseInput(duplicate)),
    /semantic-function-duplicate-instruction-address/,
  );
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

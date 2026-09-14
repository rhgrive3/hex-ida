import assert from 'node:assert/strict';
import { analyzeDataFlow, buildSemanticModel, makeInstruction } from '../../js/blocks.js';

const BASE = 0x100000n;

function model(lines) {
  const raw = lines.map((line, row) => {
    const split = line.indexOf(' ');
    return {
      row,
      address: BASE + BigInt(row * 4),
      mn: split < 0 ? line : line.slice(0, split),
      ops: split < 0 ? '' : line.slice(split + 1),
    };
  });
  return buildSemanticModel(raw, {
    startRow: 0,
    endRow: raw.length - 1,
    rowOfAddress: () => null,
  });
}

function addresses(result) {
  return result.addressRefs.map((ref) => ({ row: ref.row, addr: ref.addr, load: ref.load === true }));
}

// The unshifted form remains the established exact reconstruction.
{
  const result = model([
    'adrp x0, #0x1000',
    'add x0, x0, #4',
  ]);
  assert.deepEqual(addresses(result), [{ row: 1, addr: 0x1004n, load: false }]);

  const explicitZeroShift = model([
    'adrp x0, #0x1000',
    'add x0, x0, #4, lsl #0',
  ]);
  assert.deepEqual(addresses(explicitZeroShift), [{ row: 1, addr: 0x1004n, load: false }]);
}

// ADD (immediate) LSL #12 uses the effective immediate, including in-place
// and different-destination forms. A later load must inherit that address.
{
  const inPlace = model([
    'adrp x0, #0x1000',
    'add x0, x0, #1, lsl #12',
    'ldr x2, [x0, #0]',
  ]);
  assert.deepEqual(addresses(inPlace), [
    { row: 1, addr: 0x2000n, load: false },
    { row: 2, addr: 0x2000n, load: true },
  ]);

  const differentDestination = model([
    'adrp x0, #0x1000',
    'add x1, x0, #1, lsl #12',
    'ldr x2, [x1, #8]',
  ]);
  assert.deepEqual(addresses(differentDestination), [
    { row: 1, addr: 0x2000n, load: false },
    { row: 2, addr: 0x2008n, load: true },
  ]);
}

// Unsupported modifiers must not be laundered into an exact address or a
// downstream memory provenance claim.
for (const modifier of ['lsl #1', 'lsr #12']) {
  const result = model([
    'adrp x0, #0x1000',
    `add x0, x0, #1, ${modifier}`,
    'ldr x2, [x0, #0]',
  ]);
  assert.deepEqual(result.addressRefs, [], `${modifier} must remain unknown`);

  const differentDestination = model([
    'adrp x0, #0x1000',
    `add x1, x0, #1, ${modifier}`,
    'ldr x2, [x1, #8]',
  ]);
  assert.deepEqual(differentDestination.addressRefs, [], `${modifier} must remain unknown for a different destination`);
}

// Structured operands with a missing immediate value must remain safe and
// unknown before any shifted-immediate arithmetic is attempted.
for (const missingValue of [null, undefined]) {
  const adrp = makeInstruction({ row: 0, address: BASE, mn: 'adrp', ops: 'x0, #0x1000' });
  const add = makeInstruction({ row: 1, address: BASE + 4n, mn: 'add', ops: 'x0, x0, #1, lsl #12' });
  add.ops[2].value = missingValue;
  let result;
  assert.doesNotThrow(() => { result = analyzeDataFlow([adrp, add]); });
  assert.deepEqual(result.addressRefs, [], `missing immediate ${String(missingValue)} must remain unknown`);
}

console.log('issue #3888 ADRP+ADD shifted-immediate reconstruction: PASS');

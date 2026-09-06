import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeRiscv64InstructionWord } from '../../../js/targets/architecture/riscv64/instruction-word.js';

function decodeWord(word) {
  return decodeRiscv64InstructionWord(Uint8Array.of(
    word & 0xff,
    (word >>> 8) & 0xff,
    (word >>> 16) & 0xff,
    (word >>> 24) & 0xff,
  ));
}

function assertFence(decoded, { predecessor, successor, fenceMode }) {
  assert.equal(decoded.supported, true);
  assert.equal(decoded.op, 'fence');
  assert.equal(decoded.predecessor, predecessor);
  assert.equal(decoded.successor, successor);
  assert.equal(decoded.fenceMode, fenceMode);
}

test('RISC-V FENCE ignores reserved rd and rs1 fields for forward compatibility', () => {
  assertFence(decodeWord(0x0330008f), {
    predecessor:0b0011,
    successor:0b0011,
    fenceMode:0,
  });
  assertFence(decodeWord(0x0330800f), {
    predecessor:0b0011,
    successor:0b0011,
    fenceMode:0,
  });
});

test('RISC-V FENCE normalizes unsupported fm values to ordinary fence semantics', () => {
  assertFence(decodeWord(0x1330000f), {
    predecessor:0b0011,
    successor:0b0011,
    fenceMode:0,
  });
  assertFence(decodeWord(0x8110000f), {
    predecessor:0b0001,
    successor:0b0001,
    fenceMode:0,
  });
});

test('RISC-V FENCE.TSO remains exact even when reserved register fields are non-zero', () => {
  assertFence(decodeWord(0x8330008f), {
    predecessor:0b0011,
    successor:0b0011,
    fenceMode:0b1000,
  });
});

test('RISC-V canonical FENCE HINT encodings retain architectural no-op classification', () => {
  const pause = decodeWord(0x0100000f);
  assert.equal(pause.supported, true);
  assert.equal(pause.op, 'hint');
  assert.equal(pause.architecturalNoOp, true);
  assert.equal(pause.hintKind, 'pause');
  assert.equal(pause.predecessor, 0b0001);
  assert.equal(pause.successor, 0);
  assert.equal(pause.fenceMode, 0);

  const emptyPredecessor = decodeWord(0x0010000f);
  assert.equal(emptyPredecessor.supported, true);
  assert.equal(emptyPredecessor.op, 'hint');
  assert.equal(emptyPredecessor.architecturalNoOp, true);
  assert.equal(emptyPredecessor.hintKind, 'fence');
  assert.equal(emptyPredecessor.predecessor, 0);
  assert.equal(emptyPredecessor.successor, 0b0001);
  assert.equal(emptyPredecessor.fenceMode, 0);
});

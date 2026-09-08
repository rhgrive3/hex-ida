import assert from 'node:assert/strict';
import test from 'node:test';

import { createX86DecodedInstruction } from '../../js/targets/architecture/x86_64/decoded-instruction.js';

// REX prefixes occupy exactly 0x40-0x4F (Intel SDM Vol. 2A). Any other byte
// is not a REX prefix and must never be retained as canonical
// detail.prefixes.rex authority (#6037).

const base = {
  address: 0x1000n,
  length: 1,
  rawBytes: Uint8Array.from([0x90]),
  mode: 'long-64',
  instructionCode: 1,
  instructionFamily: 'nop',
  instructionId: 'i0',
  detail: { operandCount: 0, operands: [] },
};

const withRex = (rex) => createX86DecodedInstruction({
  ...base,
  detail: { ...base.detail, prefixes: { legacy: [], rex, vector: null } },
});

test('#6037: every canonical REX byte 0x40-0x4F is accepted', () => {
  for (let rex = 0x40; rex <= 0x4f; rex++) {
    assert.equal(withRex(rex).detail.prefixes.rex, rex);
  }
});

test('#6037: non-REX bytes are rejected as prefix authority', () => {
  for (const rex of [0x00, 0x01, 0x3f, 0x50, 0x90, 0xf0, 0xff]) {
    assert.throws(
      () => withRex(rex),
      (error) => error?.message === 'x86-decoded-instruction-invalid-rex',
      `rex ${rex} must not become canonical prefix authority`,
    );
  }
});

test('#6037: an absent rex stays absent', () => {
  const decoded = createX86DecodedInstruction({
    ...base,
    detail: { ...base.detail, prefixes: { legacy: [], rex: null, vector: null } },
  });
  assert.equal(decoded.detail.prefixes.rex, null);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { createRiscv64DecodedInstruction } from '../js/targets/architecture/riscv64/decoded-instruction.js';

const rawBytes = Uint8Array.from([0x13, 0x00, 0x00, 0x00]);
const base = { address: 0x1000n, size: 4, rawBytes, mode: 'rv64im' };

test('#5990 primitive string identity fields are preserved', () => {
  const insn = createRiscv64DecodedInstruction({
    ...base, instructionId: 'insn:1', isaIdentity: 'rv64im', isaEvidence: 'evidence:1',
  });
  assert.equal(insn.instructionId, 'insn:1');
  assert.equal(insn.isaIdentity, 'rv64im');
  assert.equal(insn.isaEvidence, 'evidence:1');
});

test('#5990 structured identity fields are rejected, not String-coerced', () => {
  assert.throws(
    () => createRiscv64DecodedInstruction({ ...base, instructionId: ['insn:1'] }),
    (e) => e instanceof TypeError && /invalid-instruction-id/.test(e.message),
  );
  assert.throws(
    () => createRiscv64DecodedInstruction({ ...base, isaIdentity: ['rv64im'] }),
    (e) => e instanceof TypeError && /invalid-isa-identity/.test(e.message),
  );
  assert.throws(
    () => createRiscv64DecodedInstruction({ ...base, isaEvidence: ['evidence:1'] }),
    (e) => e instanceof TypeError && /invalid-isa-evidence/.test(e.message),
  );
  assert.throws(
    () => createRiscv64DecodedInstruction({ ...base, instructionId: { toString: () => 'insn:1' } }),
    (e) => e instanceof TypeError,
  );
});

test('#5990 optional identity fields stay optional; empty strings are invalid tokens', () => {
  const without = createRiscv64DecodedInstruction(base);
  assert.equal('instructionId' in without, false);
  assert.equal('isaIdentity' in without, false);
  assert.equal('isaEvidence' in without, false);
  assert.throws(() => createRiscv64DecodedInstruction({ ...base, instructionId: '  ' }), TypeError);
});

test('#5990 existing strict validation on bytes/size/mode/alignment is unchanged', () => {
  assert.throws(() => createRiscv64DecodedInstruction({ ...base, size: 3 }), TypeError);
  assert.throws(() => createRiscv64DecodedInstruction({ ...base, mode: 'rv64im', instructionAlignment: 2 }), TypeError);
  const display = createRiscv64DecodedInstruction({ ...base, mnemonic: 42 });
  assert.equal(display.mnemonic, '42', 'display-only fields keep their contract');
});

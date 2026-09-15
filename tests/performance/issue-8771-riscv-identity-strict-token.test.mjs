import test from 'node:test';
import assert from 'node:assert/strict';
import { createRiscv64DecodedInstruction } from '../../js/targets/architecture/riscv64/decoded-instruction.js';

// #8771 (#5990 regression): the canonical RISC-V decoded-instruction boundary must
// treat instructionId / isaIdentity / isaEvidence as strict semantic tokens. Under
// the regressed `String(...)` normalization an Array, a custom toString() object, or
// a whitespace-only value was laundered into a valid authority-bearing identity.

const rawBytes = Uint8Array.from([0x13, 0x00, 0x00, 0x00]);
const base = { address: 0x1000n, size: 4, rawBytes, mode: 'rv64im' };

test('#8771 array / toString-object / empty identity tokens are rejected, not coerced', () => {
  assert.throws(() => createRiscv64DecodedInstruction({ ...base, instructionId: ['insn:1'] }),
    (e) => e instanceof TypeError && /invalid-instruction-id/.test(e.message));
  assert.throws(() => createRiscv64DecodedInstruction({ ...base, isaIdentity: ['rv64im'] }),
    (e) => e instanceof TypeError && /invalid-isa-identity/.test(e.message));
  assert.throws(() => createRiscv64DecodedInstruction({ ...base, isaEvidence: { toString: () => 'evidence:1' } }),
    (e) => e instanceof TypeError && /invalid-isa-evidence/.test(e.message));
  assert.throws(() => createRiscv64DecodedInstruction({ ...base, instructionId: '   ' }),
    (e) => e instanceof TypeError && /invalid-instruction-id/.test(e.message));
});

test('#8771 valid structured string identities are preserved and remain optional', () => {
  const insn = createRiscv64DecodedInstruction({
    ...base, instructionId: 'insn:1', isaIdentity: 'rv64im', isaEvidence: 'evidence:1',
  });
  assert.equal(insn.instructionId, 'insn:1');
  assert.equal(insn.isaIdentity, 'rv64im');
  assert.equal(insn.isaEvidence, 'evidence:1');
  const absent = createRiscv64DecodedInstruction(base);
  assert.equal('instructionId' in absent, false);
  assert.equal('isaIdentity' in absent, false);
  assert.equal('isaEvidence' in absent, false);
});

test('#8771 display-only fields keep their coercion contract (mnemonic/opStr unchanged)', () => {
  const display = createRiscv64DecodedInstruction({ ...base, mnemonic: 42, opStr: 7 });
  assert.equal(display.mnemonic, '42');
  assert.equal(display.opStr, '7');
});

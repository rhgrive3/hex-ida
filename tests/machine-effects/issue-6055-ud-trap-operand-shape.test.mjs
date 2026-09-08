import assert from 'node:assert/strict';
import { liftX86MachineEffects } from '../../js/targets/architecture/x86_64/effects/index.js';

let sequence = 0;
function liftTrap(family, bytes, operands = []) {
  return liftX86MachineEffects({
    address: 0x1000n,
    length: bytes.length,
    rawBytes: Uint8Array.from(bytes),
    mode: 'long-64',
    instructionId: `ud-operand-shape-${++sequence}`,
    instructionCode: 1,
    instructionFamily: family,
    mnemonic: family,
    detailAvailable: true,
    detailStatus: 'complete',
    detail: {
      addressSizeBits: 64,
      operandCount: operands.length,
      operands,
      implicitReads: [],
      implicitWrites: [],
    },
  }, { instructionId: `ud-operand-shape-${sequence}` });
}
const reg = (id) => ({ type: 'register', access: 'unknown', widthBits: 32, registerId: id });

// #6055: UD0/UD1 have the canonical 2-operand ModR/M form (UD0 r32, r/m32 /
// UD1 r32, r/m32). The generic zero-operand trap gate demoted every well-
// formed UD0/UD1 to operand-shape-unmodelled before the always-#UD
// trapEffect could run.
for (const [family, bytes] of [
  ['ud0', [0x0f, 0xff, 0xc0]],
  ['ud1', [0x0f, 0xb9, 0xc0]],
]) {
  const bundle = liftTrap(family, bytes, [reg('eax'), reg('eax')]);
  assert.equal(bundle?.completeness, 'exact', `${family}: ${bundle?.unknownEffects?.reason}`);
  assert.equal(bundle.controlEffect.kind, 'trap');
  assert.equal(bundle.controlEffect.reason, `x86-${family}-invalid-opcode`);
  assert.ok(bundle.possibleFaults.some((fault) => fault.kind === 'invalid-opcode'), `${family}: #UD fault required`);
  // The ModR/M operands are #UD hint text, never architectural data accesses.
  assert.equal(bundle.operations.some((operation) => operation.kind === 'register-read'), false, `${family}: operands must not become register reads`);
}

// UD2 stays zero-operand.
{
  const bundle = liftTrap('ud2', [0x0f, 0x0b], []);
  assert.equal(bundle?.completeness, 'exact');
  assert.equal(bundle.controlEffect.kind, 'trap');
  assert.ok(bundle.possibleFaults.some((fault) => fault.kind === 'invalid-opcode'));
}

// Non-canonical shapes stay fail-closed.
{
  const oneOperand = liftTrap('ud0', [0x0f, 0xff, 0xc0], [reg('eax')]);
  assert.equal(oneOperand?.completeness, 'partial');
  assert.equal(oneOperand.unknownEffects?.reason, 'x86-ud0-operand-shape-unmodelled');
  const zeroOperandUd0 = liftTrap('ud0', [0x0f, 0xff, 0xc0], []);
  assert.equal(zeroOperandUd0?.completeness, 'partial');
  assert.equal(zeroOperandUd0.unknownEffects?.reason, 'x86-ud1-operand-shape-unmodelled'.replace('ud1', 'ud0'));
  const ud2WithOperand = liftTrap('ud2', [0x0f, 0x0b], [reg('eax')]);
  assert.equal(ud2WithOperand?.completeness, 'partial');
  assert.equal(ud2WithOperand.unknownEffects?.reason, 'x86-ud2-operand-shape-unmodelled');
}

console.log('x86 UD0/UD1 2-operand #UD trap shape (#6055): PASS');

// Regression for #6025: the RISC-V control-effects lifter treated any
// `jalr x0, <RAS hint register>` as a semantic `return`. The register numbers
// are only return-address-stack prediction hints; the canonical procedure
// return is `jalr x0, x1, 0`. A nonzero immediate changes the target to
// (rs1+imm)&~1, so e.g. `jalr x0, x1, 4` and `jalr x0, x5, 8` are indirect
// jumps, never returns.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createRiscv64DecodedInstruction } from '../../js/targets/architecture/riscv64/decoded-instruction.js';
import { liftRiscv64ControlEffects } from '../../js/targets/architecture/riscv64/effects/control.js';

function bytes32(word) {
  const value = Number(word) >>> 0;
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}
function encodeJalr(rd, rs1, imm) {
  return (((imm & 0xfff) << 20) | ((rs1 & 0x1f) << 15) | ((rd & 0x1f) << 7) | 0x67) >>> 0;
}
function decoded(word) {
  return createRiscv64DecodedInstruction({
    address: 0x1000n,
    size: 4,
    rawBytes: bytes32(word),
    mode: 'rv64imc',
    instructionId: 'jalr',
    origin: { instructionIds: ['jalr'] },
  });
}

test('#6025 canonical ret (jalr x0, x1, 0) stays a return', () => {
  const effects = liftRiscv64ControlEffects(decoded(encodeJalr(0, 1, 0)));
  assert.equal(effects.controlEffect.kind, 'return');
});

test('#6025 a nonzero immediate makes jalr x0, x1 an indirect jump, not a return', () => {
  const effects = liftRiscv64ControlEffects(decoded(encodeJalr(0, 1, 4)));
  assert.equal(effects.controlEffect.kind, 'indirect');
  const target = effects.controlEffect.target;
  assert.ok(target && typeof target === 'object' && target.valueType?.kind === 'bitvector',
    'the target must remain the computed (rs1+imm)&~1 value expression, not a return-address alias');
});

test('#6025 the alternate hint register x5 with a nonzero offset is indirect too', () => {
  const effects = liftRiscv64ControlEffects(decoded(encodeJalr(0, 5, 8)));
  assert.equal(effects.controlEffect.kind, 'indirect');
});

test('#6025 a linked jalr through a hint register is still a call', () => {
  const effects = liftRiscv64ControlEffects(decoded(encodeJalr(1, 5, 0)));
  assert.equal(effects.controlEffect.kind, 'call');
});

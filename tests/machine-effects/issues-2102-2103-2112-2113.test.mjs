import assert from 'node:assert/strict';
import { parseOperands } from '../../js/arm64.js';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

function lift(mnemonic, operands, id = `${mnemonic}:${operands}`) {
  return liftArm64MachineEffects({ instructionId:id, mnemonic, ops:parseOperands(operands), mode:'a64' });
}
function assertRejected(mnemonic, operands) {
  const bundle = lift(mnemonic, operands);
  assert.equal(bundle.completeness, 'partial', `${mnemonic} ${operands}`);
  assert.equal(bundle.operations.filter((op) => op.kind !== 'unknown').length, 0, `${mnemonic} invalid shape emitted exact operations`);
}

for (const [mnemonic, valid, extra, missing] of [
  ['lsl','x0, x1, #1','x0, x1, #1, x2','x0, x1'],
  ['clz','x0, x1','x0, x1, x2','x0'],
  ['csel','x0, x1, x2, eq','x0, x1, x2, eq, x3','x0, x1, x2'],
  ['cset','x0, eq','x0, eq, x1','x0'],
  ['cinc','x0, x1, eq','x0, x1, eq, x2','x0, x1'],
  ['extr','x0, x1, x2, #8','x0, x1, x2, #8, x3','x0, x1, x2'],
]) {
  assert.notEqual(lift(mnemonic, valid).completeness, 'partial', `${mnemonic} valid shape regressed`);
  assertRejected(mnemonic, extra);
  assertRejected(mnemonic, missing);
}

for (const [mnemonic, valid, extra, missing] of [
  ['ubfx','x0, x1, #8, #8','x0, x1, #8, #8, x2','x0, x1, #8'],
  ['bfc','x0, #8, #8','x0, #8, #8, x1','x0, #8'],
  ['ubfm','x0, x1, #8, #15','x0, x1, #8, #15, x2','x0, x1, #8'],
]) {
  assert.notEqual(lift(mnemonic, valid).completeness, 'partial', `${mnemonic} valid shape regressed`);
  assertRejected(mnemonic, extra);
  assertRejected(mnemonic, missing);
}

for (const [mnemonic, valid, extra, missing] of [
  ['fmov','d0, d1','d0, d1, d2','d0'],
  ['fcsel','d0, d1, d2, eq','d0, d1, d2, eq, d3','d0, d1, d2'],
  ['fcmp','d0, d1','d0, d1, d2','d0'],
  ['fccmp','d0, d1, #0, eq','d0, d1, #0, eq, d2','d0, d1, #0'],
]) {
  assert.notEqual(lift(mnemonic, valid).completeness, 'partial', `${mnemonic} valid shape regressed`);
  assertRejected(mnemonic, extra);
  assertRejected(mnemonic, missing);
}

for (const [mnemonic, valid, extra] of [
  ['fadd','d0, d1, d2','d0, d1, d2, eq'],
  ['fmadd','d0, d1, d2, d3','d0, d1, d2, d3, eq'],
  ['fcvt','s0, d1','s0, d1, eq'],
  ['scvtf','d0, x1','d0, x1, eq'],
  ['frintn','d0, d1','d0, d1, eq'],
]) {
  assert.notEqual(lift(mnemonic, valid).completeness, 'partial', `${mnemonic} valid shape regressed`);
  assertRejected(mnemonic, extra);
}
assert.notEqual(lift('scvtf','d0, x1, #64').completeness, 'partial', 'valid fixed-point conversion regressed');
assertRejected('fadd','d0, d1, d2, #1');

console.log('issues #2102/#2103/#2112/#2113 regressions: PASS');

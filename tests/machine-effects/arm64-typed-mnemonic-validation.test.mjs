import assert from 'node:assert/strict';
import { parseOperands } from '../../js/arm64.js';
import { ARM64_ARCHITECTURE, ARM64E_ARCHITECTURE } from '../../js/targets/architecture/index.js';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

const origin = (id) => ({ instructionIds:[id] });

function arm64(id, mnemonic) {
  const operands = 'x0, x1, x2';
  return {
    instructionId:id,
    mnemonic,
    operands,
    mode:'a64',
    ops:parseOperands(operands),
    origin:origin(id),
  };
}

function arm64e(id, mnemonic, opcode = undefined) {
  const operands = 'x0, x1';
  return {
    instructionId:id,
    mnemonic,
    ...(opcode === undefined ? {} : { opcode }),
    operands,
    mode:'a64',
    ops:parseOperands(operands),
    origin:origin(id),
  };
}

const add = liftArm64MachineEffects(arm64('typed-add', ' ADD '));
assert.ok(add, 'canonical string mnemonic must remain supported');
assert.equal(add.completeness, 'exact');
assert.ok(add.operations.length > 0, 'canonical ADD must retain definite effects');

for (const [label, malformed] of [
  ['array', ['add']],
  ['object', { toString(){ return 'add'; } }],
  ['number', 1],
  ['boolean', true],
]) {
  const bundle = liftArm64MachineEffects(arm64(`bad-add-${label}`, malformed));
  assert.equal(bundle, null, `${label} mnemonic must not be coerced into ADD`);
}

assert.equal(ARM64_ARCHITECTURE.classifyControlFlow({ mnemonic:' BL ' }), 'call');
assert.equal(ARM64_ARCHITECTURE.classifyControlFlow({ mnemonic:' RET ' }), 'return');
assert.equal(ARM64_ARCHITECTURE.classifyControlFlow({ mnemonic:['bl'] }), 'fallthrough');
assert.equal(ARM64E_ARCHITECTURE.classifyControlFlow({ mnemonic:{ toString(){ return 'retaa'; } } }), 'fallthrough');

const pacia = ARM64E_ARCHITECTURE.liftExact(arm64e('typed-pacia', ' PACIA '));
assert.ok(pacia, 'canonical PACIA string must remain supported');
assert.ok(pacia.operations.some((operation) => operation.kind === 'intrinsic'), 'canonical PACIA must retain PAuth semantics');

for (const [label, malformed] of [
  ['array', ['pacia']],
  ['object', { toString(){ return 'pacia'; } }],
  ['number', 7],
  ['boolean', true],
]) {
  const bundle = ARM64E_ARCHITECTURE.liftExact(arm64e(`bad-pacia-${label}`, malformed));
  assert.equal(bundle, null, `${label} mnemonic must not be coerced into PACIA`);
}

// A malformed explicit mnemonic is authoritative malformed evidence. It must
// not be laundered through a separately supplied legal opcode fallback.
assert.equal(
  ARM64E_ARCHITECTURE.liftExact(arm64e('bad-mnemonic-good-opcode', ['not-a-string'], 'pacia')),
  null,
  'non-string mnemonic must not fall back to a legal opcode',
);

// Preserve the legacy adapter boundary where mnemonic is absent and a
// canonical string opcode is the only identity supplied.
const opcodeOperands = 'x0, x1';
const opcodeOnly = ARM64E_ARCHITECTURE.liftExact({
  instructionId:'opcode-only-pacia',
  opcode:'PACIA',
  operands:opcodeOperands,
  mode:'a64',
  ops:parseOperands(opcodeOperands),
  origin:origin('opcode-only-pacia'),
});
assert.ok(opcodeOnly, 'string opcode fallback must remain supported when mnemonic is absent');

console.log('ARM64 typed mnemonic authority regression PASS');

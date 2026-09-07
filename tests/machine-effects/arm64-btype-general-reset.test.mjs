import assert from 'node:assert/strict';
import { parseOperands } from '../../js/arm64.js';
import { ARM64E_ARCHITECTURE } from '../../js/targets/architecture/index.js';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

let sequence = 0;
function instruction(mnemonic, operands = '', extra = {}) {
  sequence += 1;
  const instructionId = `arm64-btype-general-${sequence}`;
  return {
    instructionId,
    mnemonic,
    operands,
    ops:parseOperands(operands),
    mode:'a64',
    address:0x8000n + BigInt(sequence * 4),
    origin:{ instructionIds:[instructionId] },
    ...extra,
  };
}

function lift(mnemonic, operands = '', extra = {}, context = {}) {
  return liftArm64MachineEffects(instruction(mnemonic, operands, extra), context);
}

function liftArm64e(mnemonic, operands = '', extra = {}, context = {}) {
  return ARM64E_ARCHITECTURE.liftExact(instruction(mnemonic, operands, { mode:'arm64e', ...extra }), context);
}

function btypeWrites(bundle) {
  return bundle.operations.filter((operation) => operation.kind === 'register-write' && operation.register?.registerId === 'pstate.btype');
}

for (const [mnemonic, operands] of [
  ['nop', ''],
  ['add', 'x0, x1, x2'],
  ['ldr', 'x0, [x1]'],
]) {
  const bundle = lift(mnemonic, operands);
  assert.ok(bundle, `${mnemonic}: instruction must lift`);
  const writes = btypeWrites(bundle);
  assert.equal(writes.length, 1, `${mnemonic}: exactly one BTYPE post-state write`);
  assert.equal(writes[0].value.value, '0', `${mnemonic}: BTYPE resets to zero`);
}

{
  const bundle = lift('bti', 'c', {}, { btiGuardedPage:true });
  assert.ok(bundle, 'BTI C must lift');
  const writes = btypeWrites(bundle);
  assert.equal(writes.length, 1, 'BTI C has one BTYPE post-state write');
  assert.equal(writes[0].value.value, '0', 'BTI C resets BTYPE after compatibility evaluation');
}

{
  const bundle = lift('br', 'x16');
  const writes = btypeWrites(bundle);
  assert.equal(writes.length, 1, 'BR x16 keeps a single producer write');
  assert.equal(writes[0].value.value, '1', 'BR x16 producer semantics remain unchanged');
}

{
  const bundle = lift('blr', 'x0');
  const writes = btypeWrites(bundle);
  assert.equal(writes.length, 1, 'BLR keeps a single producer write');
  assert.equal(writes[0].value.value, '2', 'BLR producer semantics remain unchanged');
}

{
  const malformed = lift('add', 'x0, x1, #0x1000');
  assert.equal(malformed?.completeness, 'partial');
  assert.equal(malformed?.metadata?.failClosed, true);
  assert.equal(btypeWrites(malformed).length, 0, 'fail-closed unencodable input must not gain synthetic architectural state');
}

for (const mnemonic of ['paciasp', 'autiasp', 'xpaclri']) {
  const bundle = liftArm64e(mnemonic);
  assert.ok(bundle, `${mnemonic}: ARM64e instruction must lift`);
  const writes = btypeWrites(bundle);
  assert.equal(writes.length, 1, `${mnemonic}: ARM64e-specific non-control instruction resets BTYPE`);
  assert.equal(writes[0].value.value, '0', `${mnemonic}: ARM64e BTYPE reset value is zero`);
}

{
  const bundle = liftArm64e('braaz', 'x16');
  const writes = btypeWrites(bundle);
  assert.equal(writes.length, 1, 'BRAAZ keeps one authenticated indirect-branch BTYPE producer write');
  assert.equal(writes[0].value.value, '1', 'BRAAZ x16 producer semantics are not replaced by the general reset');
}

console.log('arm64-btype-general-reset: PASS');

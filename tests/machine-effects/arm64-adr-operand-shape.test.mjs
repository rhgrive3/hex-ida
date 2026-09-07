import assert from 'node:assert/strict';
import { parseOperands } from '../../js/arm64.js';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';
import { liftArm64IntegerEffects } from '../../js/targets/architecture/arm64/effects/integer.js';

let sequence = 0;
function record(mnemonic, operands, { address=0x1000n, target=null, mutate=null } = {}) {
  const ops = parseOperands(operands);
  mutate?.(ops);
  const pcRelTarget = target ?? (ops[1]?.value ?? null);
  const instructionId = `arm64-adr-shape-${++sequence}`;
  return { instructionId, mnemonic, operands, ops, mode:'a64', address, pcRelTarget,
    origin:{instructionIds:[instructionId]} };
}
function assertExact(effect, label) {
  assert.ok(effect, `${label}: effect required`);
  assert.notEqual(effect.completeness, 'partial', `${label}: legal encoding must stay exact`);
}
function assertClosed(effect, label) {
  assert.ok(effect, `${label}: fail-closed effect required`);
  assert.equal(effect.completeness, 'partial', `${label}: invalid encoding must be partial`);
  assert.equal(effect.operations.length, 0, `${label}: invalid encoding must emit zero definite operations`);
}

for (const input of [
  record('adr','x0, #0x1004'),
  record('adr','xzr, #0x1004'),
  record('adrp','x1, #0x2000'),
  record('adr','x2, #0xfffff',{address:0n,target:(1n<<20n)-1n}),
  record('adrp','x3, #0xfffff000',{address:0n,target:((1n<<20n)-1n)*4096n}),
]) assertExact(liftArm64MachineEffects(input), `${input.mnemonic} top-level legal`);

const invalid = [
  record('adr','sp, #0x1004'),
  record('adrp','w0, #0x2000'),
  record('adr','x0, #0x1004, x1'),
  record('adr','x0, #0x1004',{mutate:(ops)=>{ops[0].shift={op:'lsl',amount:1};}}),
  record('adr','x0, #0x1004',{mutate:(ops)=>{ops[1].extend={op:'uxtw',amount:0};}}),
  record('adrp','x0, #0x2000',{mutate:(ops)=>{ops[1].shift={op:'lsl',amount:12};}}),
  record('adr','x0, #0x1008',{address:0x1000n,target:0x1004n}),
  record('adr','x0, #0x200000',{address:0n,target:1n<<20n}),
  record('adrp','x0, #0x2001',{address:0n,target:0x2001n}),
  record('adrp','x0, #0x1000',{address:0n,target:(1n<<20n)*4096n}),
];
for (const input of invalid) {
  assertClosed(liftArm64MachineEffects(input), `${input.mnemonic} top-level invalid`);
  assertClosed(liftArm64IntegerEffects(input), `${input.mnemonic} direct integer invalid`);
}
console.log('arm64 ADR/ADRP operand shape validation: PASS');

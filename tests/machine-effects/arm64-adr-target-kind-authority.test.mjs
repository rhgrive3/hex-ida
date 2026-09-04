import assert from 'node:assert/strict';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';
import { liftArm64IntegerEffects } from '../../js/targets/architecture/arm64/effects/integer.js';

let sequence = 0;
function record({ mnemonic='adr', kind='imm', value=0x1004n, text='#0x1004', address=0x1000n, target=0x1004n } = {}) {
  const instructionId = `arm64-adr-target-kind-${++sequence}`;
  const targetOperand = { k:kind, text };
  if (value !== undefined) targetOperand.value = value;
  return {
    instructionId,
    mnemonic,
    mode:'a64',
    address,
    pcRelTarget:target,
    ops:[
      { k:'reg', cls:'gp', num:0, bits:64, text:'x0' },
      targetOperand,
    ],
    origin:{ instructionIds:[instructionId] },
  };
}

function assertExact(effect, label) {
  assert.ok(effect, `${label}: effect required`);
  assert.notEqual(effect.completeness, 'partial', `${label}: canonical target kind must remain exact`);
}

function assertClosed(effect, label) {
  assert.ok(effect, `${label}: fail-closed effect required`);
  assert.equal(effect.completeness, 'partial', `${label}: malformed target kind must be partial`);
  assert.equal(effect.operations.length, 0, `${label}: malformed target kind must emit zero definite operations`);
}

const canonical = [
  record(),
  record({ kind:'other', value:undefined, text:'0x1004' }),
  record({ mnemonic:'adrp', kind:'imm', value:0x2000n, text:'#0x2000', target:0x2000n }),
  record({ mnemonic:'adrp', kind:'other', value:undefined, text:'0x2000', target:0x2000n }),
];
for (const input of canonical) {
  assertExact(liftArm64MachineEffects(input), `${input.mnemonic} top-level canonical`);
  assertExact(liftArm64IntegerEffects(input), `${input.mnemonic} integer canonical`);
}

const malformed = [
  record({ kind:['imm'] }),
  record({ kind:['other'], value:undefined, text:'0x1004' }),
  record({ kind:{ toString() { return 'other'; } }, value:undefined, text:'0x1004' }),
  record({ kind:true }),
  record({ kind:1 }),
  // Before #4868, String(['imm']) passed the shape gate while the strict
  // immediate-evidence check was skipped, laundering this contradiction.
  record({ kind:['imm'], value:0x2000n, text:'#0x2000', target:0x1004n }),
  record({ mnemonic:'adrp', kind:['other'], value:undefined, text:'0x2000', target:0x2000n }),
];
for (const input of malformed) {
  assertClosed(liftArm64MachineEffects(input), `${input.mnemonic} top-level malformed`);
  assertClosed(liftArm64IntegerEffects(input), `${input.mnemonic} integer malformed`);
}

const canonicalMismatch = record({ kind:'imm', value:0x2000n, text:'#0x2000', target:0x1004n });
assertClosed(liftArm64MachineEffects(canonicalMismatch), 'ADR top-level canonical evidence mismatch');
assertClosed(liftArm64IntegerEffects(canonicalMismatch), 'ADR integer canonical evidence mismatch');

console.log('arm64 ADR/ADRP target-kind authority validation: PASS');

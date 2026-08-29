import assert from 'node:assert/strict';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';
import { createArm64EffectContext } from '../../js/targets/architecture/arm64/effects/common.js';

let sequence = 0;
const gp = (num, bits = 64) => ({ k:'reg', cls:'gp', num, bits, text:`${bits === 32 ? 'w' : 'x'}${num}` });
const sp = (num = 31, bits = 64) => ({ k:'reg', cls:'sp', num, bits, text:bits === 32 ? 'wsp' : 'sp' });
const zr = (num = 31, bits = 64) => ({ k:'reg', cls:'zr', num, bits, text:bits === 32 ? 'wzr' : 'xzr' });
const imm = (value) => ({ k:'imm', value:BigInt(value), text:`#${value}` });

function lift(mnemonic, ops) {
  sequence += 1;
  const instructionId = `arm64-register31-number:${sequence}`;
  return liftArm64MachineEffects({
    instructionId,
    mnemonic,
    mode:'a64',
    ops,
    origin:{ instructionIds:[instructionId] },
  });
}

function assertPartialOperationFree(bundle, label) {
  assert.ok(bundle, `${label}: invalid structured evidence remains explicitly owned`);
  assert.equal(bundle.completeness, 'partial', `${label}: invalid structured evidence is partial`);
  assert.equal(bundle.operations.length, 0, `${label}: invalid structured evidence emits no definite operations`);
}

// Parser/decoder canonical register-31 forms remain valid.
for (const bits of [32,64]) {
  const legal = lift('add', [gp(0,bits), sp(31,bits), imm(1)]);
  assert.ok(legal, `ADD ${bits}: canonical SP form must lift`);
  assert.equal(legal.completeness, 'exact', `ADD ${bits}: canonical SP form remains exact`);
  assert.ok(legal.operations.length > 0, `ADD ${bits}: canonical SP form keeps operations`);
}

// Existing compatibility for semantic SP/ZR records that omit num is preserved
// in the common register owner, while an explicit non-31 encoding field is not.
{
  const ctx = createArm64EffectContext({ instructionId:'arm64-register31-direct', mnemonic:'add', mode:'a64', ops:[] });
  assert.ok(ctx.readRegister({ k:'reg', cls:'sp', bits:64, text:'sp' }), 'SP with omitted num remains readable');
  assert.equal(ctx.readRegister(sp(0)), null, 'SP with explicit num=0 is rejected');
  assert.ok(ctx.readRegister({ k:'reg', cls:'zr', bits:64, text:'xzr' }), 'XZR with omitted num remains readable as zero');
  const beforeOmittedZrWrite = ctx.operations.length;
  assert.equal(ctx.writeRegister({ k:'reg', cls:'zr', bits:64, text:'xzr' }, ctx.constant(64, 0n)), true, 'XZR with omitted num remains a valid discard target');
  assert.equal(ctx.operations.length, beforeOmittedZrWrite, 'XZR discard with omitted num emits no register write');
  assert.equal(ctx.readRegister(zr(0)), null, 'XZR with explicit num=0 is rejected');
}

// ADD's legal SP operand position must reject contradictory encoding numbers
// before any register/value/write effect is emitted.
assertPartialOperationFree(
  lift('add', [gp(0), sp(0), imm(1)]),
  'ADD X0, SP(num=0), #1',
);
assertPartialOperationFree(
  lift('add', [gp(0,32), sp(0,32), imm(1)]),
  'ADD W0, WSP(num=0), #1',
);
assertPartialOperationFree(
  lift('add', [gp(0), { k:'reg', cls:'sp', num:32, bits:64, text:'sp' }, imm(1)]),
  'ADD X0, SP(num=32), #1',
);

// Zero-register canonical-number validation is pinned directly at the common
// owner so later consumers cannot reinterpret a non-31 record as architectural ZR.
for (const bad of [0,30,32,99]) {
  const ctx = createArm64EffectContext({
    instructionId:`arm64-zr-num-${bad}`,
    mnemonic:'and',
    mode:'a64',
    ops:[],
  });
  assert.equal(ctx.readRegister(zr(bad)), null, `XZR num=${bad} must be rejected`);
  assert.equal(ctx.writeRegister(zr(bad), ctx.constant(64, 0n)), false, `XZR num=${bad} write must be rejected`);
  assert.equal(ctx.operations.length, 0, `XZR num=${bad} must not emit definite register operations`);
}

// GP domain remains unchanged at the same common owner boundary.
{
  const ctx = createArm64EffectContext({ instructionId:'arm64-gp-boundary', mnemonic:'mov', mode:'a64', ops:[] });
  assert.ok(ctx.readRegister(gp(0)), 'X0 remains valid');
  assert.ok(ctx.readRegister(gp(30)), 'X30 remains valid');
  const beforeInvalid = ctx.operations.length;
  assert.equal(ctx.readRegister({ k:'reg', cls:'gp', num:31, bits:64, text:'x31' }), null, 'GP31 remains invalid');
  assert.equal(ctx.readRegister({ k:'reg', cls:'gp', num:32, bits:64, text:'x32' }), null, 'GP32 remains invalid');
  assert.equal(ctx.operations.length, beforeInvalid, 'invalid GP boundary adds no operations');
}

console.log('arm64-common-register31-number: PASS');

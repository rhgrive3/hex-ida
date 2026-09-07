import assert from 'node:assert/strict';

import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';
import { arm64RegisterOperand } from '../../js/targets/architecture/arm64/effects/addressing.js';

let sequence = 0;
const gp = (num, bits = 64, text = `${bits === 32 ? 'w' : 'x'}${num}`) => ({ k:'reg', cls:'gp', num, bits, text });
const sp = (bits = 64, text = bits === 32 ? 'wsp' : 'sp') => ({ k:'reg', cls:'sp', num:31, bits, text });
const zr = (bits = 64, text = bits === 32 ? 'wzr' : 'xzr') => ({ k:'reg', cls:'zr', num:31, bits, text });
const vec = (num, bits = 128, text = `${({8:'b',16:'h',32:'s',64:'d',128:'q'})[bits]}${num}`) => ({ k:'reg', cls:'fp', num, bits, text });
const imm = (value) => ({ k:'imm', value:BigInt(value), text:`#${value}` });
function mem(base, { index = null, shift = null, mode = 'offset', disp = 0n, writebackDisp = null } = {}) {
  const addressDisp = mode === 'post' ? null : imm(disp);
  return {
    k:'mem',
    text:'[...]',
    base,
    index,
    shift,
    mode,
    disp:addressDisp,
    addressDisp,
    writebackDisp:mode === 'offset' ? null : imm(writebackDisp ?? disp),
  };
}
function lift(mnemonic, ops) {
  sequence += 1;
  const instructionId = `arm64-memory-register-identity:${sequence}`;
  return liftArm64MachineEffects({
    instructionId,
    mnemonic,
    ops,
    mode:'a64',
    origin:{ instructionIds:[instructionId] },
  });
}
function assertLegal(mnemonic, ops) {
  const bundle = lift(mnemonic, ops);
  assert.ok(bundle, `${mnemonic}: legal structured form must remain owned`);
  assert.notEqual(bundle.completeness, 'partial', `${mnemonic}: legal structured form must preserve exact semantics`);
  assert.ok(bundle.operations.length > 0, `${mnemonic}: legal structured form must emit operations`);
  return bundle;
}
function assertFailClosed(mnemonic, ops) {
  const bundle = lift(mnemonic, ops);
  assert.ok(bundle, `${mnemonic}: contradictory structured form remains explicitly owned`);
  assert.equal(bundle.completeness, 'partial', `${mnemonic}: contradiction must be partial`);
  assert.equal(bundle.operations.length, 0, `${mnemonic}: contradiction must emit no definite operations`);
  return bundle;
}

// Pin the common normalizer itself: structured fields are the identity authority,
// while matching text is presentation only. fp/lr remain valid physical aliases.
assert.equal(arm64RegisterOperand(gp(0)).physicalId, 'x0');
assert.equal(arm64RegisterOperand(gp(29, 64, 'fp')).physicalId, 'x29');
assert.equal(arm64RegisterOperand(gp(30, 64, 'lr')).physicalId, 'x30');
assert.equal(arm64RegisterOperand(sp()).physicalId, 'sp');
assert.equal(arm64RegisterOperand(zr()).zero, true);
assert.equal(arm64RegisterOperand(vec(0, 64, 'd0')).physicalId, 'v0');
assert.equal(arm64RegisterOperand(gp(0, 64, 'x1')), null);
assert.equal(arm64RegisterOperand({ ...sp(), text:'x5' }), null);
assert.equal(arm64RegisterOperand({ ...zr(), text:'x7' }), null);
assert.equal(arm64RegisterOperand(vec(0, 128, 'q1')), null);
assert.equal(arm64RegisterOperand({ k:'reg', cls:'gp', num:99, bits:64, text:'x0' }), null);
assert.equal(arm64RegisterOperand({ k:'reg', cls:'gp', num:0, bits:16, text:'x0' }), null);
assert.equal(arm64RegisterOperand({ k:'reg', cls:'sp', num:0, bits:64, text:'sp' }), null);
assert.equal(arm64RegisterOperand({ k:'reg', cls:'zr', num:0, bits:64, text:'xzr' }), null);

// Legacy/internal structured forms carry redundant identity fields. Each field
// must agree with the parsed architectural view; none may override another.
assert.equal(arm64RegisterOperand({ kind:'gp', physicalId:'x2', view:'x2', bits:64, zero:false }).physicalId, 'x2');
assert.equal(arm64RegisterOperand({ kind:'gp', physicalId:'x2', view:'w2', bits:32, zero:false }).bits, 32);
assert.equal(arm64RegisterOperand({ registerId:'x2', view:'x2', widthBits:64 }).physicalId, 'x2');
assert.equal(arm64RegisterOperand({ kind:'gp', physicalId:'x2', view:'x2', bits:'64', zero:false }), null);
assert.equal(arm64RegisterOperand({ kind:'gp', physicalId:'x2', view:'x3', bits:64, zero:false }), null);
assert.equal(arm64RegisterOperand({ kind:'sp', physicalId:'x2', view:'x2', bits:64, zero:false }), null);
assert.equal(arm64RegisterOperand({ kind:'gp', physicalId:'x2', view:'x2', bits:64, zero:'false' }), null);
assert.equal(arm64RegisterOperand({ registerId:'x2', view:'x3', widthBits:64 }), null);
assert.equal(arm64RegisterOperand({ registerId:'x2', view:'x2', widthBits:'64' }), null);

// Existing exact boundaries remain exact.
assertLegal('ldr', [gp(0), mem(gp(2))]);
assertLegal('str', [gp(29, 64, 'fp'), mem(gp(30, 64, 'lr'))]);
assertLegal('ldr', [vec(0, 128, 'q0'), mem(sp())]);
assertLegal('ldr', [zr(), mem(gp(2))]);
assertLegal('ldr', [gp(0), mem(gp(2), { index:gp(3), shift:{ op:'lsl', amount:3 } })]);
assertLegal('ldxr', [gp(0), mem(gp(2))]);
assertLegal('cas', [gp(0), gp(1), mem(gp(2))]);

assertLegal('ldr', [gp(0), mem({ kind:'gp', physicalId:'x2', view:'x2', bits:64, zero:false })]);
assertFailClosed('ldr', [gp(0), mem({ kind:'sp', physicalId:'x2', view:'x2', bits:64, zero:false })]);
assertFailClosed('ldr', [gp(0), mem({ kind:'gp', physicalId:'x2', view:'x3', bits:64, zero:false })]);
assertFailClosed('ldr', [gp(0), mem({ kind:'gp', physicalId:'x2', view:'x2', bits:'64', zero:false })]);

// Data register contradictions must not turn canonical X0/V0 into a different
// exact destination/source merely because text names a legal register.
assertFailClosed('ldr', [gp(0, 64, 'x1'), mem(gp(2))]);
assertFailClosed('str', [gp(0, 64, 'x1'), mem(gp(2))]);
assertFailClosed('ldr', [vec(0, 128, 'q1'), mem(gp(2))]);
assertFailClosed('ldr', [{ k:'reg', cls:'gp', num:99, bits:64, text:'x0' }, mem(gp(2))]);
assertFailClosed('ldr', [{ k:'reg', cls:'gp', num:0, bits:16, text:'x0' }, mem(gp(2))]);

// Base/index identity is address evidence. A contradiction must fail before
// any register read, memory access or writeback operation is emitted.
assertFailClosed('ldr', [gp(0), mem(gp(2, 64, 'x3'))]);
assertFailClosed('ldr', [gp(0), mem({ ...sp(), text:'x4' })]);
assertFailClosed('ldr', [gp(0), mem(gp(2), { index:gp(3, 64, 'x4'), shift:{ op:'lsl', amount:3 } })]);
assertFailClosed('ldr', [gp(0), mem(gp(2, 64, 'x3'), { mode:'pre', disp:8n, writebackDisp:8n })]);

// Atomic/exclusive consumers share addressing.js. Pin both data and base paths.
assertFailClosed('ldxr', [gp(0, 64, 'x1'), mem(gp(2))]);
assertFailClosed('ldxr', [gp(0), mem(gp(2, 64, 'x3'))]);
assertFailClosed('cas', [gp(0, 64, 'x1'), gp(1), mem(gp(2))]);
assertFailClosed('cas', [gp(0), gp(1), mem(gp(2, 64, 'x3'))]);

console.log('arm64-memory-register-identity: PASS');

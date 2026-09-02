import assert from 'node:assert/strict';

import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';
import { instructionBits } from '../../js/targets/architecture/arm64/effects/common.js';

let seq = 0;
const gp = (num, bits = 64) => ({ k:'reg', cls:'gp', num, bits, text:`${bits === 32 ? 'w' : 'x'}${num}` });
const fp = (num, bits = 64) => ({ k:'reg', cls:'fp', num, bits, text:`${bits === 32 ? 's' : 'd'}${num}` });
const sysreg = (text) => ({ k:'sysreg', text });
function lift(mnemonic, ops, extra = {}) {
  const instructionId = `arm64-structured-width:${++seq}`;
  return liftArm64MachineEffects({ instructionId, mnemonic, mode:'a64', ops, origin:{ instructionIds:[instructionId] }, ...extra });
}
function assertFailClosed(bundle, label) {
  assert.ok(bundle, `${label}: family remains explicitly owned`);
  assert.equal(bundle.completeness, 'partial', `${label}: malformed structured width must be partial`);
  assert.ok(bundle.operations.every((operation) => operation.kind === 'unknown'), `${label}: malformed width must emit no definite operation`);
}

assert.equal(instructionBits({ bits:64 }), 64);
assert.equal(instructionBits({ bits:32 }), 32);
for (const bits of ['64', true, false, {}, [], 64.5, NaN, Infinity, -Infinity, 16, 128]) {
  assert.equal(instructionBits({ bits }), 0, `instructionBits rejects ${String(bits)}`);
}

const add = lift('add', [gp(0), gp(1), gp(2)]);
assert.ok(add && add.completeness !== 'partial' && add.operations.length > 0, 'numeric-width ADD remains semantic');
assertFailClosed(lift('add', [{ ...gp(0), bits:'64' }, gp(1), gp(2)]), 'ADD string width');
assertFailClosed(lift('add', [gp(0), { ...gp(1), bits:true }, gp(2)]), 'ADD boolean width');
assertFailClosed(lift('add', [gp(0), gp(1), { ...gp(2), bits:64.5 }]), 'ADD fractional width');
assertFailClosed(lift('add', [{ ...gp(0), cls:{ toString(){ return 'gp'; } } }, gp(1), gp(2)]), 'ADD object register class');
assertFailClosed(lift('add', [gp(0), { ...gp(1), cls:['gp'] }, gp(2)]), 'ADD array register class');

const fadd = lift('fadd', [fp(0), fp(1), fp(2)]);
assert.ok(fadd && fadd.completeness !== 'partial' && fadd.operations.length > 0, 'numeric-width FADD remains semantic');
assertFailClosed(lift('fadd', [{ ...fp(0), bits:'64' }, fp(1), fp(2)]), 'FADD string width');

const mrs = lift('mrs', [gp(0), sysreg('fpcr')]);
assert.ok(mrs && mrs.completeness !== 'partial' && mrs.operations.length > 0, 'numeric-width MRS remains semantic');
assertFailClosed(lift('mrs', [{ ...gp(0), bits:'64' }, sysreg('fpcr')]), 'MRS string width');

const br = lift('br', [gp(3)]);
assert.ok(br && br.completeness !== 'partial' && br.operations.length > 0, 'numeric-width BR remains semantic');
const cbz = lift('cbz', [gp(0, 32), { k:'imm', value:0x1004n }], { address:0x1000n });
assert.ok(cbz && cbz.completeness !== 'partial' && cbz.operations.length > 0, 'numeric-width CBZ remains semantic');
const cmp = lift('cmp', [gp(0), gp(1)]);
assert.ok(cmp && cmp.completeness !== 'partial' && cmp.operations.length > 0, 'numeric-width CMP remains semantic');
for (const bits of ['64', true, {}, [], 64.5, NaN, Infinity]) {
  assertFailClosed(lift('br', [{ ...gp(3), bits }]), `BR malformed width ${String(bits)}`);
  assertFailClosed(lift('cbz', [{ ...gp(0, 32), bits }, { k:'imm', value:0x1004n }], { address:0x1000n }), `CBZ malformed width ${String(bits)}`);
  assertFailClosed(lift('cmp', [gp(0), { ...gp(1), bits }]), `CMP malformed width ${String(bits)}`);
}

console.log('arm64-structured-width-validation: PASS');

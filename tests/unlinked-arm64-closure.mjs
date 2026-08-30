import assert from 'node:assert/strict';
import { arm64RegisterOperand } from '../js/targets/architecture/arm64/effects/addressing.js';
import { liftArm64eEffects, arm64ePointerAuthenticationMnemonics } from '../js/targets/architecture/arm64e/effects.js';

for (const valid of [
  { k:'reg', cls:'gp', num:0, bits:64, text:'x0' },
  { k:'reg', cls:'gp', num:30, bits:32, text:'w30' },
  { k:'reg', cls:'sp', num:31, bits:64, text:'sp' },
  { k:'reg', cls:'zr', num:31, bits:32, text:'wzr' },
  { k:'reg', cls:'vec', num:31, bits:128, text:'q31' },
]) assert.ok(arm64RegisterOperand(valid), JSON.stringify(valid));

for (const invalid of [
  { k:'reg', cls:'gp', num:'0', bits:64, text:'x0' },
  { k:'reg', cls:'gp', num:false, bits:64, text:'x0' },
  { k:'reg', cls:'gp', num:0, bits:'64', text:'x0' },
  { k:'reg', cls:'vec', num:'31', bits:128, text:'q31' },
  { k:'reg', cls:'gp', num:0.5, bits:64, text:'x0' },
  { k:'reg', cls:'gp', num:NaN, bits:64, text:'x0' },
  { k:'reg', cls:'gp', num:Infinity, bits:64, text:'x0' },
  { k:'reg', cls:'gp', num:{ valueOf(){ return 0; } }, bits:64, text:'x0' },
]) assert.equal(arm64RegisterOperand(invalid), null, JSON.stringify(invalid));
assert.equal(arm64RegisterOperand('x0')?.physicalId, 'x0');
assert.equal(arm64RegisterOperand('fp')?.physicalId, 'x29');
assert.equal(arm64RegisterOperand('lr')?.physicalId, 'x30');

const mnemonics = new Set(arm64ePointerAuthenticationMnemonics());
assert.equal(mnemonics.has('eretaa'), true);
assert.equal(mnemonics.has('eretab'), true);
for (const mnemonic of ['eretaa','eretab']) {
  const effects = liftArm64eEffects({ instructionId:`test:${mnemonic}`, mnemonic, ops:[], mode:'arm64e' });
  assert.ok(effects);
  assert.equal(effects.completeness, 'partial');
  assert.equal(effects.controlEffect?.kind, 'indirect');
  assert.equal(effects.controlEffect?.target?.kind, 'exception-return-address');
  assert.equal(effects.metadata?.authenticatedExceptionReturn, true);
  assert.equal(effects.possibleFaults.some((fault)=>fault.kind === 'illegal-exception-return'), true);
  assert.equal(effects.possibleFaults.some((fault)=>fault.kind === 'instruction-address-fault'), true);
  assert.match(effects.unknownEffects?.reason || '', /environment restore/);

  const malformed = liftArm64eEffects({ instructionId:`test:${mnemonic}:bad`, mnemonic, ops:[{k:'reg',cls:'gp',num:0,bits:64,text:'x0'}], mode:'arm64e' });
  assert.equal(malformed.completeness, 'partial');
  assert.match(malformed.unknownEffects?.reason || '', /operand shape/);
}

console.log('unlinked ARM64 closure: PASS');

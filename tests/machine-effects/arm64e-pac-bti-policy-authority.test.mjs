import assert from 'node:assert/strict';
import { parseOperands } from '../../js/arm64.js';
import { liftArm64eEffects } from '../../js/targets/architecture/arm64e/index.js';
import { decorateArm64BtiGuardedPageEffects } from '../../js/targets/architecture/arm64/effects/bti-guard-state.js';

let sequence = 0;
function paciasp(mnemonic = 'paciasp') {
  const instructionId = `arm64e-pac-policy-${++sequence}`;
  return { instructionId, mnemonic, opStr:'', ops:parseOperands(''), mode:'arm64e', address:0x4000n, origin:{ instructionIds:[instructionId] } };
}
function faults(bundle) { return bundle.possibleFaults.filter((fault) => fault.kind === 'branch-target-exception'); }
function hasBtypeRead(bundle) { return bundle.operations.some((operation) => operation.kind === 'register-read' && operation.register?.registerId === 'pstate.btype'); }

for (const mnemonic of ['paciasp', 'pacibsp']) {
  const base = liftArm64eEffects(paciasp(mnemonic));
  assert.equal(base.completeness, 'exact-with-intrinsic');

  const disabled = decorateArm64BtiGuardedPageEffects(paciasp(mnemonic), base, {
    featBti:false, btiGuardedPage:{ mappedPageGuarded:true }, incomingBtype:3, sctlrBt:true,
  });
  assert.equal(faults(disabled).length, 0, `${mnemonic}: FEAT_BTI=false disables implicit BTI`);
  assert.equal(hasBtypeRead(disabled), false, `${mnemonic}: disabled BTI must not read BTYPE`);
  assert.equal(disabled.metadata.btiCheck, 'disabled-by-feat-bti');
  assert.ok(disabled.operations.some((operation) => operation.kind === 'intrinsic' && operation.intrinsicId === 'arm64e.pointer.sign'));

  const compatibleCall = decorateArm64BtiGuardedPageEffects(paciasp(mnemonic), base, {
    featBti:true, btiGuardedPage:{ mappedPageGuarded:true }, incomingBtype:'0b01', sctlrBt:true,
  });
  assert.equal(faults(compatibleCall).length, 0, `${mnemonic}: BTYPE 01 is call-compatible`);
  assert.equal(compatibleCall.metadata.btiCheck, 'compatible-call-btype');

  const zero = decorateArm64BtiGuardedPageEffects(paciasp(mnemonic), base, {
    btiGuardedPage:{ mappedPageGuarded:true }, incomingBtype:0,
  });
  assert.equal(faults(zero).length, 0, `${mnemonic}: BTYPE 00 skips compatibility check`);
  assert.equal(zero.metadata.btiCheck, 'skipped-zero-btype');

  const policyOff = decorateArm64BtiGuardedPageEffects(paciasp(mnemonic), base, {
    btiGuardedPage:{ mappedPageGuarded:true }, incomingBtype:3, sctlrBt:false,
  });
  assert.equal(faults(policyOff).length, 0, `${mnemonic}: SCTLR.BT disabled accepts BTYPE 11`);
  assert.equal(policyOff.metadata.btiCheck, 'compatible-sctlr-policy');

  const incompatible = decorateArm64BtiGuardedPageEffects(paciasp(mnemonic), base, {
    btiGuardedPage:{ mappedPageGuarded:true }, incomingBtype:3, sctlrBt:true,
  });
  assert.equal(faults(incompatible).length, 1, `${mnemonic}: SCTLR.BT enabled rejects BTYPE 11`);
  assert.equal(faults(incompatible)[0].condition.kind, 'bti-incompatible');
  assert.equal(incompatible.metadata.btiCheck, 'incompatible-branch-target');

  const malformed = decorateArm64BtiGuardedPageEffects(paciasp(mnemonic), base, {
    btiGuardedPage:{ mappedPageGuarded:true, state:'not-a-state' },
  });
  assert.equal(malformed.completeness, 'partial', `${mnemonic}: malformed guard alias must fail closed`);
  assert.equal(malformed.metadata.btiCheck, 'conflicting-page-guard-state');
  assert.ok(faults(malformed).length >= 1);
}

console.log('ARM64e PACIASP/PACIBSP BTI policy authority: PASS');

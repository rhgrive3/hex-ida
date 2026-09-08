import assert from 'node:assert/strict';
import { parseOperands } from '../../js/arm64.js';
import { liftArm64eEffects } from '../../js/targets/architecture/arm64e/index.js';
import { decorateArm64BtiGuardedPageEffects } from '../../js/targets/architecture/arm64/effects/bti-guard-state.js';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

let sequence = 0;
function paciasm(mnemonic = 'paciasp') {
  sequence += 1;
  const instructionId = `arm64e-implicit-bti-${sequence}`;
  return { instructionId, mnemonic, opStr: '', ops: parseOperands(''), mode: 'arm64e', address: 0x1030n, origin: { instructionIds: [instructionId] } };
}
function btypeWrites(bundle) {
  return bundle.operations.filter((operation) => operation.kind === 'register-write' && operation.register?.registerId === 'pstate.btype');
}
function branchTargetExceptions(bundle) {
  return bundle.possibleFaults.filter((fault) => fault.kind === 'branch-target-exception');
}

// #6123: PACIASP/PACIBSP are implicit BTI landing pads. The decorated bundle
// must carry the incoming-BTYPE compatibility input and the conditional
// Branch Target Exception instead of only minting the PAC + post-state reset.
for (const mnemonic of ['paciasp', 'pacibsp']) {
  const base = liftArm64eEffects(paciasm(mnemonic));
  assert.equal(base.completeness, 'exact-with-intrinsic');

  // Guarded page: compatibility is checked against the actual inputs, PAC
  // path stays exact-with-intrinsic, BTYPE reset preserved on the normal path.
  const guarded = decorateArm64BtiGuardedPageEffects(paciasm(mnemonic), base, {
    btiGuardedPage: { mappedPageGuarded: true, source: 'runtime-page-table', evidence: { mappingId: 'map-1' } },
  });
  assert.equal(guarded.completeness, 'exact-with-intrinsic', `${mnemonic}: guarded PAC path stays exact-with-intrinsic`);
  const guardedFault = branchTargetExceptions(guarded)[0];
  assert.ok(guardedFault, `${mnemonic}: conditional Branch Target Exception required`);
  assert.equal(guardedFault.detail.implicitLanding, true);
  assert.equal(guardedFault.detail.guardedPageState, 'guarded');
  assert.deepEqual(guardedFault.condition.terms[1].condition.compatibleBtypes, ['0b01', '0b10'], `${mnemonic}: BTYPE 0b01/0b10 always compatible`);
  assert.deepEqual(guardedFault.condition.terms[1].condition.sctlrDependentBtypes, ['0b11'], `${mnemonic}: BTYPE 0b11 compatibility is SCTLR_ELx.BT dependent`);
  assert.ok(guarded.operations.some((operation) => operation.kind === 'register-read' && operation.register?.registerId === 'pstate.btype'), `${mnemonic}: incoming BTYPE read required`);
  const guardedIntrinsic = guarded.operations.find((operation) => operation.kind === 'intrinsic' && operation.intrinsicId === 'arm64e.pointer.sign');
  assert.equal(guardedIntrinsic.metadata.landingPadKind, 'implicit-cj', `${mnemonic}: implicit landing kind recorded`);
  assert.deepEqual(guardedIntrinsic.metadata.sctlrBtDependentBtypes, ['0b11']);
  assert.equal(btypeWrites(guarded).length, 1, `${mnemonic}: normal-path BTYPE reset preserved`);
  assert.equal(btypeWrites(guarded)[0].value.value, '0');
  assert.ok(guarded.metadata.implicitBtiLanding, `${mnemonic}: implicit landing marker`);

  // Unguarded page: implicit check cannot fault, PAC semantics preserved.
  const unguarded = decorateArm64BtiGuardedPageEffects(paciasm(mnemonic), base, {
    btiGuardedPage: { mappedPageGuarded: false, source: 'runtime-page-table' },
  });
  assert.equal(unguarded.completeness, 'exact-with-intrinsic');
  assert.equal(branchTargetExceptions(unguarded).length, 0, `${mnemonic}: no fault on a non-guarded page`);
  assert.equal(btypeWrites(unguarded).length, 1);
  assert.equal(unguarded.metadata.btiCheck, 'implicit-skipped-non-guarded-page');

  // Unknown guard state: conditional fault with unknown page evidence; the
  // guarded-page input is read, never assumed.
  const unknown = decorateArm64BtiGuardedPageEffects(paciasm(mnemonic), base, { btiGuardedPage: null });
  assert.equal(unknown.completeness, 'exact-with-intrinsic', `${mnemonic}: PAC + compatibility inputs stay stated, fault is conditional`);
  const unknownFault = branchTargetExceptions(unknown)[0];
  assert.ok(unknownFault, `${mnemonic}: unknown guard keeps the conditional fault`);
  assert.equal(unknownFault.condition.terms[0].value, 'unknown');
  assert.ok(unknown.operations.some((operation) => operation.kind === 'register-read' && operation.register?.registerId === 'arm64.exec-page.guarded'), `${mnemonic}: guarded-page state must be read, not assumed`);
}

// Non-landing instructions keep the pre-existing decorator behavior.
{
  const bundle = liftArm64eEffects({ ...paciasm('pacia'), opStr: 'x0, x1', ops: parseOperands('x0, x1') });
  const decorated = decorateArm64BtiGuardedPageEffects(paciasm('pacia'), bundle, { btiGuardedPage: { mappedPageGuarded: true } });
  assert.equal(branchTargetExceptions(decorated).length, 0, 'PACIA is not an implicit BTI landing');
  assert.equal(decorated.metadata.implicitBtiLanding, undefined);
}
{
  const bti = liftArm64MachineEffects({
    instructionId: 'arm64e-implicit-bti-bti-guard',
    mnemonic: 'bti',
    opStr: 'c',
    ops: parseOperands('c'),
    mode: 'arm64e',
    address: 0x2000n,
    origin: { instructionIds: ['arm64e-implicit-bti-bti-guard'] },
  }, { btiGuardedPage: { mappedPageGuarded: true, source: 'runtime' } });
  assert.ok(bti, 'literal BTI keeps its guard-state semantics');
  assert.ok(bti.possibleFaults.some((fault) => fault.kind === 'branch-target-exception'), 'literal BTI c guard fault preserved');
  assert.equal(bti.metadata.btiCheck, 'guarded-page-compatibility');
}

console.log('ARM64e PACI*SP implicit BTI landing compatibility (#6123): PASS');

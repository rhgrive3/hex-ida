// #8775 — an unprovisioned FEAT_BTI must not be laundered into "implemented".
// PACIASP/PACIBSP implicit landing pads previously inherited `featBti ?? true`,
// so a plain semantic-function call (which supplies no FEAT_BTI) fabricated an
// exact branch-target-exception and published the PAC bundle as
// exact-with-intrinsic. Unknown optional-feature state must fail closed to a
// partial result (mirroring FEAT_PAuth_LR / PACM), keeping the pointer-auth
// operations without asserting BTI enforcement.
import assert from 'node:assert/strict';
import { parseOperands } from '../../../js/arm64.js';
import { liftArm64eEffects } from '../../../js/targets/architecture/arm64e/index.js';
import { decorateArm64BtiGuardedPageEffects } from '../../../js/targets/architecture/arm64/effects/bti-guard-state.js';

let sequence = 0;
function pacixsp(mnemonic = 'paciasp') {
  const instructionId = `arm64e-8775-${++sequence}`;
  return {
    instructionId, mnemonic, opStr: '', ops: parseOperands(''),
    mode: 'arm64e', address: 0x1030n, origin: { instructionIds: [instructionId] },
  };
}
function faults(bundle) {
  return bundle.possibleFaults.filter((fault) => fault.kind === 'branch-target-exception');
}
function hasBtypeRead(bundle) {
  return bundle.operations.some(
    (operation) => operation.kind === 'register-read' && operation.register?.registerId === 'pstate.btype',
  );
}

for (const mnemonic of ['paciasp', 'pacibsp']) {
  const base = liftArm64eEffects(pacixsp(mnemonic));
  assert.equal(base.completeness, 'exact-with-intrinsic');

  // Absent FEAT_BTI (no context at all): must NOT fabricate enforcement.
  const unknown = decorateArm64BtiGuardedPageEffects(pacixsp(mnemonic), base, {});
  assert.equal(unknown.completeness, 'partial', `${mnemonic}: unknown FEAT_BTI fails closed to partial`);
  assert.equal(faults(unknown).length, 0, `${mnemonic}: unknown FEAT_BTI must not add a branch-target-exception`);
  assert.equal(hasBtypeRead(unknown), false, `${mnemonic}: unknown FEAT_BTI must not read BTYPE`);
  assert.equal(unknown.metadata.btiCheck, 'unknown-feat-bti', `${mnemonic}: btiCheck records the unknown feature`);
  assert.equal(unknown.metadata.featBti, 'unknown', `${mnemonic}: feature polarity recorded as unknown`);
  assert.equal(unknown.metadata.implicitBtiLanding, false, `${mnemonic}: no implicit landing asserted`);
  assert.ok(
    unknown.unknownEffects && unknown.unknownEffects.reason === 'bti-feature-unknown',
    `${mnemonic}: unknown feature must publish an explicit unknownEffects reason`,
  );
  assert.ok(
    unknown.operations.some(
      (operation) => operation.kind === 'intrinsic' && operation.intrinsicId === 'arm64e.pointer.sign',
    ),
    `${mnemonic}: pointer-authentication semantics are preserved under unknown FEAT_BTI`,
  );

  // hasBti:false is a definite "no", so it keeps the disabled path (not unknown).
  const offAlias = decorateArm64BtiGuardedPageEffects(pacixsp(mnemonic), base, { hasBti: false });
  assert.equal(offAlias.metadata.btiCheck, 'disabled-by-feat-bti', `${mnemonic}: hasBti:false is a definite disable`);
  assert.equal(offAlias.completeness, 'exact-with-intrinsic', `${mnemonic}: definite non-enforcement stays exact`);

  // A positively known FEAT_BTI still enforces exactly (regression guard: no under-claiming).
  const known = decorateArm64BtiGuardedPageEffects(pacixsp(mnemonic), base, {
    featBti: true, btiGuardedPage: { mappedPageGuarded: true }, incomingBtype: 3, sctlrBt: true,
  });
  assert.equal(faults(known).length, 1, `${mnemonic}: known FEAT_BTI enforces the conditional fault`);
  assert.equal(known.metadata.btiCheck, 'incompatible-branch-target', `${mnemonic}: known enforcement path intact`);
}

console.log('#8775 unknown FEAT_BTI fails closed: PASS');

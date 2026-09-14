import assert from 'node:assert/strict';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';

function lift(ops, btiGuardedPage = true) {
  return liftArm64MachineEffects({
    instructionId:'bti-selector-validation',
    mnemonic:'bti',
    ops,
  }, { btiGuardedPage });
}

for (const kind of ['c', 'j', 'jc']) {
  const result = lift([{ text:kind }], true);
  assert.equal(result.completeness, 'exact-with-intrinsic');
  const intrinsic = result.operations.find((operation) => operation.intrinsicId === 'arm64.system.bti');
  assert.equal(intrinsic?.metadata?.landingPadKind, kind);
  assert.equal(result.possibleFaults[0]?.kind, 'branch-target-exception');
  assert.equal(result.possibleFaults[0]?.detail?.landingPadKind, kind);
}

const encoded = lift([], true);
assert.equal(encoded.completeness, 'exact-with-intrinsic');
assert.equal(encoded.possibleFaults[0]?.detail?.landingPadKind, 'encoded');

for (const text of [
  ['c'],
  { toString() { return 'jc'; } },
  true,
  1,
]) {
  const result = lift([{ text }], true);
  assert.equal(result.completeness, 'partial');
  assert.equal(result.unknownEffects?.reason, 'bti-intrinsic-missing');
  const intrinsic = result.operations.find((operation) => operation.intrinsicId === 'arm64.system.bti');
  assert.equal(intrinsic, undefined);
  assert.equal(result.possibleFaults.some((fault) => fault?.detail?.landingPadKind === 'c' || fault?.detail?.landingPadKind === 'j' || fault?.detail?.landingPadKind === 'jc'), false);
}

const unknownString = lift([{ text:'x' }], true);
assert.equal(unknownString.completeness, 'partial');
assert.notEqual(unknownString.metadata?.btiCheck, 'guarded-page-compatibility');

const unguardedMalformed = lift([{ text:['c'] }], false);
assert.equal(unguardedMalformed.completeness, 'exact');
assert.equal(unguardedMalformed.metadata?.btiCheck, 'skipped-non-guarded-page');
assert.equal(unguardedMalformed.possibleFaults.length, 0);

const unknownGuard = lift([{ text:'c' }], null);
assert.equal(unknownGuard.completeness, 'partial');
assert.equal(unknownGuard.metadata?.btiCheck, 'conditional-on-unknown-page-guard-state');
assert.equal(unknownGuard.possibleFaults[0]?.detail?.landingPadKind, 'c');

console.log('arm64 BTI selector validation regression PASS');

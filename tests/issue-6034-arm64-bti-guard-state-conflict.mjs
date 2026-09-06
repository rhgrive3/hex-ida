import assert from 'node:assert/strict';
import {
  normalizeArm64BtiGuardedPageState,
  arm64BtiGuardedPageStateFromImage,
  decorateArm64BtiGuardedPageEffects,
  ARM64_BTI_PAGE_GUARD_STATE_ID,
} from '../js/targets/architecture/arm64/effects/bti-guard-state.js';
import { liftArm64MachineEffects } from '../js/targets/architecture/arm64/effects/index.js';

console.log('Testing #6034: ARM64 BTI guarded-page state alias conflict validation...');

function btiInstruction(landing = 'c') {
  return { mnemonic: 'bti', ops: [{ k: 'other', text: landing }] };
}

function context(id, btiGuardedPage) {
  return {
    instructionId: id,
    origin: { instructionIds: [id] },
    btiGuardedPage,
  };
}

// 1. {mappedPageGuarded: true} -> guarded control
{
  const s = normalizeArm64BtiGuardedPageState({ mappedPageGuarded: true });
  assert.equal(s.state, 'guarded');
  assert.equal(s.mappedPageGuarded, true);
  assert.equal(s.conflict, undefined);

  const bundle = liftArm64MachineEffects(btiInstruction('c'), context('c1', { mappedPageGuarded: true }));
  assert.equal(bundle.completeness, 'exact-with-intrinsic');
}

// 2. {guarded: false} -> unguarded control
{
  const s = normalizeArm64BtiGuardedPageState({ guarded: false });
  assert.equal(s.state, 'unguarded');
  assert.equal(s.mappedPageGuarded, false);
  assert.equal(s.conflict, undefined);

  const bundle = liftArm64MachineEffects(btiInstruction('c'), context('c2', { guarded: false }));
  assert.equal(bundle.completeness, 'exact');
  assert.deepEqual(bundle.possibleFaults, []);
  assert.equal(bundle.metadata.btiCheck, 'skipped-non-guarded-page');
}

// 3. {state: 'guarded'} -> guarded control
{
  const s = normalizeArm64BtiGuardedPageState({ state: 'guarded' });
  assert.equal(s.state, 'guarded');
  assert.equal(s.mappedPageGuarded, true);
  assert.equal(s.conflict, undefined);
}

// 4. {mappedPageGuarded: true, state: 'guarded'} -> guarded (matching)
{
  const s = normalizeArm64BtiGuardedPageState({ mappedPageGuarded: true, state: 'guarded' });
  assert.equal(s.state, 'guarded');
  assert.equal(s.mappedPageGuarded, true);
  assert.equal(s.conflict, undefined);
}

// 5. {mappedPageGuarded: false, guarded: false, state: 'unguarded'} -> unguarded (matching)
{
  const s = normalizeArm64BtiGuardedPageState({ mappedPageGuarded: false, guarded: false, state: 'unguarded' });
  assert.equal(s.state, 'unguarded');
  assert.equal(s.mappedPageGuarded, false);
  assert.equal(s.conflict, undefined);
}

// 6. {mappedPageGuarded: false, state: 'guarded'} -> conflict/unknown, exact NOP-like にしない
{
  const s = normalizeArm64BtiGuardedPageState({ mappedPageGuarded: false, state: 'guarded' });
  assert.equal(s.state, 'unknown');
  assert.equal(s.mappedPageGuarded, null);
  assert.equal(s.conflict, true);
  assert.ok(s.conflictReason);

  const bundle = liftArm64MachineEffects(btiInstruction('c'), context('c6', { mappedPageGuarded: false, state: 'guarded' }));
  assert.notEqual(bundle.completeness, 'exact');
  assert.equal(bundle.completeness, 'partial');
  assert.equal(bundle.statePreservation, undefined);
  assert.notEqual(bundle.metadata.btiCheck, 'skipped-non-guarded-page');
}

// 7. {mappedPageGuarded: true, guarded: false} -> conflict/unknown, guarded exact にしない
{
  const s = normalizeArm64BtiGuardedPageState({ mappedPageGuarded: true, guarded: false });
  assert.equal(s.state, 'unknown');
  assert.equal(s.mappedPageGuarded, null);
  assert.equal(s.conflict, true);
  assert.ok(s.conflictReason);

  const bundle = liftArm64MachineEffects(btiInstruction('c'), context('c7', { mappedPageGuarded: true, guarded: false }));
  assert.notEqual(bundle.completeness, 'exact-with-intrinsic');
  assert.equal(bundle.completeness, 'partial');
  assert.notEqual(bundle.metadata.btiCheck, 'guarded-page-compatibility');
}

// 8. malformed alias 値: malformed evidence を黙って消さず conflict/unknown とする
{
  const s1 = normalizeArm64BtiGuardedPageState({ mappedPageGuarded: 123 });
  assert.equal(s1.state, 'unknown');
  assert.equal(s1.conflict, true);

  const s2 = normalizeArm64BtiGuardedPageState({ mappedPageGuarded: true, state: 'invalid-state' });
  assert.equal(s2.state, 'unknown');
  assert.equal(s2.conflict, true);
}

// 9. conflict context の BTI bundle で completeness:'exact' / statePreservation.proven:true を生成しない
{
  const bundle = liftArm64MachineEffects(btiInstruction('jc'), context('c9', {
    mappedPageGuarded: false,
    guarded: true,
    source: 'test-conflict',
  }));
  assert.equal(bundle.completeness, 'partial');
  assert.equal(bundle.statePreservation, undefined);
  assert.ok(bundle.operations.some((op) => op.kind === 'register-read' && op.register.registerId === ARM64_BTI_PAGE_GUARD_STATE_ID));
}

// 10. runtime helper arm64BtiGuardedPageStateFromImage() の通常 single-source path は非退行
{
  const image = {
    metadata: { arm64Bti: { loaderPolicy: 'bti-requested', btiRequested: true, mappedPageGuarded: 'unknown' } },
  };
  const policyOnly = arm64BtiGuardedPageStateFromImage(image, 0x1000n);
  assert.equal(policyOnly.state, 'unknown');
  assert.equal(policyOnly.conflict, undefined);

  const mappedTrue = arm64BtiGuardedPageStateFromImage(image, 0x1000n, {
    mappedPageGuarded: true,
    source: 'runtime-page-table',
  });
  assert.equal(mappedTrue.state, 'guarded');
  assert.equal(mappedTrue.mappedPageGuarded, true);
  assert.equal(mappedTrue.conflict, undefined);

  const mappedFalse = arm64BtiGuardedPageStateFromImage(image, 0x1000n, {
    mappedPageGuarded: false,
    source: 'runtime-page-table',
  });
  assert.equal(mappedFalse.state, 'unguarded');
  assert.equal(mappedFalse.mappedPageGuarded, false);
  assert.equal(mappedFalse.conflict, undefined);
}

console.log('#6034 tests passed successfully.');

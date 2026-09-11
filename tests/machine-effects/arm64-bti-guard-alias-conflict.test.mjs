import assert from 'node:assert/strict';
import { normalizeArm64BtiGuardedPageState, decorateArm64BtiGuardedPageEffects } from '../../js/targets/architecture/arm64/effects/bti-guard-state.js';
import { liftArm64MachineEffects } from '../../js/targets/architecture/arm64/effects/index.js';
import { parseOperands } from '../../js/arm64.js';

// #6034: `mappedPageGuarded`, `guarded`, and `state` are canonical aliases of
// one physical page-state fact. The normalizer's nullish-coalescing accepted
// the first present alias and silently discarded contradictory aliases, so a
// conflicting envelope could mint a definitive guarded/unguarded state — the
// state that directly drives BTI exception semantics.

assert.equal(normalizeArm64BtiGuardedPageState({ mappedPageGuarded: false, state: 'guarded' }).state, 'unknown', 'false vs guarded conflict must not promote unguarded');
assert.equal(normalizeArm64BtiGuardedPageState({ mappedPageGuarded: true, guarded: false }).state, 'unknown', 'true vs unguarded conflict must not promote guarded');
assert.equal(normalizeArm64BtiGuardedPageState({ mappedPageGuarded: false, guarded: true, state: 'unguarded' }).state, 'unknown', 'majority aliases still conflict when any alias disagrees');
assert.equal(normalizeArm64BtiGuardedPageState({ mappedPageGuarded: true, guarded: 'unguarded' }).evidence?.conflict != null, true, 'conflict evidence preserved');

// Agreeing aliases keep the definitive state.
assert.equal(normalizeArm64BtiGuardedPageState({ mappedPageGuarded: true, state: 'guarded' }).state, 'guarded');
assert.equal(normalizeArm64BtiGuardedPageState({ mappedPageGuarded: false, guarded: 'unguarded' }).state, 'unguarded');
// Repeating the same alias is not a conflict.
assert.equal(normalizeArm64BtiGuardedPageState({ mappedPageGuarded: true, guarded: true }).state, 'guarded');
// Single-alias and absent envelopes unchanged.
assert.equal(normalizeArm64BtiGuardedPageState({ state: 'unguarded' }).state, 'unguarded');
assert.equal(normalizeArm64BtiGuardedPageState({}).state, 'unknown');
assert.equal(normalizeArm64BtiGuardedPageState(true).state, 'guarded');
assert.equal(normalizeArm64BtiGuardedPageState(null).state, 'unknown');

// Decorator semantics: the conflicting envelope must not reach the
// NOP-like unguarded fast path that drops the fault surface.
let sequence = 0;
function bti() {
  const instructionId = `bti-conflict-${++sequence}`;
  return {
    instructionId,
    mnemonic: 'bti',
    opStr: 'c',
    ops: parseOperands('c'),
    mode: 'a64',
    address: 0x2000n,
    origin: { instructionIds: [instructionId] },
  };
}
const base = liftArm64MachineEffects(bti());
const conflicting = decorateArm64BtiGuardedPageEffects(bti(), base, {
  btiGuardedPage: { mappedPageGuarded: false, state: 'guarded' },
});
assert.equal(conflicting?.completeness, 'partial', 'conflicting envelope must take the unknown-guard conditional path, not the unguarded skip');
assert.notEqual(conflicting?.metadata?.btiGuardedPage?.state, 'unguarded', 'unguarded must not be minted from contradictory evidence');
assert.ok(
  conflicting?.possibleFaults?.some((fault) => fault.kind === 'branch-target-exception'),
  'the conditional Branch Target Exception stays available for unknown guard state',
);

console.log('ARM64 BTI guarded-page alias conflict authority (#6034): PASS');

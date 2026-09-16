import assert from 'node:assert/strict';
import test from 'node:test';

import { validateCilEffectFunction } from '../../../js/managed/cil/validation.js';

function op(offset, { consumed = 0, produced = 0, controlEffects = [], bits = 32, completeness = 'exact' } = {}) {
  return {
    bytecodeOffset: offset,
    operationId: `op:${offset}`,
    consumedValues: Array.from({ length: consumed }, () => ({ bits })),
    producedValues: Array.from({ length: produced }, () => ({ bits })),
    controlEffects,
    callEffects: [],
    completeness,
  };
}

function validate(bundles, { maxStack, returnStackSlots = 0, context = {} } = {}) {
  return validateCilEffectFunction({
    methodId: 'managed-method:test:0x06000001',
    profileId: 'ecma-335',
    bundles,
    entryState: { maxStack },
    exceptionRegions: [],
  }, { returnStackSlots, ...context });
}

function fact(report) {
  return report.verifierFacts.find((item) => item.code === 'cil-stack-dataflow-validated');
}

// Switch fan-out mirroring the issue counterexample: a legal deep stack plus
// 300 distinct switch targets that all receive the same stack state.
function fanout(H = 2200, K = 300) {
  const bundles = [
    op(0, { produced: H + 1 }),
    op(1, {
      consumed: 1,
      controlEffects: [{ kind: 'switch', targetOffsets: Array.from({ length: K }, (_, i) => 2 + i) }],
    }),
  ];
  for (let i = 0; i < K; i += 1) bundles.push(op(2 + i));
  const popsStart = 2 + K;
  for (let i = 0; i < H; i += 1) bundles.push(op(popsStart + i, { consumed: 1 }));
  bundles.push(op(popsStart + H, { controlEffects: [{ kind: 'return' }] }));
  return { bundles, maxStack: H + 1 };
}

// #8715 CIL regressions 5/6: the fan-out validates with bounded memory
// because every target receiving the same stack shares the structural
// snapshot instead of deep-cloning H fresh cells each (before the fix this
// shape retained >250 MiB and OOMed a 256 MiB worker for a ~12 KiB body).
test('#8715 CIL switch fan-out stays bounded with structural state sharing', () => {
  const { bundles, maxStack } = fanout();
  globalThis.gc && globalThis.gc();
  const before = process.memoryUsage().heapUsed;
  const report = validate(bundles, { maxStack });
  const delta = process.memoryUsage().heapUsed - before;
  assert.equal(report.status, 'valid');
  assert.equal(report.errors.length, 0);
  assert.ok(fact(report).reachedBlocks > 2500, 'targets, pops, and return must all be analyzed');
  assert.ok(delta < 120 * 1024 * 1024, `validation retained ${(delta / 1024 / 1024).toFixed(0)} MiB of state; expected bounded structural sharing`);
});

// #8715 shared regression 9: a deliberately low verifier-state budget stops
// the pass before large snapshots are retained, degrading to explicit partial.
test('#8715 CIL aggregate state budget fails closed before retaining fan-out', () => {
  const { bundles, maxStack } = fanout();
  const report = validate(bundles, { maxStack, context: { maxVerifierStateCells: 5_000 } });
  assert.equal(report.status, 'partial');
  assert.equal(report.errors.length, 0, 'a resource stop is not a spec violation');
  assert.ok(report.completeness.specValidation === 'partial');
  assert.ok(report.warnings.some((warning) => warning.code === 'cil-verifier-state-budget-exceeded'));
  assert.ok(fact(report).retainedStateCells <= 5_000, 'retention must stop at the configured budget');
  assert.ok(fact(report).reachedBlocks < 1_000, 'the pass must stop before analyzing the whole fan-out');
});

// #8715 CIL regression 7: merge mismatch fail-closed semantics are preserved
// under the shared-cell representation.
test('#8715 CIL stack-height and type merge mismatches still fail closed', () => {
  const heightMismatch = [
    op(0, { produced: 1 }),
    op(1, { controlEffects: [{ kind: 'conditional-branch', targetOffset: 4 }] }),
    op(2, { produced: 2, bits: 64 }),
    op(3, { controlEffects: [{ kind: 'branch', targetOffset: 4 }] }),
    op(4, { controlEffects: [{ kind: 'return' }] }),
  ];
  const height = validate(heightMismatch, { maxStack: 4 });
  assert.equal(height.status, 'invalid');
  assert.ok(height.errors.some((error) => error.code === 'cil-stack-height-merge-mismatch'));

  const typeMismatch = [
    op(0, { produced: 1 }),
    op(1, { controlEffects: [{ kind: 'conditional-branch', targetOffset: 5 }] }),
    op(2),
    op(3, { consumed: 1, produced: 1, bits: 64, controlEffects: [{ kind: 'branch', targetOffset: 5 }] }),
    op(4),
    op(5, { controlEffects: [{ kind: 'return' }] }),
  ];
  const typed = validate(typeMismatch, { maxStack: 4 });
  assert.equal(typed.status, 'invalid');
  assert.ok(typed.errors.some((error) => error.code === 'cil-stack-type-merge-mismatch'));
});

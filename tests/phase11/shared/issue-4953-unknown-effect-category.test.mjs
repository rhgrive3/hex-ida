// Regression for #4953: VMEffectBundle exposed a finite unknown-effect
// category taxonomy, but neither the constructor nor the public validator
// enforced it. That allowed typo/structured categories to become canonical
// partial/unknown evidence and made VM_UNKNOWN_CATEGORIES non-authoritative.
import assert from 'node:assert/strict';
import {
  VM_UNKNOWN_CATEGORIES,
  createVMEffectBundle,
  validateVMEffectBundle,
} from '../../../js/managed/shared/vm-effects.js';

function bundle(overrides = {}) {
  return createVMEffectBundle({
    frontendId: 'wasm',
    methodId: 'method:4953',
    operationId: 'op:4953',
    bytecodeOffset: 0,
    completeness: 'partial',
    unknownEffects: [{ category: 'memory', reason: 'unknown-memory-effect' }],
    ...overrides,
  });
}

// 1. Every published category is accepted and remains lossless.
for (const category of VM_UNKNOWN_CATEGORIES) {
  const effect = { category, reason: `unknown-${category}`, detail: { source: 'fixture' } };
  const actual = bundle({ unknownEffects: [effect] });
  assert.deepEqual(actual.unknownEffects, [effect], `category ${category} must remain canonical`);
  assert.equal(validateVMEffectBundle(actual), true);
}

// 2. The issue's decisive counterexample must fail closed at construction.
assert.throws(
  () => bundle({ unknownEffects: [{ category: 'definitely-not-a-vm-category', reason: 'x' }] }),
  /vm-effect-invalid-unknown-category/,
  'an out-of-taxonomy category must never become canonical VM evidence',
);

// 3. Missing, empty, and structured categories are not silently normalized.
for (const invalid of [
  { reason: 'missing-category' },
  { category: '', reason: 'empty-category' },
  { category: ['memory'], reason: 'structured-category' },
  { category: { toString: () => 'memory' }, reason: 'coercible-category' },
]) {
  assert.throws(
    () => bundle({ unknownEffects: [invalid] }),
    /vm-effect-invalid-unknown-category/,
    'unknown-effect categories are primitive exact enum tokens only',
  );
}

// 4. Each entry must be an object; a non-empty array alone is not evidence.
for (const invalid of [null, 'memory', ['memory']]) {
  assert.throws(
    () => bundle({ unknownEffects: [invalid] }),
    /vm-effect-invalid-unknown-effect/,
  );
}

// 5. unknown as well as partial accepts a valid canonical category.
{
  const actual = bundle({
    completeness: 'unknown',
    unknownEffects: [{ category: 'control', reason: 'unknown-control-flow' }],
  });
  assert.equal(actual.unknownEffects[0].category, 'control');
  assert.equal(validateVMEffectBundle(actual), true);
}

// 6. partial/unknown still require at least one valid unknown effect.
for (const completeness of ['partial', 'unknown']) {
  assert.throws(
    () => bundle({ completeness, unknownEffects: [] }),
    /vm-effect-partial-must-specify-unknown-effects/,
  );
}

// 7. Canonicalization snapshots an authority-bearing category before it is
//    validated. A stateful accessor cannot pass validation and then publish a
//    different out-of-taxonomy value on a later read.
{
  let categoryReads = 0;
  const effect = {
    reason: 'stateful-category',
    get category() {
      categoryReads += 1;
      return categoryReads <= 2 ? 'memory' : 'invented-after-validation';
    },
  };
  const actual = bundle({ unknownEffects: [effect] });
  assert.equal(actual.unknownEffects[0].category, 'memory');
  assert.ok(VM_UNKNOWN_CATEGORIES.includes(actual.unknownEffects[0].category));
}

// 8. The collection itself is typed even for exact bundles.
for (const invalid of ['memory', {}, 1]) {
  assert.throws(
    () => bundle({ completeness: 'exact', unknownEffects: invalid }),
    /vm-effect-invalid-unknown-effects/,
  );
}

// 9. Taxonomy validation applies even when an exact bundle happens to carry
//    diagnostic unknownEffects; exactness cannot be used to bypass the schema.
assert.throws(
  () => bundle({
    completeness: 'exact',
    unknownEffects: [{ category: 'not-real', reason: 'bad-exact-diagnostic' }],
  }),
  /vm-effect-invalid-unknown-category/,
);

// 10. The public validator must independently reject persisted/forged evidence.
{
  const canonical = bundle();
  const forged = {
    ...canonical,
    unknownEffects: [{ category: 'invented-category', reason: 'forged' }],
  };
  assert.throws(
    () => validateVMEffectBundle(forged),
    /vm-effect-invalid-unknown-category/,
    'validator must not bless a category that the constructor rejects',
  );
  assert.throws(
    () => validateVMEffectBundle({ ...canonical, unknownEffects: [{ reason: 'missing-category' }] }),
    /vm-effect-invalid-unknown-category/,
  );
}

// 11. The validator also preserves the existing partial/unknown non-empty
//    evidence requirement for externally assembled objects.
{
  const canonical = bundle();
  assert.throws(
    () => validateVMEffectBundle({ ...canonical, unknownEffects: [] }),
    /vm-effect-partial-must-specify-unknown-effects/,
  );
}

// 12. The public validator must not execute accessor-backed category authority.
//     Persisted/forged evidence is only admissible when category is stable own data.
{
  const canonical = bundle();
  let categoryReads = 0;
  const effect = { reason: 'stateful-validator-category' };
  Object.defineProperty(effect, 'category', {
    enumerable: true,
    get() {
      categoryReads += 1;
      return 'memory';
    },
  });
  const forged = { ...canonical, unknownEffects: [effect] };
  assert.throws(
    () => validateVMEffectBundle(forged),
    /vm-effect-invalid-unknown-category/,
    'validator must reject executable category authority',
  );
  assert.equal(categoryReads, 0, 'validator must not invoke a category getter');
}

console.log('issue-4953 unknown-effect category taxonomy: ok');

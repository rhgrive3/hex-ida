// Regression for #5404: createVMEffectFunction() adopted an explicit
// aggregateCompleteness without checking it against the bundles it summarizes
// (and without any enum check), so a function containing partial/unknown
// bundles published `aggregateCompleteness:'exact'` — and garbage strings
// passed through verbatim. validateVMEffectFunction() did not check the field
// either.
// Contract now: the explicit value must be inside the completeness taxonomy;
// a declaration that out-claims the conservative derivation from the bundles
// is a caller contradiction and fails closed
// (vm-effect-aggregate-completeness-overclaim), a more conservative
// declaration is honored, and garbage fails closed.
import assert from 'node:assert/strict';
import {
  createVMEffectBundle,
  createVMEffectFunction,
  validateVMEffectFunction,
} from '../../../js/managed/shared/vm-effects.js';

const partialBundle = createVMEffectBundle({
  frontendId: 'wasm', methodId: 'method:1', operationId: 'op:0',
  completeness: 'partial',
  unknownEffects: [{ category: 'other', reason: 'unsupported-op' }],
});
const exactBundle = createVMEffectBundle({ frontendId: 'wasm', methodId: 'method:1', operationId: 'op:1' });

// 1. The issue's decisive scenario: 'exact' over a partial bundle is rejected,
//    not demoted and not adopted.
{
  assert.throws(
    () => createVMEffectFunction({
      frontendId: 'wasm', methodId: 'method:1', bundles: [partialBundle],
      aggregateCompleteness: 'exact',
    }),
    (error) => error.message === 'vm-effect-aggregate-completeness-overclaim',
    'an aggregate must never out-claim its bundles — the contradiction fails closed',
  );
}

// 1b. The overclaim matrix is rejected at every strength step up: the derived
//     aggregate pins the ceiling and any stronger declaration throws.
{
  const unknownBundle = createVMEffectBundle({
    frontendId: 'wasm', methodId: 'method:1', operationId: 'op:2',
    completeness: 'unknown',
    unknownEffects: [{ category: 'other', reason: 'unsupported-op' }],
  });
  const intrinsicBundle = createVMEffectBundle({
    frontendId: 'wasm', methodId: 'method:1', operationId: 'op:3',
    completeness: 'exact-with-intrinsic',
  });
  assert.throws(
    () => createVMEffectFunction({ frontendId: 'wasm', methodId: 'm', bundles: [unknownBundle], aggregateCompleteness: 'partial' }),
    (error) => error.message === 'vm-effect-aggregate-completeness-overclaim',
  );
  assert.throws(
    () => createVMEffectFunction({ frontendId: 'wasm', methodId: 'm', bundles: [unknownBundle], aggregateCompleteness: 'exact' }),
    (error) => error.message === 'vm-effect-aggregate-completeness-overclaim',
  );
  assert.throws(
    () => createVMEffectFunction({ frontendId: 'wasm', methodId: 'm', bundles: [intrinsicBundle], aggregateCompleteness: 'exact' }),
    (error) => error.message === 'vm-effect-aggregate-completeness-overclaim',
  );
  const downgraded = createVMEffectFunction({ frontendId: 'wasm', methodId: 'm', bundles: [exactBundle], aggregateCompleteness: 'exact-with-intrinsic' });
  assert.equal(downgraded.aggregateCompleteness, 'exact-with-intrinsic', 'a more conservative declaration stays honored');
}

// 2. Garbage aggregate values fail closed instead of passing through.
assert.throws(
  () => createVMEffectFunction({ frontendId: 'wasm', methodId: 'm', bundles: [], aggregateCompleteness: 'total-garbage' }),
  (error) => error.message === 'vm-effect-aggregate-completeness-invalid',
  'a non-taxonomy aggregate must be rejected',
);

// 3. A consistent explicit declaration is kept.
{
  const fn = createVMEffectFunction({
    frontendId: 'wasm', methodId: 'method:1', bundles: [exactBundle],
    aggregateCompleteness: 'exact',
  });
  assert.equal(fn.aggregateCompleteness, 'exact');
}

// 4. Weaker (more conservative) explicit declarations are honored.
{
  const fn = createVMEffectFunction({
    frontendId: 'wasm', methodId: 'method:1', bundles: [exactBundle, partialBundle],
    aggregateCompleteness: 'partial',
  });
  assert.equal(fn.aggregateCompleteness, 'partial');
  const fn2 = createVMEffectFunction({
    frontendId: 'wasm', methodId: 'method:1', bundles: [partialBundle],
    aggregateCompleteness: 'unknown',
  });
  assert.equal(fn2.aggregateCompleteness, 'unknown');
}

// 5. The derived default is unchanged when the field is omitted.
{
  const fn = createVMEffectFunction({ frontendId: 'wasm', methodId: 'method:1', bundles: [exactBundle, partialBundle] });
  assert.equal(fn.aggregateCompleteness, 'partial', 'derived aggregate comes from the weakest bundle');
  const fnAllExact = createVMEffectFunction({ frontendId: 'wasm', methodId: 'method:2', bundles: [exactBundle] });
  assert.equal(fnAllExact.aggregateCompleteness, 'exact');
}

// 6. validateVMEffectFunction enforces the taxonomy too.
{
  const forged = { ...createVMEffectFunction({ frontendId: 'wasm', methodId: 'method:3', bundles: [] }), aggregateCompleteness: 'made-up' };
  assert.throws(() => validateVMEffectFunction(forged), /vm-effect-aggregate-completeness-invalid/,
    'a validator pass cannot bless an out-of-taxonomy aggregate');
}

// 7. Resolution completeness is a typed authority field: arbitrary and
//    structured values fail closed; the taxonomy from the runtime evidence
//    bridge is accepted.
{
  assert.throws(
    () => createVMEffectFunction({ frontendId: 'wasm', methodId: 'm', bundles: [], resolutionCompleteness: 'anything' }),
    /vm-effect-resolution-completeness-invalid/,
    'arbitrary resolution values must be rejected',
  );
  assert.throws(
    () => createVMEffectFunction({ frontendId: 'wasm', methodId: 'm', bundles: [], resolutionCompleteness: ['complete'] }),
    /vm-effect-resolution-completeness-invalid/,
    'structured resolution values must not be String-coerced into the enum',
  );
  const bounded = createVMEffectFunction({ frontendId: 'wasm', methodId: 'm', bundles: [], resolutionCompleteness: 'bounded' });
  assert.equal(bounded.resolutionCompleteness, 'bounded');
  const defaultResolution = createVMEffectFunction({ frontendId: 'wasm', methodId: 'm', bundles: [] });
  assert.equal(defaultResolution.resolutionCompleteness, 'complete');
}

// 8. A canonical object whose aggregate was tampered to claim stronger
//    authority than its bundles support must fail the validator.
{
  const canonical = createVMEffectFunction({ frontendId: 'wasm', methodId: 'method:1', bundles: [partialBundle] });
  assert.equal(canonical.aggregateCompleteness, 'partial');
  assert.equal(validateVMEffectFunction(canonical), true, 'the honest canonical object validates');
  assert.throws(
    () => validateVMEffectFunction({ ...canonical, aggregateCompleteness: 'exact' }),
    /vm-effect-aggregate-completeness-contradiction/,
    'a hand-made exact aggregate over partial bundles must be rejected',
  );
}

// 9. Structured aggregate values are never String()-coerced into enum tokens.
{
  assert.throws(
    () => createVMEffectFunction({ frontendId: 'wasm', methodId: 'm', bundles: [], aggregateCompleteness: ['exact'] }),
    /vm-effect-aggregate-completeness-invalid/,
    'an array aggregate value must not launder into the exact token',
  );
}

console.log('issue-5404 vm-effect aggregate completeness authority: ok');

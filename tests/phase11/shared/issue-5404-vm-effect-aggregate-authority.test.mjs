// Regression for #5404: createVMEffectFunction() adopted an explicit
// aggregateCompleteness without checking it against the bundles it summarizes
// (and without any enum check), so a function containing partial/unknown
// bundles published `aggregateCompleteness:'exact'` — and garbage strings
// passed through verbatim. validateVMEffectFunction() did not check the field
// either.
// Contract now: the explicit value must be inside the completeness taxonomy
// and may never out-claim the conservative derivation from the bundles;
// stronger declarations are demoted to the derived value, weaker (more
// conservative) declarations are honored, and garbage fails closed.
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

// 1. The issue's decisive scenario: 'exact' over a partial bundle is demoted.
{
  const fn = createVMEffectFunction({
    frontendId: 'wasm', methodId: 'method:1', bundles: [partialBundle],
    aggregateCompleteness: 'exact',
  });
  assert.equal(fn.aggregateCompleteness, 'partial', 'the aggregate must not out-claim its bundles');
  assert.equal(validateVMEffectFunction(fn), true);
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

console.log('issue-5404 vm-effect aggregate completeness authority: ok');

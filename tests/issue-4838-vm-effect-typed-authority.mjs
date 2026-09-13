// Regression for #4838: the canonical VM Effect constructor/budget boundary
// String()/Number()-coerced structured inputs, laundering Array/Object/boolean
// identity, completeness, offsets, versions, and budget limits/charges into
// normal scalar canonical authority. Typed contracts must fail closed.
import assert from 'node:assert/strict';
import {
  VM_EFFECTS_CONTRACT_VERSION,
  VM_EFFECTS_SCHEMA_VERSION,
  createVMEffectBudgetTracker,
  createVMEffectBundle,
  createVMEffectFunction,
  validateVMEffectBundle,
  validateVMEffectFunction,
} from '../js/managed/shared/vm-effects.js';

function canonical(overrides = {}) {
  return createVMEffectBundle({
    frontendId: 'wasm',
    methodId: 'method-4838',
    operationId: 'op-4838',
    bytecodeOffset: 0,
    mnemonic: 'nop',
    completeness: 'exact',
    ...overrides,
  });
}

// 1. Acceptance 1: structured identity/completeness never become canonical.
for (const field of ['frontendId', 'methodId', 'operationId']) {
  for (const value of [['wasm'], { toString: () => 'wasm' }, 42, true, '   ']) {
    assert.throws(
      () => canonical({ [field]: value }),
      (error) => error instanceof TypeError && error.message.startsWith(`vm-effect-${field.replace(/Id$/, '-id')}`),
      `${field} ${JSON.stringify(value)} must stay malformed`,
    );
  }
}
for (const value of [['exact'], { toString: () => 'exact' }, 'EXACT', true]) {
  assert.throws(
    () => canonical({ completeness: value }),
    (error) => error instanceof TypeError && /^vm-effect-.*completeness/.test(error.message),
    `completeness ${JSON.stringify(value)} must never be promoted to exact`,
  );
}

// 2. Acceptance 2: structured/numeric-string offsets and opcodes fail closed.
for (const value of [[16], '16', {}, true, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, -1]) {
  assert.throws(
    () => canonical({ bytecodeOffset: value }),
    (error) => error instanceof TypeError && error.message === 'vm-effect-offset-required',
    `bytecodeOffset ${JSON.stringify(value)} must not coerce to a legitimate integer`,
  );
  assert.throws(
    () => canonical({ opcode: value }),
    (error) => error instanceof TypeError && error.message === 'vm-effect-invalid-opcode',
    `opcode ${JSON.stringify(value)} must not coerce to a legitimate integer`,
  );
}
assert.equal(canonical({ bytecodeOffset: 16 }).bytecodeOffset, 16);
assert.equal(canonical({ opcode: 0, mnemonic: 'unreachable', controlEffects: [{ kind: 'trap' }] }).opcode, 0);
assert.equal(canonical().opcode, null);
assert.equal(canonical().bytecodeOffset, 0);

// 3. Acceptance 3: structured version/profile/semantic fields cannot match.
assert.throws(
  () => canonical({ schemaVersion: ['1'] }),
  (error) => error instanceof TypeError && error.message === 'vm-effect-schema-version-mismatch',
);
assert.throws(
  () => canonical({ schemaVersion: '1' }),
  /vm-effect-schema-version-mismatch/,
);
assert.throws(
  () => canonical({ contractVersion: ['1.0.0'] }),
  (error) => error instanceof TypeError && error.message === 'vm-effect-contract-version-mismatch',
);
assert.throws(
  () => canonical({ frontendSemanticVersion: ['1.0.0'] }),
  (error) => error instanceof TypeError && error.message === 'vm-effect-invalid-frontend-semantic-version',
);
assert.throws(
  () => canonical({ profileId: ['profile-4838'] }),
  (error) => error instanceof TypeError && error.message === 'vm-effect-invalid-profile-id',
);
assert.throws(
  () => canonical({ mnemonic: ['i32.add'] }),
  (error) => error instanceof TypeError && error.message === 'vm-effect-invalid-mnemonic',
);
assert.equal(canonical({ profileId: 'profile-4838' }).profileId, 'profile-4838');
assert.equal(canonical().profileId, null);
assert.equal(canonical().schemaVersion, VM_EFFECTS_SCHEMA_VERSION);
assert.equal(canonical().contractVersion, VM_EFFECTS_CONTRACT_VERSION);

// 4. Acceptance 4: budget limits and charges are primitive safe integers.
assert.throws(
  () => createVMEffectBudgetTracker({ budget: { maxOperations: ['1'] } }),
  (error) => error instanceof TypeError && error.message === 'vm-effect-invalid-budget-maxOperations',
);
assert.throws(
  () => createVMEffectBudgetTracker({ budget: { maxValues: '1' } }),
  (error) => error instanceof TypeError && error.message === 'vm-effect-invalid-budget-maxValues',
);
assert.throws(
  () => createVMEffectBudgetTracker({ budget: { maxExceptionRegions: true } }),
  (error) => error instanceof TypeError && error.message === 'vm-effect-invalid-budget-maxExceptionRegions',
);
{
  const tracker = createVMEffectBudgetTracker({ budget: { maxOperations: 2 } });
  assert.equal(tracker.limits.maxOperations, 2);
  assert.equal(tracker.limits.maxValues, 32768);
  for (const bad of [['1'], '1', true, {}, 1.5, -1]) {
    assert.throws(
      () => tracker.chargeOperation(bad),
      (error) => error instanceof TypeError && error.message === 'vm-effect-invalid-budget-charge',
      `structured charge ${JSON.stringify(bad)} must not be accepted`,
    );
    assert.throws(
      () => tracker.chargeValues(bad),
      /vm-effect-invalid-budget-charge/,
    );
    assert.throws(
      () => tracker.chargeExceptionRegions(bad),
      /vm-effect-invalid-budget-charge/,
    );
  }
  assert.equal(tracker.chargeOperation(), 1);
  assert.equal(tracker.chargeValues(2), 2);
  assert.equal(tracker.snapshot().operations, 1);
}

// 5. The function boundary shares the same typed identity contract.
assert.throws(
  () => createVMEffectFunction({ frontendId: ['wasm'], methodId: 'm', bundles: [] }),
  (error) => error instanceof TypeError && error.message === 'vm-effect-frontend-id-required',
);
assert.throws(
  () => createVMEffectFunction({ frontendId: 'wasm', methodId: ['m'], bundles: [] }),
  (error) => error instanceof TypeError && error.message === 'vm-effect-method-id-required',
);
assert.throws(
  () => createVMEffectFunction({
    frontendId: 'wasm', methodId: 'm', bundles: [], profileId: ['p'],
  }),
  (error) => error instanceof TypeError && error.message === 'vm-effect-invalid-profile-id',
);
assert.throws(
  () => createVMEffectFunction({
    frontendId: 'wasm', methodId: 'm', bundles: [], validationReportId: ['r'],
  }),
  (error) => error instanceof TypeError && error.message === 'vm-effect-invalid-validation-report-id',
);
assert.throws(
  () => createVMEffectFunction(
    { frontendId: 'wasm', methodId: 'm', bundles: [] },
    { budget: { maxOperations: ['0'] } },
  ),
  (error) => error instanceof TypeError && error.message === 'vm-effect-invalid-budget-maxOperations',
);

// 6. Acceptance 5: partial/unknown still require unknownEffects.
assert.throws(
  () => canonical({ completeness: 'partial', unknownEffects: [] }),
  /vm-effect-partial-must-specify-unknown-effects/,
);

// 7. Acceptance 6: valid canonical forms keep their shape and exactness.
{
  const valid = canonical({
    schemaVersion: VM_EFFECTS_SCHEMA_VERSION,
    contractVersion: VM_EFFECTS_CONTRACT_VERSION,
    frontendSemanticVersion: '1.0.0',
    opcode: 0x6a,
    mnemonic: 'i32.add',
    consumedValues: [{ id: 'lhs', bits: 32 }, { id: 'rhs', bits: 32 }],
    producedValues: [{ bits: 32 }],
    completeness: 'exact',
  });
  assert.equal(valid.completeness, 'exact');
  assert.equal(valid.opcode, 0x6a);
  assert.equal(valid.mnemonic, 'i32.add');
  assert.equal(validateVMEffectBundle(valid), true);
  const fn = createVMEffectFunction({
    frontendId: 'wasm', methodId: 'method-4838', profileId: 'p-1',
    bundles: [valid], validationReportId: 'report-1',
  });
  assert.equal(validateVMEffectFunction(fn), true);
  assert.equal(fn.profileId, 'p-1');
  assert.equal(fn.validationReportId, 'report-1');
  assert.equal(fn.aggregateCompleteness, 'exact');
}

// 8. Acceptance 7: the validator re-checks constructor invariants externally.
{
  const canonicalBundle = canonical();
  for (const [field, value, pattern] of [
    ['frontendId', ['wasm'], /vm-effect-bundle-missing-identity/],
    ['methodId', ['method-4838'], /vm-effect-bundle-missing-identity/],
    ['operationId', ['op-4838'], /vm-effect-bundle-missing-identity/],
    ['schemaVersion', '1', /vm-effect-schema-version-mismatch/],
    ['schemaVersion', ['1'], /vm-effect-schema-version-mismatch/],
    ['contractVersion', ['1.0.0'], /vm-effect-contract-version-mismatch/],
    ['bytecodeOffset', '0', /vm-effect-invalid-bytecode-offset/],
    ['bytecodeOffset', [0], /vm-effect-invalid-bytecode-offset/],
    ['opcode', ['1'], /vm-effect-invalid-opcode/],
    ['frontendSemanticVersion', ['1.0.0'], /vm-effect-invalid-frontend-semantic-version/],
    ['profileId', ['p'], /vm-effect-invalid-profile-id/],
    ['mnemonic', ['add'], /vm-effect-invalid-mnemonic/],
    ['completeness', ['exact'], /vm-effect-bundle-invalid-completeness/],
  ]) {
    assert.throws(
      () => validateVMEffectBundle({ ...canonicalBundle, [field]: value }),
      (error) => error instanceof TypeError && pattern.test(error.message),
      `validator must reject malformed ${field}=${JSON.stringify(value)}`,
    );
  }
  assert.throws(
    () => validateVMEffectFunction({
      ...createVMEffectFunction({ frontendId: 'wasm', methodId: 'method-4838', bundles: [] }),
      methodId: ['method-4838'],
    }),
    /vm-effect-function-invalid-structure/,
  );
  assert.throws(
    () => validateVMEffectFunction({
      ...createVMEffectFunction({ frontendId: 'wasm', methodId: 'method-4838', bundles: [] }),
      profileId: ['p'],
    }),
    /vm-effect-function-invalid-structure/,
  );
}

console.log('issue-4838 vm-effect typed authority boundary: ok');

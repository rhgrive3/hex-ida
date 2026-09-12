import assert from 'node:assert/strict';
import {
  VM_EFFECTS_CONTRACT_VERSION,
  VM_EFFECTS_SCHEMA_VERSION,
  createVMEffectBundle,
  createVMEffectFunction,
  validateVMEffectBundle,
  validateVMEffectFunction,
} from '../js/managed/shared/vm-effects.js';

const creatorInput = {
  operationId: 'vm-op:m:0x0:0',
  methodId: 'm',
  frontendId: 'wasm',
  completeness: 'exact',
};

const canonicalBundle = createVMEffectBundle({
  frontendId: 'wasm',
  methodId: 'managed-method:4801',
  operationId: 'vm-op:managed-method:4801:0x0:0',
  bytecodeOffset: 0,
  opcode: 0x6a,
  mnemonic: 'i32.add',
  completeness: 'exact',
  consumedValues: [{ id: 'vm-val:managed-method:4801:rhs', bits: 32 }],
  producedValues: [{ id: 'vm-val:managed-method:4801:res', bits: 32 }],
  locationReads: [{ kind: 'stack', index: 0 }],
  locationWrites: [{ kind: 'local', index: 1 }],
  memoryEffects: [{ kind: 'read', addressSpace: 'linear-memory' }],
  callEffects: [],
  controlEffects: [{ kind: 'fallthrough' }],
  possibleExceptions: [{ exceptionTypeId: 'managed-type:throwable' }],
  metadata: { source: 'issue-4801' },
});

function assertValidatorRejectsBundle(patch, creatorCode, validatorCode, label) {
  assert.throws(
    () => createVMEffectBundle({ ...creatorInput, ...patch }),
    creatorCode,
    `the creator must reject ${label}`,
  );
  assert.throws(
    () => validateVMEffectBundle({ ...canonicalBundle, ...patch }),
    validatorCode,
    `#4801 validator must reject ${label} that the creator rejects`,
  );
}

assert.equal(validateVMEffectBundle(canonicalBundle), true, 'a creator-produced bundle must validate');
assert.equal(canonicalBundle.schemaVersion, VM_EFFECTS_SCHEMA_VERSION);
assert.equal(canonicalBundle.contractVersion, VM_EFFECTS_CONTRACT_VERSION);

assert.throws(
  () => validateVMEffectBundle({ ...canonicalBundle, completeness: 'partial' }),
  /vm-effect-partial-must-specify-unknown-effects/,
  '#4801 acceptance 1: a partial bundle without unknownEffects must not validate',
);
assert.throws(
  () => validateVMEffectBundle({ ...canonicalBundle, completeness: 'unknown', unknownEffects: [] }),
  /vm-effect-partial-must-specify-unknown-effects/,
  '#4801 acceptance 1: an unknown bundle with an empty unknownEffects list must not validate',
);

assertValidatorRejectsBundle({ schemaVersion: 999 }, /vm-effect-schema-version-mismatch/,
  /vm-effect-schema-version-mismatch/, 'a foreign schema version');
assertValidatorRejectsBundle({ schemaVersion: {} }, /vm-effect-schema-version-mismatch/,
  /vm-effect-schema-version-mismatch/, 'a structured schema version');
assertValidatorRejectsBundle({ contractVersion: 'other' }, /vm-effect-contract-version-mismatch/,
  /vm-effect-contract-version-mismatch/, 'a foreign contract version');
assertValidatorRejectsBundle({ contractVersion: {} }, /vm-effect-contract-version-mismatch/,
  /vm-effect-contract-version-mismatch/, 'a structured contract version');

const effectArrays = [
  ['consumedValues', /vm-effect-invalid-consumed-values/],
  ['producedValues', /vm-effect-invalid-produced-values/],
  ['locationReads', /vm-effect-invalid-location-reads/],
  ['locationWrites', /vm-effect-invalid-location-writes/],
  ['memoryEffects', /vm-effect-invalid-memory-effects/],
  ['callEffects', /vm-effect-invalid-call-effects/],
  ['controlEffects', /vm-effect-invalid-control-effects/],
  ['possibleExceptions', /vm-effect-invalid-exceptions/],
];
for (const [field, code] of effectArrays) {
  assertValidatorRejectsBundle({ [field]: 'not-an-array' }, code, code, `a non-array ${field}`);
  assertValidatorRejectsBundle({ [field]: {} }, code, code, `a structured ${field}`);
}

for (const offset of [-5, 1.5, 'abc', 'NaN']) {
  assertValidatorRejectsBundle({ bytecodeOffset: offset }, /vm-effect-offset-required/,
    /vm-effect-invalid-bytecode-offset/, `an invalid bytecode offset ${String(offset)}`);
}

assertValidatorRejectsBundle({ methodId: '   ' }, /vm-effect-method-id-required/,
  /vm-effect-bundle-missing-identity/, 'a blank method identity');
assertValidatorRejectsBundle({ frontendId: '' }, /vm-effect-frontend-id-required/,
  /vm-effect-bundle-missing-identity/, 'an empty frontend identity');
assertValidatorRejectsBundle({ operationId: '   ' }, /vm-effect-operation-id-required/,
  /vm-effect-bundle-missing-identity/, 'a blank operation identity');
assertValidatorRejectsBundle({ completeness: 'exact-with-unknown' }, /vm-effect-invalid-completeness/,
  /vm-effect-bundle-invalid-completeness/, 'an invented completeness claim');
assertValidatorRejectsBundle({ completeness: 'partial', unknownEffects: [] },
  /vm-effect-partial-must-specify-unknown-effects/, /vm-effect-partial-must-specify-unknown-effects/,
  'a partial bundle with an empty unknownEffects list');

const canonicalFunction = createVMEffectFunction({
  frontendId: 'wasm',
  methodId: 'managed-method:4801',
  bundles: [canonicalBundle],
  exceptionRegions: [{ id: 'managed-exc:managed-method:4801:0', startOffset: 0, endOffset: 8, handlerOffset: 8 }],
});
assert.equal(validateVMEffectFunction(canonicalFunction), true, 'a creator-produced function must validate');

const functionBundleCases = [
  [{ schemaVersion: 999 }, /vm-effect-schema-version-mismatch/],
  [{ contractVersion: 'other' }, /vm-effect-contract-version-mismatch/],
  [{ consumedValues: 'not-an-array' }, /vm-effect-invalid-consumed-values/],
  [{ bytecodeOffset: -1 }, /vm-effect-invalid-bytecode-offset/],
  [{ completeness: 'partial', unknownEffects: [] }, /vm-effect-partial-must-specify-unknown-effects/],
];
for (const [patch, code] of functionBundleCases) {
  assert.throws(
    () => validateVMEffectFunction({ ...canonicalFunction, bundles: [{ ...canonicalFunction.bundles[0], ...patch }] }),
    code,
    `#4801 acceptance 5: a function carrying a ${Object.keys(patch).join('+')} bundle must not validate`,
  );
}

assert.throws(
  () => createVMEffectFunction({
    frontendId: 'wasm',
    methodId: 'managed-method:4801',
    bundles: [canonicalBundle],
    exceptionRegions: 'not-an-array',
  }),
  /vm-effect-function-exceptions-invalid/,
  'the function creator must reject a non-array exceptionRegions',
);
assert.throws(
  () => validateVMEffectFunction({ ...canonicalFunction, exceptionRegions: 'not-an-array' }),
  /vm-effect-function-exceptions-invalid/,
  '#4801: the function validator must reject a non-array exceptionRegions',
);
assert.throws(
  () => validateVMEffectFunction({ ...canonicalFunction, methodId: '   ' }),
  /vm-effect-function-missing-identity/,
  '#4801: the function validator must reject a blank method identity',
);
assert.throws(
  () => validateVMEffectFunction({ ...canonicalFunction, frontendId: '' }),
  /vm-effect-function-missing-identity/,
  '#4801: the function validator must reject an empty frontend identity',
);
assert.throws(
  () => validateVMEffectFunction({ ...canonicalFunction, bundles: {} }),
  /vm-effect-function-invalid-structure/,
  '#4801: the function validator must reject a non-array bundle collection',
);

const partialBundle = createVMEffectBundle({
  frontendId: 'wasm',
  methodId: 'managed-method:4801',
  operationId: 'vm-op:managed-method:4801:0x8:8',
  bytecodeOffset: 8,
  completeness: 'partial',
  unknownEffects: [{ category: 'memory', reason: 'unmodeled-linear-memory-store' }],
});
const partialFunction = createVMEffectFunction({
  frontendId: 'wasm',
  methodId: 'managed-method:4801',
  bundles: [canonicalBundle, partialBundle],
});
assert.equal(validateVMEffectBundle(partialBundle), true, 'a creator-produced partial bundle must validate');
assert.equal(validateVMEffectFunction(partialFunction), true, 'a creator-produced partial function must validate');
assert.equal(
  validateVMEffectFunction({ ...partialFunction, exceptionRegions: null }),
  true,
  'a null exceptionRegions tail stays consistent with the creator default',
);

console.log('issue-4801 vm-effect creator/validator contract parity: PASS');

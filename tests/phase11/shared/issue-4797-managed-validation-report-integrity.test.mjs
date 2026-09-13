import assert from 'node:assert/strict';
import {
  createManagedValidationReport,
  validateManagedValidationReport,
} from '../../../js/managed/shared/validation.js';

const complete = Object.freeze({
  structural: 'complete',
  specValidation: 'valid',
  semanticEffect: 'complete',
  resolution: 'complete',
});

const valid = createManagedValidationReport({
  targetId: 'managed-method:A',
  profileId: 'managed-profile:wasm:1:core-3.0',
  status: 'valid',
  completeness: complete,
  errors: [],
  warnings: [{ code: 'known-warning' }],
  verifierFacts: [{ kind: 'proof', value: true }],
});
assert.equal(validateManagedValidationReport(valid), true);

// Transported/plain JSON-shaped reports remain valid; validation must not rely
// on producer-object identity or frozen-object branding.
const transported = JSON.parse(JSON.stringify(valid));
assert.equal(validateManagedValidationReport(transported), true);

assert.throws(
  () => validateManagedValidationReport({ ...transported, targetId: 'managed-method:B' }),
  /managed-validation-report-id-mismatch/,
  'a stale report id must not validate after target reassignment',
);
assert.throws(
  () => validateManagedValidationReport({ ...transported, profileId: 'managed-profile:wasm:2:core-3.0' }),
  /managed-validation-report-id-mismatch/,
  'profile identity is part of the current canonical report id',
);
assert.throws(
  () => validateManagedValidationReport({
    ...transported,
    status: ' valid ',
  }),
  /managed-validation-report-incomplete/,
  'status spelling must remain canonical rather than being silently trimmed',
);
assert.throws(
  () => validateManagedValidationReport({
    ...transported,
    status: 'partial',
    completeness: {
      structural: 'partial',
      specValidation: 'partial',
      semanticEffect: 'partial',
      resolution: 'partial',
    },
  }),
  /managed-validation-report-id-mismatch/,
  'status/verdict identity is part of the current canonical report id',
);
assert.throws(
  () => validateManagedValidationReport({ ...transported, id: 'val-rep:not-canonical' }),
  /managed-validation-report-id-mismatch/,
  'arbitrary report ids must fail closed',
);

for (const [field, value, code] of [
  ['errors', 'not-an-array', /managed-validation-invalid-errors/],
  ['warnings', {}, /managed-validation-invalid-warnings/],
  ['verifierFacts', null, /managed-validation-invalid-facts/],
]) {
  assert.throws(
    () => validateManagedValidationReport({ ...transported, [field]: value }),
    code,
    `${field} must retain the constructor array contract`,
  );
}

assert.throws(
  () => validateManagedValidationReport({ ...transported, origin: null }),
  /managed-validation-origin-required/,
  'creator-required origin must remain present',
);
assert.throws(
  () => validateManagedValidationReport({ ...transported, origin: 'not-an-origin' }),
  /origin-invalid-set/,
  'malformed transported provenance must be validated at the public boundary',
);

// Canonical scalar spelling is part of identity. The creator trims these
// fields, so a transported report may not introduce whitespace aliases.
assert.throws(
  () => validateManagedValidationReport({
    ...transported,
    targetId: ` ${transported.targetId} `,
    id: transported.id,
  }),
  /managed-validation-report-incomplete|managed-validation-report-id-mismatch/,
);

console.log('issue-4797 managed validation report integrity regression passed');

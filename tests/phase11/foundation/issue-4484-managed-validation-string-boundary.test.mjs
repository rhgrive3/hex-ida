import assert from 'node:assert/strict';
import {
  MANAGED_VALIDATION_STATUS,
  createManagedValidationReport,
  validateManagedValidationReport,
} from '../../../js/managed/shared/validation.js';

console.log('[phase11] running managed validation scalar boundary regression for #4484...');

const targetId = 'managed-method:test:1';

const validReport = createManagedValidationReport({ targetId, status: 'valid', profileId: 'ecma-335' });
assert.equal(validReport.targetId, targetId);
assert.equal(validReport.status, 'valid');
assert.equal(validReport.profileId, 'ecma-335');
assert.equal(validateManagedValidationReport(validReport), true);

const defaultStatusReport = createManagedValidationReport({ targetId });
assert.equal(defaultStatusReport.status, 'valid');

for (const status of [['valid'], { value: 'valid' }, true, 1, null]) {
  assert.throws(
    () => createManagedValidationReport({ targetId, status }),
    /managed-validation-status-required/,
    `structured status must be rejected: ${JSON.stringify(status)}`,
  );
}

for (const malformedTargetId of [['managed-method:test:1'], { value: targetId }, true, 1]) {
  assert.throws(
    () => createManagedValidationReport({ targetId: malformedTargetId, status: 'valid' }),
    /managed-validation-target-id-required/,
    `structured targetId must be rejected: ${JSON.stringify(malformedTargetId)}`,
  );
}

for (const malformedProfileId of [['ecma-335'], { value: 'ecma-335' }, true, 1, '']) {
  assert.throws(
    () => createManagedValidationReport({ targetId, status: 'valid', profileId: malformedProfileId }),
    /managed-validation-profile-id-invalid/,
    `structured profileId must be rejected: ${JSON.stringify(malformedProfileId)}`,
  );
}

for (const status of MANAGED_VALIDATION_STATUS) {
  const report = createManagedValidationReport({ targetId, status });
  assert.equal(report.status, status);
  assert.equal(validateManagedValidationReport(report), true);
}

for (const malformedReport of [
  { targetId: [targetId], status: 'valid' },
  { targetId, status: ['valid'] },
  { targetId, status: 'valid', profileId: { value: 'ecma-335' } },
]) {
  assert.throws(
    () => validateManagedValidationReport(malformedReport),
    /managed-validation-report-incomplete/,
    `malformed report must not validate: ${JSON.stringify(malformedReport)}`,
  );
}

console.log('  ok #4484 managed validation scalar boundary regression passed');

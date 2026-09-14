import assert from 'node:assert/strict';
import {
  createManagedValidationReport,
  validateManagedValidationReport,
} from '../../../js/managed/shared/validation.js';
import { WasmFrontend } from '../../../js/managed/wasm/frontend.js';
import { DexFrontend } from '../../../js/managed/dex/frontend.js';
import { JvmFrontend } from '../../../js/managed/jvm/frontend.js';
import { CilFrontend } from '../../../js/managed/cil/frontend.js';
import { fixture as wasmFixture } from '../fixtures/wasm.mjs';
import { fixture as dexFixture } from '../fixtures/dex.mjs';
import { fixture as jvmFixture } from '../fixtures/jvm.mjs';
import { fixture as cilFixture } from '../fixtures/cil.mjs';

console.log('[phase11] running managed validation fail-closed regression for #4010...');

const targetId = 'managed-method:issue-4010';
const complete = {
  structural: 'complete',
  specValidation: 'valid',
  semanticEffect: 'complete',
  resolution: 'complete',
};

assert.throws(
  () => createManagedValidationReport({ targetId }),
  /managed-validation-status-required/,
  'target identity alone must not mint a valid validation report',
);

assert.throws(
  () => createManagedValidationReport({ targetId, status: 'valid' }),
  /managed-validation-completeness-required/,
  'valid status requires explicit completeness evidence on every authority axis',
);

const valid = createManagedValidationReport({ targetId, status: 'valid', completeness: complete });
assert.equal(validateManagedValidationReport(valid), true);

assert.throws(
  () => createManagedValidationReport({
    targetId,
    status: 'valid',
    completeness: { ...complete, resolution: ['complete'] },
  }),
  /managed-validation-resolution-completeness-invalid/,
  'authority axes must reject structured values instead of coercing them',
);
assert.throws(
  () => validateManagedValidationReport({
    targetId,
    status: 'valid',
    profileId: null,
    completeness: { ...complete, semanticEffect: 'unknown' },
  }),
  /managed-validation-semantic-completeness-invalid/,
  'tampered reports must use the same axis enums as the constructor',
);

const partial = createManagedValidationReport({ targetId, status: 'partial' });
assert.deepEqual(partial.completeness, {
  structural: 'partial',
  specValidation: 'partial',
  semanticEffect: 'partial',
  resolution: 'partial',
});
assert.equal(validateManagedValidationReport(partial), true);

const unsupported = createManagedValidationReport({ targetId, status: 'unsupported' });
assert.equal(unsupported.completeness.semanticEffect, 'partial');
assert.equal(unsupported.completeness.resolution, 'partial');
assert.notEqual(unsupported.completeness.specValidation, 'valid');
assert.equal(validateManagedValidationReport(unsupported), true);

const invalid = createManagedValidationReport({ targetId, status: 'invalid' });
assert.equal(invalid.completeness.specValidation, 'failed');
assert.equal(invalid.completeness.semanticEffect, 'partial');
assert.equal(invalid.completeness.resolution, 'partial');
assert.equal(validateManagedValidationReport(invalid), true);

for (const contradictory of [
  { targetId, status: 'valid', completeness: { ...complete, resolution: 'partial' } },
  { targetId, status: 'partial', completeness: complete },
  { targetId, status: 'unsupported', completeness: complete },
  { targetId, status: 'invalid', completeness: complete },
]) {
  assert.throws(
    () => validateManagedValidationReport(contradictory),
    /managed-validation-completeness-inconsistent/,
    `contradictory hand-made report must fail closed: ${JSON.stringify(contradictory)}`,
  );
}

for (const [name, Frontend, fixture] of [
  ['wasm', WasmFrontend, wasmFixture],
  ['dex', DexFrontend, dexFixture],
  ['jvm', JvmFrontend, jvmFixture],
  ['cil', CilFrontend, cilFixture],
]) {
  const frontend = new Frontend();
  const image = await frontend.open(fixture.createBytes());
  const methods = [];
  for await (const method of frontend.enumerateMethods(image)) methods.push(method);
  const method = fixture.selectDecodableMethod(methods);
  assert.ok(method, `${name} fixture must expose a decodable method`);
  const decoded = await frontend.decodeMethod(method, { image });
  const report = await frontend.validateMethod(decoded, { image });
  assert.equal(validateManagedValidationReport(report), true, `${name} report must satisfy the shared contract`);
  assert.match(report.completeness.resolution, /^(complete|partial)$/, `${name} must publish resolution completeness explicitly`);
}

console.log('  ok #4010 managed validation fail-closed regression passed');

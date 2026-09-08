// Regression for #5369: canonical metadata provider constructors trusted
// `.map()`/iterable semantics on collection fields, so a non-Array
// `evidenceIds` leaked the internal TypeError "(input.evidenceIds ?? []).map
// is not a function" instead of a metadata validation error (and a string
// would char-split into the canonical collection).
// Note: records/sections/reasons/diagnostics already fail closed on main via
// arrayField(); evidenceIds was the remaining hole at this boundary.
// Contract now: every canonical collection field requires Array shape —
// fail-closed with an explicit validation error, no char-splitting, no raw
// TypeError — while valid Array inputs keep their existing
// element-validation/dedupe/sort/freeze semantics.
import assert from 'node:assert/strict';
import {
  createLanguageMetadataRecord,
  createLanguageMetadataPage,
  createLanguageMetadataResult,
} from '../js/metadata/provider.js';

const identity = { providerId: 'p', providerVersion: '1', ecosystem: 'go', verdict: 'identity-unavailable' };

// 1. evidenceIds non-array object -> explicit validation error, not a raw TypeError.
assert.throws(
  () => createLanguageMetadataRecord({
    kind: 'symbol', entityId: 'entity-1', providerId: 'provider-1', providerVersion: '1',
    evidenceIds: { id: 'ev-1' },
  }),
  (error) => /metadata-record-evidence-ids-must-be-array/.test(error.message),
);

// 2. evidenceIds string -> same fail-closed boundary (no char-splitting).
assert.throws(
  () => createLanguageMetadataRecord({
    kind: 'symbol', entityId: 'entity-1', providerId: 'provider-1', providerVersion: '1',
    evidenceIds: 'abc',
  }),
  (error) => /metadata-record-evidence-ids-must-be-array/.test(error.message),
);

// 3. Valid Array inputs keep the existing element validation, dedupe, sort, freeze.
{
  const record = createLanguageMetadataRecord({
    kind: 'symbol', entityId: 'entity-1', providerId: 'provider-1', providerVersion: '1',
    evidenceIds: ['ev-2', 'ev-1', 'ev-2'],
  });
  assert.deepEqual(record.evidenceIds, ['ev-1', 'ev-2']);
  assert.ok(Object.isFrozen(record.evidenceIds));
  assert.throws(
    () => createLanguageMetadataRecord({
      kind: 'symbol', entityId: 'entity-1', providerId: 'provider-1', providerVersion: '1',
      evidenceIds: [''],
    }),
    (error) => /metadata-record-invalid-evidence-id/.test(error.message),
    'per-element string validation must be preserved',
  );
}

// 4. records already fail closed on non-array (no char-split page).
assert.throws(
  () => createLanguageMetadataPage({ records: 'ab' }),
  (error) => /metadata-page-records-must-be-array/.test(error.message),
);

// 5. sections/reasons/diagnostics already fail closed on non-array.
assert.throws(
  () => createLanguageMetadataResult({
    identity,
    sections: 'text',
    completeness: { complete: false, reasons: 'bad' },
    diagnostics: 'oops',
  }),
  (error) => /metadata-result-sections-must-be-array/.test(error.message),
);

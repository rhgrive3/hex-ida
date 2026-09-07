// Regression for #5954: isLanguageRecordAuthoritative() required the whole
// result to be complete before evaluating coverage, but built-in providers
// emit `matched-partial` exactly when the run is incomplete — so every
// covered record was rejected before the coverage logic ran, making the
// documented matched-partial hard-authority contract a dead path. Whole-run
// completeness now gates `matched-authoritative` only; `matched-partial`
// records qualify through their explicit coverage proof, and fail-closed
// runs publish nothing for either verdict.
import assert from 'node:assert/strict';
import {
  createLanguageMetadataIdentity,
  createLanguageMetadataRecord,
  createLanguageMetadataResult,
  isLanguageRecordAuthoritative,
} from '../js/metadata/provider.js';

function partialResult({ verdict = 'matched-partial', complete = false, statusExtra = {} } = {}) {
  const identity = createLanguageMetadataIdentity({
    verdict,
    providerId: 'swift',
    providerVersion: '1',
    ecosystem: 'swift',
    binaryIdentity: 'sha256:swift-app',
    architecture: 'arm64',
    platform: 'darwin',
    method: 'swift-section-probe',
    ...(verdict === 'matched-partial' ? {
      coverage: { recordKinds: ['type'], addresses: ['0x1000'] },
    } : {}),
  });
  return createLanguageMetadataResult({
    providerId: 'swift',
    providerVersion: '1',
    ecosystem: 'swift',
    identity,
    sections: ['__swift5_types'],
    completeness: { present: true, declared: 4, scanned: 1, parsed: 1, complete },
    ...statusExtra,
  });
}

const covered = createLanguageMetadataRecord({
  providerId: 'swift', providerVersion: '1', ecosystem: 'swift',
  entityId: 'swift:type:partialtype', kind: 'type', address: '0x1000', name: 'PartialType',
});
const outside = createLanguageMetadataRecord({
  providerId: 'swift', providerVersion: '1', ecosystem: 'swift',
  entityId: 'swift:type:outsidetype', kind: 'type', address: '0x9999', name: 'OutsideType',
});

// 1: complete matched-authoritative stays hard.
{
  const result = partialResult({ verdict: 'matched-authoritative', complete: true });
  assert.equal(isLanguageRecordAuthoritative(result, covered), true, 'complete authoritative records stay hard');
}

// 2: incomplete matched-partial with explicit coverage is hard for covered records.
{
  const result = partialResult({ verdict: 'matched-partial', complete: false });
  assert.equal(result.completeness.complete, false);
  assert.equal(isLanguageRecordAuthoritative(result, covered), true,
    'a covered record of a partial scan must reach the coverage logic and become hard');
  // 3: outside the coverage stays soft.
  assert.equal(isLanguageRecordAuthoritative(result, outside), false, 'records outside the coverage stay soft');
}

// 4: fail-closed runs publish nothing, even inside coverage.
{
  const result = partialResult({
    verdict: 'matched-partial', complete: false,
    statusExtra: {
      snapshotId: 'snapshot-A',
      status: { snapshotId: 'snapshot-A', analyzerId: 'swift', analyzerVersion: '1', completeness: 'truncated', stopReason: 'timeout' },
    },
  });
  assert.equal(isLanguageRecordAuthoritative(result, covered), false, 'fail-closed runs never publish hard records');
}

// 5: covered record against a mismatched provider identity stays soft.
{
  const result = partialResult({ verdict: 'matched-partial', complete: false });
  const foreign = createLanguageMetadataRecord({
    providerId: 'other', providerVersion: '1', ecosystem: 'swift',
    entityId: 'other:type:partialtype', kind: 'type', address: '0x1000', name: 'PartialType',
  });
  assert.equal(isLanguageRecordAuthoritative(result, foreign), false, 'provider mismatch keeps records soft');
}

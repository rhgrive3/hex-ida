import assert from 'node:assert/strict';
import test from 'node:test';

import { createDebugProviderResult } from '../../../js/analysis/debug/provider.js';
import { createAnalysisStatus } from '../../../js/analysis/status.js';

const identity = {
  verdict: 'matched-authoritative',
  providerId: 'status-validation-provider',
  providerVersion: '1',
  expected: 'build-A',
  observed: 'build-A',
  method: 'build-id',
};

function result(status) {
  return createDebugProviderResult({ ecosystem: 'dwarf', identity, status });
}

const validStatus = {
  snapshotId: 'snapshot-A',
  analyzerId: 'debug-status-validation',
  analyzerVersion: '1',
  completeness: 'complete',
};

test('#3472 raw and canonical valid status remain accepted', () => {
  const raw = result(validStatus);
  assert.equal(raw.status.schemaVersion, 1);
  assert.equal(raw.status.completeness, 'complete');
  assert.equal(raw.status.stopReason, null);

  const canonical = createAnalysisStatus(validStatus);
  const fromCanonical = result(canonical);
  assert.deepEqual(fromCanonical.status, canonical);
});

test('#3472 schemaVersion cannot bypass completeness/stopReason validation', () => {
  assert.throws(
    () => result({
      ...validStatus,
      schemaVersion: 1,
      completeness: 'complete',
      stopReason: 'cancelled',
    }),
    /analysis-status-complete-cannot-stop-early/,
  );
});

test('#3472 schemaVersion cannot bypass status identity validation', () => {
  assert.throws(
    () => result({ ...validStatus, schemaVersion: 1, analyzerId: ['debug-status-validation'] }),
    /analysis-status-analyzer-required/,
  );
  assert.throws(
    () => result({ ...validStatus, schemaVersion: 1, snapshotId: { id: 'snapshot-A' } }),
    /analysis-status-snapshot-required/,
  );
});

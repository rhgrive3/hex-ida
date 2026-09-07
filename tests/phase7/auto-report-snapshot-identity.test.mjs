import assert from 'node:assert/strict';

import { __autoReportIdentityInternalsForTests } from '../../js/analysis/auto-report-identity.js';

const { bindValue, sameIdentity, liveIdentity } = __autoReportIdentityInternalsForTests;

function app() {
  return {
    backend: { gen: 1, binaryId: 'bin-A' },
    analysisEpoch: 1,
    store: { get(key) { return key === 'sliceIndex' ? 0 : null; } },
  };
}

{
  const report = { snapshotId: 'snapshot-current' };
  const bound = bindValue(app(), { snapshotId: 'snapshot-current', report }, 'snapshot-current');
  assert.equal(bound.identity?.snapshotId, 'snapshot-current');
  assert.equal(bound.value.report.snapshotId, 'snapshot-current');
}

{
  const report = {};
  const bound = bindValue(app(), { snapshotId: 'snapshot-current', report }, 'snapshot-current');
  assert.equal(bound.identity?.snapshotId, 'snapshot-current');
  assert.equal(report.snapshotId, 'snapshot-current', 'wrapper snapshotId must still backfill a missing report snapshotId');
}

{
  const report = { snapshotId: 'snapshot-old' };
  const bound = bindValue(app(), { snapshotId: 'snapshot-current', report }, 'snapshot-current');
  assert.equal(bound.identity, null, 'conflicting wrapper/report snapshot identities must fail closed');
  assert.equal(report.snapshotId, 'snapshot-old', 'rejected reports must not be rewritten');
}

{
  const currentApp = app();
  const bound = bindValue(currentApp, {
    snapshotId: 'snapshot-current',
    report: { snapshotId: 'snapshot-current' },
  }, 'snapshot-current');
  assert.equal(
    sameIdentity(bound.identity, liveIdentity(currentApp, 'snapshot-current')),
    true,
    'existing sameIdentity/liveIdentity comparison must continue accepting a matching current snapshot',
  );
}

console.log('phase7 auto-report snapshot identity boundary: PASS');

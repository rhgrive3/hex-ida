import test from 'node:test';
import assert from 'node:assert/strict';

import { installAutoReportIdentityBoundary } from '../../js/analysis/auto-report-identity.js';

function makeApp(analysisQueries, { binaryId = 'bin-A', gen = 1 } = {}) {
  return {
    analysisQueries,
    backend: { binaryId, gen },
    store: {
      get(key) {
        if (key === 'sliceIndex') return 0;
        if (key === 'project') return { revision: 0 };
        return null;
      },
    },
  };
}

function reportFor(snapshotId, marker) {
  return {
    snapshotId,
    report: { snapshotId, marker },
  };
}

test('#4869 shared snapshot owner updates every installed app boundary', async () => {
  let calls = 0;
  const sharedQueries = {
    async snapshot() {
      calls++;
      assert.equal(this, sharedQueries, 'snapshot receiver must remain the shared query owner');
      return { snapshotId: 'snap-new' };
    },
  };
  const appA = makeApp(sharedQueries);
  const appB = makeApp(sharedQueries);
  installAutoReportIdentityBoundary(appA);
  installAutoReportIdentityBoundary(appB);

  const oldA = reportFor('snap-old', 'A');
  const oldB = reportFor('snap-old', 'B');
  appA.autoReport = oldA;
  appB.autoReport = oldB;

  await appB.analysisQueries.snapshot();

  assert.equal(calls, 1, 'one shared snapshot call must invoke the producer once');
  assert.equal(appA.autoReport, null);
  assert.equal(appB.autoReport, null, 'second subscriber must observe the new snapshot too');
  assert.equal(appA.historicalAutoReport?.report?.marker, 'A');
  assert.equal(appB.historicalAutoReport?.report?.marker, 'B');
});

test('#4869 a subscriber installed after a successful shared snapshot inherits its identity', async () => {
  const sharedQueries = {
    async snapshot() { return { snapshotId: 'snap-current' }; },
  };
  const appA = makeApp(sharedQueries);
  installAutoReportIdentityBoundary(appA);
  await sharedQueries.snapshot();

  const appB = makeApp(sharedQueries);
  installAutoReportIdentityBoundary(appB);
  appB.autoReport = reportFor('snap-old', 'late-stale');

  assert.equal(appB.autoReport, null, 'late subscriber must not regain an already-stale report');
  assert.equal(appB.historicalAutoReport?.report?.marker, 'late-stale');
});

test('#4869 a late subscriber still accepts a report for the remembered current snapshot', async () => {
  const sharedQueries = {
    async snapshot() { return { snapshotId: 'snap-current' }; },
  };
  const appA = makeApp(sharedQueries);
  installAutoReportIdentityBoundary(appA);
  await sharedQueries.snapshot();

  const appB = makeApp(sharedQueries);
  installAutoReportIdentityBoundary(appB);
  const current = reportFor('snap-current', 'late-current');
  appB.autoReport = current;

  assert.equal(appB.autoReport?.report?.marker, 'late-current');
  assert.equal(appB.historicalAutoReport, null);
});

test('#4869 rejected shared snapshot does not publish a new snapshot identity', async () => {
  const failure = new Error('snapshot-failed');
  const sharedQueries = {
    async snapshot() { throw failure; },
  };
  const appA = makeApp(sharedQueries);
  const appB = makeApp(sharedQueries);
  installAutoReportIdentityBoundary(appA);
  installAutoReportIdentityBoundary(appB);
  appA.autoReport = reportFor('snap-old', 'A');
  appB.autoReport = reportFor('snap-old', 'B');

  await assert.rejects(sharedQueries.snapshot(), (error) => error === failure);
  assert.equal(appA.autoReport?.report?.marker, 'A');
  assert.equal(appB.autoReport?.report?.marker, 'B');
  assert.equal(appA.historicalAutoReport, null);
  assert.equal(appB.historicalAutoReport, null);
});

test('#4869 separate snapshot owners retain independent subscriber state', async () => {
  const queriesA = { async snapshot() { return { snapshotId: 'snap-A-new' }; } };
  const queriesB = { async snapshot() { return { snapshotId: 'snap-B-old' }; } };
  const appA = makeApp(queriesA, { binaryId: 'bin-A' });
  const appB = makeApp(queriesB, { binaryId: 'bin-B' });
  installAutoReportIdentityBoundary(appA);
  installAutoReportIdentityBoundary(appB);
  appA.autoReport = reportFor('snap-A-old', 'A');
  appB.autoReport = reportFor('snap-B-old', 'B');

  await queriesA.snapshot();
  assert.equal(appA.autoReport, null);
  assert.equal(appB.autoReport?.report?.marker, 'B');
});

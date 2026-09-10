import assert from 'node:assert/strict';
import test from 'node:test';

import { AnalysisQueryAPI } from '../../../js/analysis/query/api.js';
import {
  AnalysisSnapshotStaleError,
  createAnalysisSnapshot,
} from '../../../js/analysis/query/snapshot.js';

function mutableSnapshot(identity) {
  const canonical = createAnalysisSnapshot(identity);
  return {
    ...canonical,
    artifactVersions: structuredClone(canonical.artifactVersions),
  };
}

function stale(error) {
  return error instanceof AnalysisSnapshotStaleError && error.code === 'analysis-snapshot-stale';
}

test('#5131 canonical frozen snapshots keep the same query identity', async () => {
  const identity = {
    binaryId: 'bin-5131-control',
    projectRevision: 4,
    analysisEpoch: 9,
    artifactVersions: { semantic: { revision: 3 } },
  };
  const snapshot = createAnalysisSnapshot(identity);
  let received = null;
  const api = new AnalysisQueryAPI({
    async currentIdentity() { return identity; },
    async binaryInfo(querySnapshot) {
      received = querySnapshot;
      return { value: { ok: true }, status: { completeness: 'complete' } };
    },
  });

  const result = await api.binaryInfo(snapshot);
  assert.equal(result.snapshotId, snapshot.snapshotId);
  assert.equal(result.analysisEpoch, snapshot.analysisEpoch);
  assert.equal(received.snapshotId, snapshot.snapshotId);
  assert.equal(received.analysisEpoch, snapshot.analysisEpoch);
});

test('#5131 mutation while the pre-query identity read is pending cannot retarget a validated snapshot', async () => {
  const snapshot = mutableSnapshot({ binaryId: 'bin-5131-A', projectRevision: 0, analysisEpoch: 1 });
  let releaseIdentity;
  let identityCalls = 0;
  const api = new AnalysisQueryAPI({
    currentIdentity() {
      identityCalls++;
      if (identityCalls === 1) return new Promise((resolve) => { releaseIdentity = resolve; });
      return { binaryId: 'bin-5131-B', projectRevision: 0, analysisEpoch: 2, artifactVersions: {} };
    },
    async binaryInfo() {
      return { value: { ok: true }, status: { completeness: 'complete' } };
    },
  });

  const pending = api.binaryInfo(snapshot);
  assert.equal(typeof releaseIdentity, 'function', 'pre-query currentIdentity must be pending before mutation');
  snapshot.binaryId = 'bin-5131-B';
  snapshot.analysisEpoch = 2;
  releaseIdentity({ binaryId: 'bin-5131-B', projectRevision: 0, analysisEpoch: 2, artifactVersions: {} });

  await assert.rejects(pending, stale);
});

test('#5131 mutation while the query body is pending cannot retarget the post-query stale check', async () => {
  const identityA = { binaryId: 'bin-5131-body-A', projectRevision: 2, analysisEpoch: 7, artifactVersions: {} };
  const identityB = { binaryId: 'bin-5131-body-B', projectRevision: 2, analysisEpoch: 8, artifactVersions: {} };
  const snapshot = mutableSnapshot(identityA);
  let current = identityA;
  let releaseQuery;
  let enterQuery;
  const queryEntered = new Promise((resolve) => { enterQuery = resolve; });
  const queryResult = new Promise((resolve) => { releaseQuery = resolve; });
  const api = new AnalysisQueryAPI({
    async currentIdentity() { return current; },
    binaryInfo() {
      enterQuery();
      return queryResult;
    },
  });

  const pending = api.binaryInfo(snapshot);
  await queryEntered;
  snapshot.binaryId = identityB.binaryId;
  snapshot.analysisEpoch = identityB.analysisEpoch;
  current = identityB;
  releaseQuery({ value: { ok: true }, status: { completeness: 'complete' } });

  await assert.rejects(pending, stale);
});

test('#5131 artifactVersions replacement is pinned before the first await', async () => {
  const snapshot = mutableSnapshot({
    binaryId: 'bin-5131-artifact-replace',
    projectRevision: 1,
    analysisEpoch: 5,
    artifactVersions: { semantic: { revision: 1 } },
  });
  let releaseIdentity;
  let identityCalls = 0;
  const api = new AnalysisQueryAPI({
    currentIdentity() {
      identityCalls++;
      if (identityCalls === 1) return new Promise((resolve) => { releaseIdentity = resolve; });
      return {
        binaryId: snapshot.binaryId,
        projectRevision: snapshot.projectRevision,
        analysisEpoch: snapshot.analysisEpoch,
        artifactVersions: { semantic: { revision: 2 } },
      };
    },
    async binaryInfo() { return { value: null, status: { completeness: 'complete' } }; },
  });

  const pending = api.binaryInfo(snapshot);
  assert.equal(typeof releaseIdentity, 'function');
  snapshot.artifactVersions = { semantic: { revision: 2 } };
  releaseIdentity({
    binaryId: snapshot.binaryId,
    projectRevision: snapshot.projectRevision,
    analysisEpoch: snapshot.analysisEpoch,
    artifactVersions: { semantic: { revision: 2 } },
  });

  await assert.rejects(pending, stale);
});

test('#5131 nested artifactVersions mutation during query execution cannot rewrite attribution', async () => {
  const identityA = {
    binaryId: 'bin-5131-artifact-nested',
    projectRevision: 1,
    analysisEpoch: 6,
    artifactVersions: { semantic: { revision: 1, producer: 'A' } },
  };
  const snapshot = mutableSnapshot(identityA);
  let current = identityA;
  let releaseQuery;
  let enterQuery;
  const queryEntered = new Promise((resolve) => { enterQuery = resolve; });
  const queryResult = new Promise((resolve) => { releaseQuery = resolve; });
  const api = new AnalysisQueryAPI({
    async currentIdentity() { return current; },
    binaryInfo() {
      enterQuery();
      return queryResult;
    },
  });

  const pending = api.binaryInfo(snapshot);
  await queryEntered;
  snapshot.artifactVersions.semantic.revision = 2;
  snapshot.artifactVersions.semantic.producer = 'B';
  current = {
    ...identityA,
    artifactVersions: { semantic: { revision: 2, producer: 'B' } },
  };
  releaseQuery({ value: { ok: true }, status: { completeness: 'complete' } });

  await assert.rejects(pending, stale);
});

test('#5131 caller mutation does not change the pinned snapshot seen by the producer or result envelope', async () => {
  const identityA = {
    binaryId: 'bin-5131-pinned-producer',
    projectRevision: 8,
    analysisEpoch: 11,
    artifactVersions: { semantic: { revision: 4 } },
  };
  const snapshot = mutableSnapshot(identityA);
  const originalSnapshotId = snapshot.snapshotId;
  let received;
  let releaseQuery;
  let enterQuery;
  const queryEntered = new Promise((resolve) => { enterQuery = resolve; });
  const queryResult = new Promise((resolve) => { releaseQuery = resolve; });
  const api = new AnalysisQueryAPI({
    async currentIdentity() { return identityA; },
    binaryInfo(querySnapshot) {
      received = querySnapshot;
      enterQuery();
      return queryResult;
    },
  });

  const pending = api.binaryInfo(snapshot);
  await queryEntered;
  snapshot.binaryId = 'bin-5131-caller-mutated';
  snapshot.analysisEpoch = 99;
  snapshot.artifactVersions.semantic.revision = 99;
  releaseQuery({ value: { ok: true }, status: { completeness: 'complete' } });

  const result = await pending;
  assert.notEqual(received, snapshot, 'producer must receive the detached validated snapshot');
  assert.equal(received.binaryId, identityA.binaryId);
  assert.equal(received.analysisEpoch, identityA.analysisEpoch);
  assert.equal(received.artifactVersions.semantic.revision, 4);
  assert.equal(Object.isFrozen(received), true);
  assert.equal(Object.isFrozen(received.artifactVersions.semantic), true);
  assert.equal(result.snapshotId, originalSnapshotId);
  assert.equal(result.analysisEpoch, identityA.analysisEpoch);
});

test('#5131 A-to-B Proxy reads cannot retarget the one-shot validated identity', async () => {
  const snapshotA = mutableSnapshot({
    binaryId: 'bin-5131-proxy-A',
    projectRevision: 3,
    analysisEpoch: 12,
    artifactVersions: { semantic: { revision: 7 } },
  });
  const snapshotB = mutableSnapshot({
    binaryId: 'bin-5131-proxy-B',
    projectRevision: 3,
    analysisEpoch: 13,
    artifactVersions: { semantic: { revision: 8 } },
  });
  let active = snapshotA;
  let schemaReads = 0;
  const proxy = new Proxy(snapshotA, {
    get(_target, property) {
      if (property === 'schemaVersion') {
        schemaReads++;
        if (schemaReads === 2) active = snapshotB;
      }
      return Reflect.get(active, property);
    },
  });
  let producerCalls = 0;
  const api = new AnalysisQueryAPI({
    async currentIdentity() {
      return {
        binaryId: snapshotB.binaryId,
        projectRevision: snapshotB.projectRevision,
        analysisEpoch: snapshotB.analysisEpoch,
        artifactVersions: snapshotB.artifactVersions,
      };
    },
    async binaryInfo() {
      producerCalls++;
      return { value: { ok: true }, status: { completeness: 'complete' } };
    },
  });

  await assert.rejects(api.binaryInfo(proxy), stale);
  assert.equal(schemaReads, 0, 'pinning must not property-read the caller-owned Proxy');
  assert.equal(producerCalls, 0, 'identity B must not bypass stale admission');
});

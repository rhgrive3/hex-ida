import assert from 'node:assert/strict';

import { AnalysisQueryAPI } from '../../../js/analysis/query/api.js';
import { AnalysisSnapshotStaleError } from '../../../js/analysis/query/snapshot.js';

const identity = (artifactVersions) => ({
  binaryId: 'bin_artifact_versions_identity',
  projectRevision: 7,
  analysisEpoch: 11,
  artifactVersions,
});

async function assertMalformedCurrentIdentity(malformed) {
  let identityCalls = 0;
  let queryCalls = 0;
  const adapter = {
    async currentIdentity() {
      identityCalls += 1;
      return identity(identityCalls === 1 ? {} : malformed);
    },
    async binaryInfo() {
      queryCalls += 1;
      return { value:'ok', status:{ completeness:'complete' } };
    },
  };

  const api = new AnalysisQueryAPI(adapter);
  const snapshot = await api.snapshot();
  await assert.rejects(
    api.binaryInfo(snapshot),
    (error) => error instanceof AnalysisSnapshotStaleError && error.code === 'analysis-snapshot-stale',
    `malformed artifactVersions ${Object.prototype.toString.call(malformed)} must fail closed as stale`,
  );
  assert.equal(queryCalls, 0, 'stale identity must be rejected before the query provider executes');
}

for (const malformed of [
  false,
  0,
  '',
  [],
  ['symbols-v1'],
  new (class ArtifactVersions { constructor() { this.symbols = 'v1'; } })(),
]) {
  await assertMalformedCurrentIdentity(malformed);
}

let nullishCalls = 0;
const nullishApi = new AnalysisQueryAPI({
  async currentIdentity() {
    nullishCalls += 1;
    if (nullishCalls === 1) return identity({});
    if (nullishCalls === 2) return identity(null);
    return identity(undefined);
  },
  async binaryInfo() {
    return { value:'ok', status:{ completeness:'complete' } };
  },
});
const nullishSnapshot = await nullishApi.snapshot();
const nullishResult = await nullishApi.binaryInfo(nullishSnapshot);
assert.equal(nullishResult.completeness, 'complete', 'nullish artifactVersions keeps the existing empty-set identity');
assert.equal(nullishResult.value, 'ok');

const nullPrototypeVersions = Object.assign(Object.create(null), { symbols:'v1' });
let plainCalls = 0;
const plainApi = new AnalysisQueryAPI({
  async currentIdentity() {
    plainCalls += 1;
    return identity(plainCalls === 2 ? nullPrototypeVersions : { symbols:'v1' });
  },
  async binaryInfo() {
    return { value:'ok', status:{ completeness:'complete' } };
  },
});
const plainSnapshot = await plainApi.snapshot();
const plainResult = await plainApi.binaryInfo(plainSnapshot);
assert.equal(plainResult.completeness, 'complete', 'plain and null-prototype artifact maps with equal content remain equivalent');
assert.equal(plainResult.value, 'ok');

console.log('phase7 AnalysisQuery artifactVersions stale identity #3565: PASS');

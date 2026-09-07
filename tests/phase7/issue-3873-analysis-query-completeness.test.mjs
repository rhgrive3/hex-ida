import assert from 'node:assert/strict';
import test from 'node:test';
import { AnalysisQueryAPI } from '../../js/analysis/query/api.js';

const identity = Object.freeze({
  binaryId: 'issue-3873-bin',
  projectRevision: 0,
  analysisEpoch: 0,
  artifactVersions: {},
});

async function queryResult(result) {
  const api = new AnalysisQueryAPI({
    currentIdentity: async () => identity,
    binaryInfo: async () => result,
  });
  const snapshot = await api.snapshot();
  return api.binaryInfo(snapshot);
}

test('issue 3873: negative completeness flags override contradictory complete status', async () => {
  for (const [flag, expected] of [
    ['unsupported', 'unsupported'],
    ['truncated', 'truncated'],
    ['partial', 'partial'],
  ]) {
    const result = await queryResult({
      value: ['partial-result'],
      status: { completeness: 'complete' },
      [flag]: true,
    });
    assert.equal(result.completeness, expected, flag);
    assert.equal(result.status.completeness, expected, flag);
  }

  const incomplete = await queryResult({
    value: ['partial-result'],
    status: { completeness: 'complete' },
    complete: false,
  });
  assert.equal(incomplete.completeness, 'partial');
  assert.equal(incomplete.status.completeness, 'partial');
});

test('issue 3873: canonical completeness remains unchanged without contradictory flags', async () => {
  for (const expected of ['complete', 'partial', 'truncated', 'unsupported']) {
    const result = await queryResult({
      value: [],
      status: { completeness: expected },
    });
    assert.equal(result.completeness, expected);
    assert.equal(result.status.completeness, expected);
  }
});

test('issue 3873: malformed completeness still fails closed to partial', async () => {
  const result = await queryResult({
    value: [],
    status: { completeness: 'definitely-complete' },
  });
  assert.equal(result.completeness, 'partial');
  assert.equal(result.status.completeness, 'partial');
});

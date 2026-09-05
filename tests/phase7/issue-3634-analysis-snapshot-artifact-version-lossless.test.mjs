import assert from 'node:assert/strict';
import {
  AnalysisSnapshotStaleError,
  assertAnalysisSnapshot,
  createAnalysisSnapshot,
} from '../../js/analysis/query/snapshot.js';
import { AnalysisQueryAPI } from '../../js/analysis/query/api.js';

const base = {
  binaryId: 'bin',
  projectRevision: 1,
  analysisEpoch: 2,
  createdAt: '2026-09-05T00:00:00.000Z',
};

const canonicalVersions = {
  semantic: 'v2',
  decoder: 7,
  score: 0.5,
  enabled: true,
  optional: null,
  nested: { branch: ['a', 2, false, null] },
};

const canonical = createAnalysisSnapshot({
  ...base,
  artifactVersions: canonicalVersions,
});
const reordered = createAnalysisSnapshot({
  ...base,
  artifactVersions: {
    nested: { branch: ['a', 2, false, null] },
    optional: null,
    enabled: true,
    score: 0.5,
    decoder: 7,
    semantic: 'v2',
  },
});
assert.deepEqual(canonical.artifactVersions, canonicalVersions);
assert.equal(reordered.snapshotId, canonical.snapshotId, 'valid JSON-safe version maps must preserve canonical identity');

const invalidValues = [
  ['NaN', NaN],
  ['positive infinity', Infinity],
  ['negative infinity', -Infinity],
  ['undefined', undefined],
  ['function', () => {}],
  ['symbol', Symbol('version')],
  ['bigint', 1n],
  ['date', new Date('2026-09-05T00:00:00.000Z')],
  ['bytes', new Uint8Array([1, 2])],
  ['map', new Map([['v', 1]])],
  ['set', new Set(['v1'])],
];

for (const [name, value] of invalidValues) {
  assert.throws(
    () => createAnalysisSnapshot({
      ...base,
      artifactVersions: { semantic: value },
    }),
    (error) => error instanceof TypeError
      && error.message === 'analysis-snapshot-artifact-version-value-invalid',
    `${name} must not become snapshot identity material`,
  );
}

assert.throws(
  () => createAnalysisSnapshot({
    ...base,
    artifactVersions: { semantic: { nested: undefined } },
  }),
  (error) => error instanceof TypeError
    && error.message === 'analysis-snapshot-artifact-version-value-invalid',
  'nested lossy values must fail closed',
);

const nullSnapshot = createAnalysisSnapshot({
  ...base,
  artifactVersions: { semantic: null },
});
assert.throws(
  () => assertAnalysisSnapshot({
    ...nullSnapshot,
    artifactVersions: { semantic: NaN },
  }),
  (error) => error instanceof TypeError
    && error.message === 'analysis-snapshot-artifact-version-value-invalid',
  'snapshot assertion must use the same artifact-version policy',
);

let queryStarts = 0;
const api = new AnalysisQueryAPI({
  async currentIdentity() {
    return {
      binaryId: 'bin',
      projectRevision: 1,
      analysisEpoch: 2,
      artifactVersions: { semantic: NaN },
    };
  },
  async binaryInfo() {
    queryStarts++;
    return { value: { format: 'test' }, status: { completeness: 'complete' } };
  },
});

await assert.rejects(
  api.binaryInfo(nullSnapshot),
  (error) => error instanceof AnalysisSnapshotStaleError
    && error.code === 'analysis-snapshot-stale',
  'malformed current artifact versions must fail the stale check',
);
assert.equal(queryStarts, 0, 'stale/malformed identity must fail before query execution');

console.log('issue-3634 analysis snapshot artifact version lossless regression: PASS');

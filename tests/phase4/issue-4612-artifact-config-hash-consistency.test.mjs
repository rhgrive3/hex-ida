import assert from 'node:assert/strict';
import {
  canonicalConfigHash,
  createArtifactDescriptor,
} from '../../js/core/artifacts/contracts.js';

const BIN = `bin_sha256_${'46'.repeat(32)}`;
const BASE = Object.freeze({
  binaryId: BIN,
  artifactKind: 'issue-4612-config-hash',
  producerId: 'issue-4612-regression',
  producerVersion: '1',
  versions: Object.freeze({
    loader: '1',
    architectureSemantic: '1',
    abiSemantic: '1',
    semanticSchema: '1',
  }),
});

function descriptor(config) {
  return createArtifactDescriptor({ ...BASE, config });
}

const byteBuffer = Uint8Array.from([0x10, 0x20, 0x30]).buffer;
const cases = [
  ['plain-json', { alpha: 1, nested: { beta: true } }],
  ['bigint', { offset: 1n }],
  ['date', { stamp: new Date('2026-01-02T03:04:05.000Z') }],
  ['bytes', { bytes: Uint8Array.from([1, 2, 3]) }],
  ['array-buffer', { bytes: byteBuffer }],
  ['map', { map: new Map([['b', 2], ['a', 1]]) }],
  ['set', { set: new Set([2, 1]) }],
  ['reserved-key', { $bigint: 'caller-owned-key' }],
  ['nested-reserved-key', { nested: { $set: [1, 2] } }],
];

for (const [label, config] of cases) {
  const direct = canonicalConfigHash(config);
  const created = descriptor(config);
  assert.equal(
    created.canonicalConfigHash,
    direct,
    `${label}: descriptor canonicalConfigHash must equal canonicalConfigHash(raw config)`,
  );
  assert.equal(
    descriptor(config).artifactId,
    created.artifactId,
    `${label}: corrected descriptor identity must remain deterministic`,
  );
}

// Reserved-tag escaping must remain collision-safe after eliminating the second pass.
assert.notEqual(
  descriptor({ value: 1n }).artifactId,
  descriptor({ value: { $bigint: '1' } }).artifactId,
  'BigInt must not alias a caller-owned reserved-tag object',
);
assert.notEqual(
  descriptor({ value: new Set([1]) }).artifactId,
  descriptor({ value: { $set: [1] } }).artifactId,
  'Set must not alias a caller-owned reserved-tag object',
);
assert.notEqual(
  descriptor({ value: new Map([['a', 1]]) }).artifactId,
  descriptor({ value: { $map: [['a', 1]] } }).artifactId,
  'Map must not alias a caller-owned reserved-tag object',
);

console.log('issue-4612-artifact-config-hash-consistency: PASS');

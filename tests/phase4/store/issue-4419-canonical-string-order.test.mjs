import assert from 'node:assert/strict';
import test from 'node:test';
import { ArtifactStore, createArtifactRecord, encodeArtifactPayload } from '../../../js/core/artifacts/index.js';
import { canonicalStoredRecord, validateArtifactRecordShape } from '../../../js/core/artifacts/storage/integrity.js';
import { descriptor, PersistentMemoryBackend } from './support.mjs';

function recordFor(originRefs, upstreamArtifactIds = []) {
  return createArtifactRecord(descriptor('ordering', { originRefs, upstreamArtifactIds }), encodeArtifactPayload({ value: 1 }), { completeness: 'complete' });
}

for (const refs of [['Z', 'a'], ['a', 'Z'], ['é', 'e\u0301'], ['\u{10000}', '\uE000'], ['x10', 'x2'], ['a', 'a']]) {
  test(`factory-produced origin order validates: ${JSON.stringify(refs)}`, () => {
    const record = recordFor(refs);
    assert.deepEqual(record.originRefs, [...new Set(refs)].sort());
    assert.equal(validateArtifactRecordShape(record), true);
    assert.deepEqual(canonicalStoredRecord(record).originRefs, record.originRefs);
  });
}

test('dependency IDs use the same ordering contract', () => {
  assert.equal(validateArtifactRecordShape(recordFor([], ['artifact_Z', 'artifact_a'])), true);
});

test('noncanonical order, duplicates and malformed strings are still rejected', () => {
  const record = recordFor(['Z', 'a']);
  for (const bad of [['a', 'Z'], ['Z', 'Z'], [''], [' a'], [false]]) {
    assert.throws(() => validateArtifactRecordShape({ ...record, originRefs: bad }), /artifact-record-malformed/);
  }
});

test('integrity validation does not consult locale-dependent collation', () => {
  const record = recordFor(['A', 'Z', 'a']);
  const compare = String.prototype.localeCompare;
  try {
    String.prototype.localeCompare = () => assert.fail('locale-dependent authority');
    assert.equal(validateArtifactRecordShape(record), true);
  } finally { String.prototype.localeCompare = compare; }
});

test('mixed-case provenance survives actual publish and cold-store reload', async () => {
  const entries = new Map();
  const d = descriptor('publish-order', { originRefs: ['Z', 'a'] });
  const writer = new ArtifactStore({ backend: new PersistentMemoryBackend({ entries }) });
  const reader = new ArtifactStore({ backend: new PersistentMemoryBackend({ entries }) });
  try {
    const result = await writer.publish(d, { value: 7 });
    assert.equal(result.status, 'published');
    const loaded = await reader.get(d);
    assert.equal(loaded.source, 'persistent');
    assert.equal(loaded.payload.value, 7);
    assert.deepEqual(loaded.record.originRefs, ['Z', 'a']);
  } finally { await writer.close(); await reader.close(); }
});

import assert from 'node:assert/strict';
import { EvidenceStore } from '../js/ai/evidence.js';

function updates() {
  return {
    updates: [
      { address: '0x1000', kind: 'write', value: 1 },
      { address: '0x1000', kind: 'write', value: 2 },
    ],
  };
}

// Independent rows with the same address/kind must not overwrite one another.
const store = new EvidenceStore();
const created = store.ingest('verify_field_update', updates());
assert.equal(created.length, 2);
assert.equal(store.records.size, 2);
assert.deepEqual([...store.records.values()].map((record) => record.sourceData.value), [1, 2]);
assert.notEqual(created[0].id, created[1].id);

// A canonical root sourceRef contributes the row path to identity and provenance.
const withSourceRef = new EvidenceStore();
const rooted = withSourceRef.ingest('verify_field_update', updates(), {
  sourceRef: { evidenceSourceId: 'tool-result-4519', path: '$' },
});
assert.equal(withSourceRef.records.size, 2);
assert.deepEqual(rooted.map((record) => record.sourceRef.path), ['$.updates[0]', '$.updates[1]']);
assert.notEqual(rooted[0].id, rooted[1].id);

// Identity-bearing sourceRef paths are canonical primitive strings only. Values
// that previously String()-coerced to '$' must fail closed rather than minting
// the same permanent row IDs as the canonical path.
const canonicalPathIds = rooted.map((record) => record.id);
for (const path of [
  ['$'],
  0,
  false,
  { toString() { return '$'; } },
]) {
  const invalidPath = new EvidenceStore();
  const rejected = invalidPath.ingest('verify_field_update', updates(), {
    sourceRef: { evidenceSourceId: 'tool-result-4519', path },
  });
  assert.deepEqual(rejected, []);
  assert.equal(invalidPath.records.size, 0);
  assert.deepEqual(rejected.map((record) => record.id), []);
  assert.notDeepEqual(rejected.map((record) => record.id), canonicalPathIds);
}

// Re-ingesting the same row coordinate remains a deterministic dedupe.
const dedupe = new EvidenceStore();
const first = dedupe.ingest('verify_field_update', updates());
const second = dedupe.ingest('verify_field_update', updates());
assert.deepEqual(second.map((record) => record.id), first.map((record) => record.id));
assert.equal(dedupe.records.size, 2);

// Verified sibling rows are both retained instead of the second being rejected
// by the verified-record collision guard.
const verified = new EvidenceStore();
const verifiedRows = verified.ingest('verify_field_update', {
  updates: [
    { address: '0x1000', kind: 'write', value: 1, verified: true },
    { address: '0x1000', kind: 'write', value: 2, verified: true },
  ],
}, { verifier: true });
assert.equal(verified.records.size, 2);
assert.deepEqual(verifiedRows.map((record) => record.status), ['verified', 'verified']);

// The same fallback applies across fact-row collections, not only updates.
const sites = new EvidenceStore();
sites.ingest('verify_sites', {
  sites: [
    { address: '0x1000', kind: 'write', value: 'a' },
    { address: '0x1000', kind: 'write', value: 'b' },
  ],
});
assert.equal(sites.records.size, 2);

console.log('issue-4519-evidence-row-identity: PASS');

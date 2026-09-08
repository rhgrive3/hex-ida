import assert from 'node:assert/strict';
import {
  createDebugIdentity,
  createDebugRecord,
  isDebugRecordAuthoritative,
} from '../../js/analysis/debug/provider.js';

// Issue #5732: identity.digest is the invalidation fingerprint for debug
// identities, but it omitted `coverage` — the field that decides which records
// carry hard authority under `matched-partial`. Two identities with different
// coverage domains (and opposite authority verdicts for the same record) got
// identical digests.

const base = {
  verdict: 'matched-partial',
  providerId: 'dwarf',
  providerVersion: '1',
  expected: 'build-X',
  observed: 'build-X',
  method: 'uuid',
};

const recordA = createDebugRecord({
  kind: 'type',
  entityId: 'A',
  providerId: 'dwarf',
  providerVersion: '1',
  buildIdentity: 'build-X',
  descriptor: { claim: { kind: 'integer' } },
  evidenceIds: ['eA'],
});

const onlyA = createDebugIdentity({ ...base, coverage: { entityIds: ['A'] } });
const onlyB = createDebugIdentity({ ...base, coverage: { entityIds: ['B'] } });

// Opposite authority verdicts for the same record must imply distinct digests.
assert.equal(onlyA.digest === onlyB.digest, false,
  'different matched-partial coverage domains must produce different digests');
assert.equal(isDebugRecordAuthoritative({ identity: onlyA }, recordA), true);
assert.equal(isDebugRecordAuthoritative({ identity: onlyB }, recordA), false);

// Coverage in every authority dimension changes the digest.
for (const coverage of [
  { recordKinds: ['type'] },
  { addresses: ['0x1000'] },
  { buildIdentities: ['build-X'] },
  { modules: ['m1'] },
  { module: 'm1' },
]) {
  const identity = createDebugIdentity({ ...base, coverage });
  assert.notEqual(identity.digest, onlyA.digest, `coverage variant ${JSON.stringify(coverage)} must change the digest`);
}

// Equal coverage keeps equal digests.
const againA = createDebugIdentity({ ...base, coverage: { entityIds: ['A'] } });
assert.equal(againA.digest, onlyA.digest);

// The list selectors are set-valued authority. Reordering, duplicates, and
// surrounding whitespace must not create a different invalidation identity.
const setCoverageA = createDebugIdentity({
  ...base,
  coverage: {
    entityIds: [' A ', 'B', 'A'],
    recordKinds: [' type ', 'symbol', 'type'],
    addresses: [' 0x1000 ', '0x2000', '0x1000'],
    buildIdentities: [' build-X ', 'build-Y', 'build-X'],
    modules: [' m1 ', 'm2', 'm1'],
  },
});
const setCoverageB = createDebugIdentity({
  ...base,
  coverage: {
    entityIds: ['B', 'A'],
    recordKinds: ['symbol', 'type'],
    addresses: ['0x2000', '0x1000'],
    buildIdentities: ['build-Y', 'build-X'],
    modules: ['m2', 'm1'],
  },
});
assert.equal(setCoverageA.digest, setCoverageB.digest,
  'set-equivalent coverage lists must produce the same digest');

// Unknown selectors remain fail-closed authority even when known selectors match.
const unknownCoverage = createDebugIdentity({
  ...base,
  coverage: { entityIds: ['A'], unsupportedSelector: ['A'] },
});
assert.equal(isDebugRecordAuthoritative({ identity: unknownCoverage }, recordA), false,
  'unknown coverage selectors must remain non-authoritative');

// Identities without coverage are unaffected (fully-matched case digest is
// stable and coverage-less).
const full = createDebugIdentity({ ...base, verdict: 'matched-authoritative' });
assert.equal(typeof full.digest, 'string');

console.log('issue-5732 debug identity digest binds its coverage authority: ok');
// Regression for #5732: coverage constrains `matched-partial` authority in
// isDebugRecordAuthoritative(), so two debug identities with different
// authoritative coverage sets must not share a digest.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createDebugIdentity,
  createDebugRecord,
  isDebugRecordAuthoritative,
} from '../../js/analysis/debug/provider.js';

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

test('#5732 different coverage sets produce different identity digests', () => {
  const onlyA = createDebugIdentity({ ...base, coverage: { entityIds: ['A'] } });
  const onlyB = createDebugIdentity({ ...base, coverage: { entityIds: ['B'] } });
  assert.equal(onlyA.verdict, 'matched-partial');
  assert.notEqual(onlyA.digest, onlyB.digest);
});

test('#5732 identical inputs keep identical digests', () => {
  const first = createDebugIdentity({ ...base, coverage: { entityIds: ['A'], recordKinds: ['type'] } });
  const second = createDebugIdentity({ ...base, coverage: { entityIds: ['A'], recordKinds: ['type'] } });
  assert.equal(first.digest, second.digest);
});

test('#5732 authority still follows coverage, now with distinct digests', () => {
  const onlyA = createDebugIdentity({ ...base, coverage: { entityIds: ['A'] } });
  const onlyB = createDebugIdentity({ ...base, coverage: { entityIds: ['B'] } });
  assert.equal(isDebugRecordAuthoritative({ identity: onlyA }, recordA), true);
  assert.equal(isDebugRecordAuthoritative({ identity: onlyB }, recordA), false);
});

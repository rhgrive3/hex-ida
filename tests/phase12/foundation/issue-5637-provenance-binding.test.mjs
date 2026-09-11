import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPackageEnvelope,
  importPhase12Package,
  validatePackageEnvelope,
} from '../../../js/phase12/package-envelope.js';

const ORIGINAL = createPackageEnvelope({
  kind: 'knowledge',
  packageId: 'pkg',
  packageVersion: '1',
  provenance: { source: 'trusted-registry', producer: 'A' },
  payload: { value: 1 },
});

test('#5637 producer envelopes bind their provenance record', () => {
  assert.equal(typeof ORIGINAL.provenanceHash, 'string');
  assert.ok(ORIGINAL.provenanceHash.length >= 8);
  assert.deepEqual(ORIGINAL.provenance, { source: 'trusted-registry', producer: 'A' });
  const checked = validatePackageEnvelope(ORIGINAL);
  assert.equal(checked.ok, true, checked.error ?? '');
});

test('#5637 a missing provenance record is rejected at the import boundary', () => {
  const { provenance, ...withoutProvenance } = ORIGINAL;
  void provenance;
  const checked = validatePackageEnvelope(withoutProvenance);
  assert.equal(checked.ok, false);
  assert.equal(checked.code, 'package-provenance-required');
});

test('#5637 provenance cannot be swapped under an unchanged contentHash', () => {
  const forged = { ...ORIGINAL, provenance: { source: 'different-source', producer: 'B' } };
  assert.equal(forged.contentHash, ORIGINAL.contentHash, 'content identity intentionally excludes provenance');
  const checked = validatePackageEnvelope(forged);
  assert.equal(checked.ok, false);
  assert.equal(checked.code, 'package-provenance-identity-mismatch');
});

test('#5637 erasing the binding itself is rejected, not bypassed', () => {
  const unbound = { ...ORIGINAL };
  delete unbound.provenanceHash;
  const checked = validatePackageEnvelope(unbound);
  assert.equal(checked.ok, false);
  assert.equal(checked.code, 'package-provenance-binding-required');
});

test('#5637 provenance records that cannot stand in for a record are rejected', () => {
  for (const bad of [null, [], 'local', 42, true]) {
    const checked = validatePackageEnvelope({ ...ORIGINAL, provenance: bad });
    assert.equal(checked.ok, false, `provenance ${JSON.stringify(bad)} must be rejected`);
    assert.equal(checked.code, 'package-provenance-required');
  }
});

test('#5637 the producer never mints an envelope that fails its own contract', () => {
  assert.throws(
    () => createPackageEnvelope({ kind: 'knowledge', packageId: 'p', packageVersion: '1', payload: {}, provenance: [] }),
    (error) => error.name === 'PackageValidationError' && error.code === 'package-provenance-required',
  );
  const defaulted = createPackageEnvelope({ kind: 'knowledge', packageId: 'p', packageVersion: '1', payload: {} });
  assert.deepEqual(defaulted.provenance, { source: 'local' });
  assert.equal(validatePackageEnvelope(defaulted).ok, true);
});

test('#5637 import path enforces the same contract end to end', () => {
  const imported = importPhase12Package(ORIGINAL);
  assert.equal(imported.contentHash, ORIGINAL.contentHash);
  assert.equal(imported.provenanceHash, ORIGINAL.provenanceHash);
  const { provenance, ...withoutProvenance } = ORIGINAL;
  void provenance;
  assert.throws(
    () => importPhase12Package(withoutProvenance),
    (error) => error.name === 'PackageValidationError' && error.code === 'package-provenance-required',
  );
});

test('#5637 provenance remains outside the package content identity', () => {
  const a = createPackageEnvelope({ kind: 'knowledge', packageId: 'pack-a', packageVersion: '1', payload: { b: 2, a: 1 }, provenance: { source: 'one' } });
  const b = createPackageEnvelope({ kind: 'knowledge', packageId: 'pack-a', packageVersion: '1', payload: { a: 1, b: 2 }, provenance: { source: 'two' } });
  assert.equal(a.contentHash, b.contentHash, 'provenance is trust metadata, not semantic package content');
  assert.notEqual(a.provenanceHash, b.provenanceHash, 'but each provenance record binds itself');
});

import assert from 'node:assert/strict';
import {
  jsonSafe,
  createEntityId,
  createEvidenceId,
  createFunctionId,
  createValueId,
} from '../js/core/identity/index.js';
import { createAnalysisSnapshot } from '../js/core/identity/snapshot.js';

// --- Test 1: #3805 Map/Set deterministic canonicalization in jsonSafe ---
{
  const emptyObjId = createEntityId({ binaryId: 'bin-1', kind: 'test', identity: {} });
  const emptyMapId = createEntityId({ binaryId: 'bin-1', kind: 'test', identity: new Map() });
  const mapAId = createEntityId({ binaryId: 'bin-1', kind: 'test', identity: new Map([['k', '1']]) });
  const mapBId = createEntityId({ binaryId: 'bin-1', kind: 'test', identity: new Map([['k', '2']]) });

  assert.notEqual(emptyObjId, emptyMapId, 'empty Map must not alias empty object');
  assert.notEqual(mapAId, mapBId, 'distinct Maps must produce distinct entity IDs');

  const setAId = createEntityId({ binaryId: 'bin-1', kind: 'test', identity: new Set(['a']) });
  const setBId = createEntityId({ binaryId: 'bin-1', kind: 'test', identity: new Set(['b']) });
  assert.notEqual(setAId, setBId, 'distinct Sets must produce distinct entity IDs');
  assert.notEqual(setAId, emptyObjId, 'Set must not alias empty object');

  // AnalysisSnapshot artifactVersions with Map
  const common = {
    binaryId: 'bin-test',
    projectRevision: 0,
    analysisEpoch: 0,
    createdAt: '2026-09-03T00:00:00Z',
  };
  const snapA = createAnalysisSnapshot({
    ...common,
    artifactVersions: { semantic: new Map([['schema', '1']]) },
  });
  const snapB = createAnalysisSnapshot({
    ...common,
    artifactVersions: { semantic: new Map([['schema', '2']]) },
  });
  assert.notEqual(snapA.snapshotId, snapB.snapshotId, 'different Map artifactVersions must produce distinct snapshotIds');
  console.log('✔ #3805 Map/Set jsonSafe canonicalization passed');
}

// --- Test 2: #4409 normalizeIdentity lossyTypeWitness preservation ---
{
  const fnBigInt = createFunctionId({
    binaryId: 'bin-A',
    sliceId: 'slice-A',
    canonicalStartIdentity: { offset: 1n },
  });
  const fnString = createFunctionId({
    binaryId: 'bin-A',
    sliceId: 'slice-A',
    canonicalStartIdentity: { offset: '1' },
  });
  assert.notEqual(fnBigInt, fnString, 'BigInt offset must not alias string offset');

  const valWithUndef = createValueId({
    functionId: 'fn-A',
    canonicalDefinitionIdentity: { op: 'phi', lane: undefined },
  });
  const valWithoutUndef = createValueId({
    functionId: 'fn-A',
    canonicalDefinitionIdentity: { op: 'phi' },
  });
  assert.notEqual(valWithUndef, valWithoutUndef, 'undefined property presence must not be dropped into identical ID');

  // Ordinary number preserves stable output
  const fnNumber1 = createFunctionId({
    binaryId: 'bin-A',
    sliceId: 'slice-A',
    canonicalStartIdentity: { offset: 1 },
  });
  const fnNumber2 = createFunctionId({
    binaryId: 'bin-A',
    sliceId: 'slice-A',
    canonicalStartIdentity: { offset: 1 },
  });
  assert.equal(fnNumber1, fnNumber2, 'identical numbers must produce identical stable IDs');
  console.log('✔ #4409 normalizeIdentity lossyTypeWitness preservation passed');
}

console.log('\nAll core-identity consolidated regression tests PASSED!');

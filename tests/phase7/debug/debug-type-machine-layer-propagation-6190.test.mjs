import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDebugIdentity,
  createDebugRecord,
  createDebugPage,
  createDebugProviderResult,
  applyDebugTypesToGraph,
} from '../../../js/analysis/debug/provider.js';

function makeResult(identity) {
  return createDebugProviderResult({
    ecosystem: 'dwarf',
    identity,
    status: {
      snapshotId: 'snapshot-1',
      analyzerId: 'debug',
      analyzerVersion: '1',
      completeness: 'complete',
    },
  });
}

test('issue #6190: applyDebugTypesToGraph propagates machine layer claims to TypeConstraintGraph', () => {
  const result = makeResult(createDebugIdentity({
    verdict: 'matched-authoritative',
    providerId: 'dwarf',
    providerVersion: '1.0.0',
    expected: 'build-hash-1',
    observed: 'build-hash-1',
    method: 'build-id',
  }));

  const record = createDebugRecord({
    kind: 'type',
    entityId: 'e1',
    providerId: 'dwarf',
    providerVersion: '1.0.0',
    buildIdentity: 'build-hash-1',
    evidenceIds: ['dwarf:type:1'],
    descriptor: {
      layer: 'nominal',
      claim: { name: 'int32_t', aliases: [] },
      machine: { widthBits: 32, class: 'integer' },
      complete: true,
    },
  });

  const hard = [];
  const soft = [];
  const graph = {
    addHardConstraint(value) { hard.push(value); },
    addSoftEvidence(value) { soft.push(value); },
  };

  const applied = applyDebugTypesToGraph(graph, result, createDebugPage({ records: [record] }));

  assert.equal(applied.hard, 2, 'Should have applied 2 hard constraints (nominal and machine)');
  assert.equal(hard.length, 2);

  const nominal = hard.find((c) => c.claim.layer === 'nominal');
  assert.ok(nominal, 'Must have nominal layer claim');
  assert.equal(nominal.claim.entityId, 'e1');
  assert.deepEqual(nominal.claim.descriptor, { name: 'int32_t', aliases: [] });
  assert.equal(nominal.providerVersion, '1.0.0');
  assert.equal(nominal.buildIdentity, 'build-hash-1');
  assert.deepEqual(nominal.evidenceIds, ['dwarf:type:1']);

  const machine = hard.find((c) => c.claim.layer === 'machine');
  assert.ok(machine, 'Must have machine layer claim');
  assert.equal(machine.claim.entityId, 'e1');
  assert.deepEqual(machine.claim.descriptor, { widthBits: 32, class: 'integer' });
  assert.equal(machine.providerVersion, '1.0.0');
  assert.equal(machine.buildIdentity, 'build-hash-1');
  assert.deepEqual(machine.evidenceIds, ['dwarf:type:1']);
});

test('issue #6190: null machine descriptor does not produce redundant machine claim', () => {
  const result = makeResult(createDebugIdentity({
    verdict: 'matched-authoritative',
    providerId: 'dwarf',
    providerVersion: '1.0.0',
    expected: 'b',
    observed: 'b',
    method: 'build-id',
  }));

  const record = createDebugRecord({
    kind: 'type',
    entityId: 'e2',
    providerId: 'dwarf',
    providerVersion: '1.0.0',
    buildIdentity: 'b',
    evidenceIds: ['dwarf:type:2'],
    descriptor: {
      layer: 'nominal',
      claim: { name: 'CustomType' },
      machine: null,
    },
  });

  const hard = [];
  const graph = {
    addHardConstraint(value) { hard.push(value); },
    addSoftEvidence() {},
  };

  const applied = applyDebugTypesToGraph(graph, result, createDebugPage({ records: [record] }));
  assert.equal(applied.hard, 1, 'Only nominal claim should be generated when machine is null');
  assert.equal(hard[0].claim.layer, 'nominal');
});

test('issue #6190: unmatched debug result routes both claims to soft evidence', () => {
  const result = makeResult(createDebugIdentity({
    verdict: 'identity-unavailable',
    providerId: 'dwarf',
    providerVersion: '1.0.0',
    method: 'unavailable',
  }));

  const record = createDebugRecord({
    kind: 'type',
    entityId: 'e3',
    providerId: 'dwarf',
    providerVersion: '1.0.0',
    buildIdentity: null,
    evidenceIds: [],
    descriptor: {
      layer: 'nominal',
      claim: { name: 'int' },
      machine: { widthBits: 32, class: 'integer' },
    },
  });

  const soft = [];
  const graph = {
    addHardConstraint() { assert.fail('Must not add hard constraint for unmatched provider'); },
    addSoftEvidence(value) { soft.push(value); },
  };

  const applied = applyDebugTypesToGraph(graph, result, createDebugPage({ records: [record] }));
  assert.equal(applied.hard, 0);
  assert.equal(applied.soft, 2);
  assert.equal(soft.filter((s) => s.claim.layer === 'nominal').length, 1);
  assert.equal(soft.filter((s) => s.claim.layer === 'machine').length, 1);
});

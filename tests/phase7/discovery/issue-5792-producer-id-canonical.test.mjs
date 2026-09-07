import assert from 'node:assert/strict';
import test from 'node:test';

import { createDiscoveryEvidence } from '../../../js/analysis/discovery/candidates.js';
import { DiscoveryProducerRegistry, fuseFunctionCandidates } from '../../../js/analysis/discovery/fusion.js';

// #5792: producer identity is the independence token for corroboration, but
// whitespace-only strings (' ' vs '  ') passed validation and counted as two
// independent corroborating sources — enough to upgrade a function start to
// `probable` on fabricated evidence.

test('whitespace-only producer ids fail closed at the canonical evidence boundary (#5792)', () => {
  for (const producerId of [' ', '  ', '\t']) {
    assert.throws(
      () => createDiscoveryEvidence({ kind:'direct-call-target', producerId, start:0x1000n }),
      /discovery-evidence-invalid-producer-id/,
      `whitespace-only id ${JSON.stringify(producerId)} must be rejected`,
    );
  }
  // A padded id is non-canonical input: it must not silently become a
  // different producer than its trimmed form.
  assert.throws(
    () => createDiscoveryEvidence({ kind:'direct-call-target', producerId:' p ', start:0x1000n }),
    /discovery-evidence-invalid-producer-id/,
  );
  assert.equal(createDiscoveryEvidence({ kind:'direct-call-target', producerId:'p1', start:0x1000n }).producerId, 'p1');
  assert.equal(createDiscoveryEvidence({ kind:'direct-call-target', start:0x1000n }).producerId, 'unknown');
});

test('the registry rejects whitespace-only and padded producer ids (#5792)', () => {
  const registry = new DiscoveryProducerRegistry();
  for (const id of [' ', '  ', ' p ']) {
    assert.throws(() => registry.register({ id, produce() { return []; } }), /discovery-producer-id-required/);
  }
  registry.register({ id:'p1', produce() { return []; } });
  assert.deepEqual([...registry.producers.keys()], ['p1']);
});

test('whitespace-only corroborating evidence cannot upgrade a start to probable (#5792)', () => {
  // With the boundary closed, the issue's exact fabrication cannot even be
  // built; assert the canonical constructor refuses it rather than fusing.
  assert.throws(
    () => fuseFunctionCandidates([
      { kind:'direct-call-target', authority:'corroborating', extentRole:'complete', start:0x1000n, regions:[], producerId:' ', architectureId:null, name:null, confidence:null, evidenceIds:['e1'] },
      { kind:'relocation-target', authority:'corroborating', extentRole:'complete', start:0x1000n, regions:[], producerId:'  ', architectureId:null, name:null, confidence:null, evidenceIds:['e2'] },
    ]),
    /discovery-evidence-invalid-producer-id/,
  );
  // Two genuinely distinct corroborating producers still corroborate.
  const { candidates } = fuseFunctionCandidates([
    { kind:'direct-call-target', authority:'corroborating', extentRole:'complete', start:0x1000n, regions:[], producerId:'p1', architectureId:null, name:null, confidence:null, evidenceIds:['e1'] },
    { kind:'relocation-target', authority:'corroborating', extentRole:'complete', start:0x1000n, regions:[], producerId:'p2', architectureId:null, name:null, confidence:null, evidenceIds:['e2'] },
  ]);
  assert.equal(candidates[0].startState, 'probable');
});

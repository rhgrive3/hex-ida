import assert from 'node:assert/strict';
import test from 'node:test';

import { fuseFunctionCandidates, DiscoveryProducerRegistry, DISCOVERY_DEFAULT_BUDGET } from '../js/analysis/discovery/fusion.js';

const mk = (pid, ev) => ({
  kind: 'export', authority: 'authoritative', extentRole: 'complete', start: '4096',
  regions: [], producerId: pid, architectureId: 'arm64', name: null, confidence: null,
  evidenceIds: [ev],
});

test('#5725 evidence order is code-unit ordered, not host-locale ordered', () => {
  // 'ä' (0xE4) sorts after 'z' (0x7A) in UTF-16 code-unit order but before 'z'
  // under the de_DE ICU collation. The retained witness must not flip.
  const out = fuseFunctionCandidates([mk('ä', 'ev-a'), mk('z', 'ev-z')], {
    budget: { maxEvidencePerCandidate: 1, maxCandidates: 100 },
  });
  const cands = out.candidates || [];
  assert.equal(cands.length, 1);
  const retained = (cands[0].startEvidence || []).map((e) => e.evidenceIds?.[0]);
  assert.deepEqual(retained, ['ev-z'], 'code-unit order puts producerId z before ä');
});

test('#5725 full-budget evidence order stays locale invariant and ascii-compatible', () => {
  const evidence = [mk('beta', 'ev-b'), mk('alpha', 'ev-a'), mk('gamma', 'ev-g')];
  const out = fuseFunctionCandidates(evidence, {
    budget: { maxEvidencePerCandidate: DISCOVERY_DEFAULT_BUDGET.maxEvidencePerCandidate, maxCandidates: 100 },
  });
  const retained = (out.candidates[0].startEvidence || []).map((e) => e.evidenceIds?.[0]);
  assert.deepEqual(retained, ['ev-a', 'ev-b', 'ev-g']);
});

test('#5725 producer registry order is code-unit ordered', () => {
  const registry = new DiscoveryProducerRegistry();
  registry.register({ id: 'ä-producer', architectureId: null, produce: async () => [] });
  registry.register({ id: 'z-producer', architectureId: null, produce: async () => [] });
  registry.register({ id: 'a-producer', architectureId: null, produce: async () => [] });
  const ids = registry.for('arm64').map((p) => p.id);
  assert.deepEqual(ids, ['a-producer', 'z-producer', 'ä-producer']);
});

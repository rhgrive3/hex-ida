import assert from 'node:assert/strict';
import test from 'node:test';

import { createEvidenceNode } from '../js/core/evidence/index.js';
import { canonicalEvidenceToLegacyAi, legacyAiEvidenceToCanonical } from '../js/core/evidence/compat.js';

test('#5782 canonical top-level binaryId survives canonical->legacy conversion', () => {
  const node = createEvidenceNode({
    id: 'e-1',
    family: 'SemanticEvidence',
    binaryId: 'bin-A',
    targetEntityIds: ['entity-A'],
    semanticKind: 'function-name',
    completeness: 'complete',
    deterministic: true,
    payload: { summary: 'demo' },
  });
  assert.equal(node.binaryId, 'bin-A');
  const legacy = canonicalEvidenceToLegacyAi(node);
  assert.equal(legacy.binaryId, 'bin-A', 'canonical field is the binding authority');
});

test('#5782 canonical->legacy->canonical round trip preserves the binary binding', () => {
  const node = createEvidenceNode({
    id: 'e-2',
    family: 'SemanticEvidence',
    binaryId: 'bin-A',
    targetEntityIds: ['entity-A'],
    semanticKind: 'function-name',
    completeness: 'complete',
    deterministic: true,
    payload: {},
  });
  const legacy = canonicalEvidenceToLegacyAi(node);
  const roundTrip = legacyAiEvidenceToCanonical(legacy);
  assert.equal(roundTrip.binaryId, 'bin-A');
});

test('#5782 legacy-origin canonical nodes keep their binary binding', () => {
  const legacyRecord = { id: 'e-3', kind: 'observation', status: 'supported', binaryId: 'bin-B', title: 't' };
  const node = legacyAiEvidenceToCanonical(legacyRecord);
  const back = canonicalEvidenceToLegacyAi(node);
  assert.equal(back.binaryId, 'bin-B');
});

test('#5782 unbound evidence gains no synthetic binary binding', () => {
  const node = createEvidenceNode({
    id: 'e-4',
    family: 'SemanticEvidence',
    targetEntityIds: ['entity-A'],
    semanticKind: 'function-name',
    completeness: 'complete',
    deterministic: true,
    payload: {},
  });
  const legacy = canonicalEvidenceToLegacyAi(node);
  assert.equal(legacy.binaryId, undefined);
  assert.equal(legacyAiEvidenceToCanonical(legacy).binaryId, null);
});

import assert from 'node:assert/strict';
import { createEvidenceNode } from '../../../js/core/evidence/index.js';
import {
  canonicalEvidenceToLegacyAi,
  legacyAiEvidenceToCanonical,
} from '../../../js/core/evidence/compat.js';

function canonical({ deterministic = false, status, completeness } = {}) {
  return createEvidenceNode({
    id: 'ev-issue-5095',
    family: 'SemanticEvidence',
    semanticKind: 'issue-5095',
    deterministic,
    completeness: completeness ?? (deterministic ? 'complete' : 'partial'),
    payload: status === undefined ? {} : { status },
  });
}

{
  const original = canonical({ deterministic: false, status: 'verified' });
  const legacy = canonicalEvidenceToLegacyAi(original);
  assert.equal(legacy.status, 'supported', 'payload status must not mint verified authority');
  assert.equal(
    legacyAiEvidenceToCanonical(legacy).deterministic,
    false,
    'compat round-trip must not escalate non-deterministic evidence',
  );
}

{
  const original = canonical({ deterministic: false, status: 'verified', completeness: 'complete' });
  const legacy = canonicalEvidenceToLegacyAi(original);
  assert.equal(legacy.status, 'supported', 'completeness must not substitute for deterministic authority');
  assert.equal(legacyAiEvidenceToCanonical(legacy).deterministic, false);
}

for (const status of [['verified'], { value: 'verified' }, new String('verified')]) {
  const original = canonical({ deterministic: false, status });
  const legacy = canonicalEvidenceToLegacyAi(original);
  assert.equal(legacy.status, 'supported', 'structured payload status must not mint verified authority');
  assert.equal(legacyAiEvidenceToCanonical(legacy).deterministic, false);
}

for (const status of ['supported', 'hypothesis', 'unknown']) {
  const original = canonical({ deterministic: false, status });
  const legacy = canonicalEvidenceToLegacyAi(original);
  assert.equal(legacy.status, status, `non-authoritative legacy status ${status} should be preserved`);
  assert.equal(legacyAiEvidenceToCanonical(legacy).deterministic, false);
}

for (const status of ['verified', 'supported', 'hypothesis', 'unknown', undefined]) {
  const original = canonical({ deterministic: true, status });
  const legacy = canonicalEvidenceToLegacyAi(original);
  assert.equal(legacy.status, 'verified', 'canonical deterministic authority must dominate legacy payload status');
  assert.equal(
    legacyAiEvidenceToCanonical(legacy).deterministic,
    true,
    'compat round-trip must preserve canonical deterministic authority',
  );
}

{
  const original = canonical({ deterministic: false });
  assert.equal(canonicalEvidenceToLegacyAi(original).status, 'supported');
}

console.log('issue-5095 compat verified authority: PASS');

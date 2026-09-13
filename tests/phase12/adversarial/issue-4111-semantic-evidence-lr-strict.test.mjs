// Issue #4111 regression: likelihood-ratio options are authority, not input
// text to coerce into a numeric evidence weight.
import assert from 'node:assert/strict';
import test from 'node:test';

import { runtimeEvidenceItems, semanticEvidenceItems } from '../../../js/semantic-evidence.js';

const verifiedFacts = [{
  kind: 'read',
  confidence: 1,
  verified: true,
  evidence: [{ id: 'ir:verified', group: 'verified-group' }],
}];

test('#4111 verified semantic evidence rejects coercible likelihood ratios', () => {
  for (const bad of ['99', ['99'], true, {}, NaN, Infinity]) {
    const [item] = semanticEvidenceItems(verifiedFacts, { lr: bad });
    assert.equal(item.lr, 8, `malformed semantic lr ${String(bad)} must use the fallback`);
  }
});

test('#4111 runtime evidence rejects coercible likelihood ratios', () => {
  for (const bad of ['99', ['99'], true, {}, NaN, Infinity]) {
    const [item] = runtimeEvidenceItems({ complete: true, touchedFields: [{ offset: 1n }] }, { lr: bad });
    assert.equal(item.lr, 18, `malformed runtime lr ${String(bad)} must use the fallback`);
  }
});

test('#4111 canonical finite likelihood ratios retain existing bounds', () => {
  assert.equal(semanticEvidenceItems(verifiedFacts, { lr: 22 })[0].lr, 22);
  assert.equal(semanticEvidenceItems(verifiedFacts, { lr: 0.5 })[0].lr, 1);
  assert.equal(runtimeEvidenceItems({ complete: true, touchedFields: [{ offset: 1n }] }, { lr: 22 })[0].lr, 22);
  assert.equal(runtimeEvidenceItems({ complete: true, touchedFields: [{ offset: 1n }] }, { lr: 0.5 })[0].lr, 1);
});

console.log('issue #4111 semantic evidence likelihood-ratio regressions PASS');

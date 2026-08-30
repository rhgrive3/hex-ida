import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalClaimVerdict } from '../../../js/analysis/query/product-surface.js';

test('canonical claim verdict accepts only string evidence', () => {
  assert.equal(canonicalClaimVerdict({ verdict:'confirmed' }), 'confirmed');
  assert.equal(canonicalClaimVerdict({ verdict:'SUPPORTED' }), 'supported');
  assert.equal(canonicalClaimVerdict({ verdict:'not-a-verdict' }), 'unverified');

  for (const malformed of [
    ['confirmed'],
    { toString() { return 'supported'; } },
    1,
    true,
    false,
  ]) {
    assert.equal(canonicalClaimVerdict({ verdict:malformed }), 'unverified');
  }
});

test('fallback verdict sources keep the same strict string boundary', () => {
  assert.equal(canonicalClaimVerdict({ evidenceVerdict:'likely' }), 'likely');
  assert.equal(canonicalClaimVerdict({ proof:{ verdict:'contradicted' } }), 'contradicted');
  assert.equal(canonicalClaimVerdict({ claim:{ verdict:'unknown' } }), 'unknown');

  assert.equal(canonicalClaimVerdict({ evidenceVerdict:['supported'] }), 'unverified');
  assert.equal(canonicalClaimVerdict({ proof:{ verdict:['confirmed'] } }), 'unverified');
  assert.equal(canonicalClaimVerdict({ claim:{ verdict:{ toString() { return 'likely'; } } } }), 'unverified');
});

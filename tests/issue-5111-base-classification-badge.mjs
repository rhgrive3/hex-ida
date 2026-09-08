import assert from 'node:assert/strict';
import { baseClassificationBadge } from '../js/ui/product-hardened.js';

// Issue #5111: a base label matching the final fallback label is not evidence
// of confirmation when semantic analysis is unavailable or incomplete.
assert.equal(typeof baseClassificationBadge, 'function', 'baseClassificationBadge must be exported for evidence-authority testing');

// 1. Base heuristic with no semantic model: the final label is only a
// fallback copy of the base label and must not become Confirmed.
{
  const value = {
    classification: 'LOGIC',
    confidence: 0.20,
    evidence: [],
    base: { classification: 'LOGIC', confidence: 0.20, evidence: [] },
    refinement: null,
    refinementReason: 'semantic-evidence-unavailable',
  };
  assert.equal(baseClassificationBadge(value, { completeness: 'partial' }), 'unverified');
}

// 2. Matching labels alone are not confirmation when the result is partial.
{
  const value = {
    classification: 'LOGIC',
    base: { classification: 'LOGIC', confidence: 0.20, evidence: [] },
    refinement: { classification: 'LOGIC', confidence: 0.81, evidence: ['semantic-calls'] },
    refinementReason: 'semantic-evidence-confirmed-classification',
  };
  assert.equal(baseClassificationBadge(value, { completeness: 'partial' }), 'unverified');
}

// 3. A missing refinement remains unverified even if a caller supplies a
// complete envelope; this prevents a copied/forged reason from authorizing it.
{
  const value = {
    classification: 'LOGIC',
    base: { classification: 'LOGIC', confidence: 0.20, evidence: [] },
    refinement: null,
    refinementReason: 'semantic-evidence-unavailable',
  };
  assert.equal(baseClassificationBadge(value, { completeness: 'complete' }), 'unverified');
}

// Semantic refinement must carry canonical evidence; an empty refinement is
// not enough to promote the matching base label.
{
  const value = {
    classification: 'LOGIC',
    base: { classification: 'LOGIC', confidence: 0.20, evidence: [] },
    refinement: { classification: 'LOGIC', confidence: 0.81, evidence: [] },
    refinementReason: 'semantic-evidence-confirmed-classification',
  };
  assert.equal(baseClassificationBadge(value, { completeness: 'complete' }), 'unverified');
}

// 4. Only a complete, evidence-backed semantic confirmation may display the
// Confirmed badge, even when the base heuristic itself was weak.
{
  const value = {
    classification: 'LOGIC',
    confidence: 0.88,
    evidence: ['semantic-calls', 'semantic-writes'],
    base: { classification: 'LOGIC', confidence: 0.20, evidence: [] },
    refinement: { classification: 'LOGIC', confidence: 0.88, evidence: ['semantic-calls'] },
    refinementReason: 'semantic-evidence-confirmed-classification',
  };
  assert.equal(baseClassificationBadge(value, { completeness: 'complete' }), 'confirmed');
}

console.log('issue #5111 base classification badge: PASS');

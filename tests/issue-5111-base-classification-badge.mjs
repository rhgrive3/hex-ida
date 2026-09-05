import assert from 'node:assert/strict';
import { baseClassificationBadge } from '../js/ui/product-hardened.js';

// Issue #5111: the base-classification row used a bare
// `value.base.classification === value.classification` comparison for its
// Confirmed badge. On the `semantic-evidence-unavailable` fallback path the
// query returns the base label itself as the final classification with
// `completeness: 'partial'`, so the comparison is trivially true and a
// low-confidence, evidence-free heuristic renders as "Confirmed".

assert.equal(typeof baseClassificationBadge, 'function', 'baseClassificationBadge must be exported for evidence-authority testing');

// The exact counterexample from the issue: base fallback, no refinement.
{
  const value = {
    classification: 'LOGIC',
    confidence: 0.20,
    evidence: [],
    base: { classification: 'LOGIC', confidence: 0.20, evidence: [] },
    refinement: null,
    refinementReason: 'semantic-evidence-unavailable',
  };
  const badge = baseClassificationBadge(value, { completeness: 'partial' });
  assert.equal(badge, 'unverified', 'semantic-evidence-unavailable fallback must not render Confirmed');
}

// Label agreement alone is not confirmation without semantic refinement.
{
  const value = {
    classification: 'LOGIC',
    confidence: 0.20,
    evidence: [],
    base: { classification: 'LOGIC', confidence: 0.20, evidence: [] },
    refinement: null,
    refinementReason: 'semantic-evidence-unavailable',
  };
  assert.equal(baseClassificationBadge(value, { completeness: 'complete' }), 'unverified', 'missing refinement must not render Confirmed');
}

// Partial producer state must never be promoted, even with a refinement object.
{
  const value = {
    classification: 'LOGIC',
    confidence: 0.81,
    evidence: ['semantic-calls'],
    base: { classification: 'LOGIC', confidence: 0.20, evidence: [] },
    refinement: { classification: 'LOGIC', confidence: 0.81, evidence: ['semantic-calls'] },
    refinementReason: 'semantic-evidence-confirmed-classification',
  };
  assert.equal(baseClassificationBadge(value, { completeness: 'partial' }), 'unverified', 'partial completeness must not render Confirmed');
}

// Disagreement stays unverified.
{
  const value = {
    classification: 'PARSER',
    confidence: 0.77,
    evidence: ['semantic-writes'],
    base: { classification: 'LOGIC', confidence: 0.20, evidence: [] },
    refinement: { classification: 'PARSER', confidence: 0.77, evidence: ['semantic-writes'] },
    refinementReason: 'semantic-evidence-refined-classification',
  };
  assert.equal(baseClassificationBadge(value, { completeness: 'complete' }), 'unverified', 'refined-away base must not render Confirmed');
}

// Genuine confirmation: labels agree, producer complete, semantic refinement present.
{
  const value = {
    classification: 'LOGIC',
    confidence: 0.88,
    evidence: ['semantic-calls', 'semantic-writes'],
    base: { classification: 'LOGIC', confidence: 0.20, evidence: [] },
    refinement: { classification: 'LOGIC', confidence: 0.88, evidence: ['semantic-calls'] },
    refinementReason: 'semantic-evidence-confirmed-classification',
  };
  assert.equal(baseClassificationBadge(value, { completeness: 'complete' }), 'confirmed', 'evidence-backed agreement must still render Confirmed');
}

console.log('issue #5111 base classification badge: PASS');

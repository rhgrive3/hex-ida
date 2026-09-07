import assert from 'node:assert/strict';

import {
  genericEvidenceStatus,
  summaryEvidenceStatus,
  provenanceStatus,
} from '../js/ui/evidence-model.js';

// #5817: structured/boolean values must fail closed instead of coercing into
// confirmed/likely display authority.
assert.equal(genericEvidenceStatus({ verdict: ['confirmed'] }), 'unverified', 'array verdict must not become confirmed');
assert.equal(genericEvidenceStatus({ verdict: { status: ['confirmed'] } }), 'unverified', 'array verdict.status must not become confirmed');
assert.equal(genericEvidenceStatus({ status: ['confirmed'] }), 'unverified', 'array status must not become confirmed');
assert.equal(genericEvidenceStatus({ confidence: true }), 'unverified', 'boolean confidence must not become likely');
assert.equal(genericEvidenceStatus({ confidence: [0.8] }), 'unverified', 'array confidence must not become likely');
assert.equal(genericEvidenceStatus({ confidence: '0.9' }), 'unverified', 'numeric-string confidence must not become likely');
assert.equal(summaryEvidenceStatus({ summaryConfidence: true }), 'unverified', 'boolean summaryConfidence must not become likely');
assert.equal(summaryEvidenceStatus({ summaryConfidence: '0.8' }), 'unverified', 'numeric-string summaryConfidence must not become likely');
assert.equal(provenanceStatus({ confidence: true }), 'unverified', 'boolean provenance confidence must not become likely');
assert.equal(provenanceStatus({ confidence: [0.6] }), 'unverified', 'array provenance confidence must not become likely');
assert.equal(provenanceStatus({ confidence: '0.6' }), 'unverified', 'numeric-string provenance confidence must not become likely');
assert.equal(provenanceStatus({ manual: 'false' }), 'unverified', 'string manual flag must not become manual');
assert.equal(provenanceStatus({ manual: [] }), 'unverified', 'array manual flag must not become manual');

assert.equal(genericEvidenceStatus({ verdict: ['contradicted'] }), 'unverified', 'array verdict must not become contradicted');

// Canonical primitive inputs keep their existing display semantics.
assert.equal(genericEvidenceStatus({ verdict: 'confirmed' }), 'confirmed');
assert.equal(genericEvidenceStatus({ verdict: { status: 'contradicted' } }), 'contradicted');
assert.equal(genericEvidenceStatus({ status: 'supported' }), 'likely');
assert.equal(genericEvidenceStatus({ verdict: 'SUPPORTED' }), 'likely');
assert.equal(genericEvidenceStatus({ confirmed: true }), 'confirmed');
assert.equal(genericEvidenceStatus({ verified: true }), 'confirmed');
assert.equal(genericEvidenceStatus({ confidence: 0.9 }), 'likely');
assert.equal(genericEvidenceStatus({ confidence: 0.5 }), 'unverified');
assert.equal(genericEvidenceStatus({ verdict: { status: 'unknown', confidence: 0.9 } }), 'likely');
assert.equal(genericEvidenceStatus({ verdict: 'confirmed', confidence: '0.9' }), 'confirmed', 'canonical verdict keeps authority even when confidence is malformed');
assert.equal(genericEvidenceStatus({ verdict: 'unverified' }), 'unverified');
assert.equal(genericEvidenceStatus({}), 'unverified');
assert.equal(genericEvidenceStatus(null), 'unverified');
assert.equal(summaryEvidenceStatus({ summaryConfidence: 0.8 }), 'likely');
assert.equal(summaryEvidenceStatus({ summary: 'heuristic prose' }), 'likely');
assert.equal(summaryEvidenceStatus({ summary: { text: 'fact', status: 'confirmed' } }), 'confirmed');
assert.equal(summaryEvidenceStatus({}), 'unverified');
assert.equal(provenanceStatus(null), 'unverified');
assert.equal(provenanceStatus({ confidence: 0.6 }), 'likely');
assert.equal(provenanceStatus({ confidence: 0.4 }), 'unverified');
assert.equal(provenanceStatus({ manual: true }), 'manual');
assert.equal(provenanceStatus({ status: 'manual' }), 'manual');
assert.equal(provenanceStatus({ confirmed: true }), 'confirmed');

console.log('#5817 ui evidence status fail-closed: PASS');

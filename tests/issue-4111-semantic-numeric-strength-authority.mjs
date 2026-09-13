import assert from 'node:assert/strict';
import { semanticEvidenceItems, runtimeEvidenceItems } from '../js/semantic-evidence.js';

// #4111: numeric evidence authority (strength / confidence / likelihood ratio)
// must reject non-primitive-number raw values instead of laundering them through
// Number() coercion — Number([1]) === 1 and Number(['1000']) === 1000 turned
// schema-external shapes into maximum strength and arbitrary LR at fusion time.

// Array / string / boolean / object confidence must not raise strength.
for (const badConfidence of [[1], ['0.5'], '1', true, { valueOf: () => 1 }]) {
  const items = semanticEvidenceItems([{
    kind: 'read',
    confidence: badConfidence,
    evidence: [{ id: 'ir:1', instructionId: '1' }],
  }]);
  assert.equal(items.length, 0, `confidence ${JSON.stringify(badConfidence)} must fail closed to zero strength`);
}

// A structured LR override must not become the fusion likelihood ratio.
const [lrRejected] = semanticEvidenceItems(
  [{ kind: 'read', confidence: 1, verified: true, evidence: [{ id: 'ir:1', instructionId: '1' }] }],
  { lr: ['1000'] },
);
assert.equal(lrRejected.lr, 8, 'structured lr falls back to the primitive default');

// Primitive finite numbers keep the existing clamp / fallback semantics.
const [half] = semanticEvidenceItems([{ kind: 'read', confidence: 0.5, evidence: [{ id: 'ir:1' }] }]);
assert.equal(half.strength, 0.5);
const [clamped] = semanticEvidenceItems([{ kind: 'read', confidence: 5, evidence: [{ id: 'ir:1' }] }]);
assert.equal(clamped.strength, 1);
const [lrNumber] = semanticEvidenceItems(
  [{ kind: 'read', confidence: 1, verified: true, evidence: [{ id: 'ir:1' }] }],
  { lr: 1000 },
);
assert.equal(lrNumber.lr, 1000);
const [lrFloor] = semanticEvidenceItems(
  [{ kind: 'read', confidence: 1, verified: true, evidence: [{ id: 'ir:1' }] }],
  { lr: 0 },
);
assert.equal(lrFloor.lr, 1, 'primitive lr below 1 still floors at 1');

// Runtime weight knobs share the same numeric authority.
const runtimeBad = runtimeEvidenceItems(
  { complete: true, touchedFields: [{ key: 'x' }] },
  { strength: true, lr: ['4000'] },
);
assert.equal(runtimeBad.length, 0, 'boolean runtime strength fails closed');

const [runtimeGood] = runtimeEvidenceItems(
  { complete: true, touchedFields: [{ key: 'x' }] },
  { strength: 0.25, lr: 4000 },
);
assert.equal(runtimeGood.strength, 0.25);
assert.equal(runtimeGood.lr, 4000);

const [runtimeDefault] = runtimeEvidenceItems({ complete: true, touchedFields: [{ key: 'x' }] });
assert.equal(runtimeDefault.strength, 1);
assert.equal(runtimeDefault.lr, 18);

console.log('issue-4111 semantic numeric strength/lr authority contract: ok');

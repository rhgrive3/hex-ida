import assert from "node:assert/strict";
import { HypothesisStore } from "../js/ai/hypothesis.js";

console.log("Testing Issue #3096 hypothesis authority boundaries...");

{
  const store = new HypothesisStore({ get: () => null });

  // A malformed explicit id must fail closed instead of being String()-ed into
  // a valid-looking authority id.
  assert.equal(store.upsert({ id: 42, claim: 'x' }), null);
  assert.equal(store.upsert({ id: ['hyp_1'], claim: 'x' }), null);
  assert.equal(store.upsert({ id: { id: 'hyp_1' }, claim: 'x' }), null);
  assert.equal(store.upsert({ id: '', claim: 'x' }), null);

  // Structured selectors must not reach the record map.
  assert.equal(store.get({ toString: () => 'hyp_1' }), null);
  assert.equal(store.get(7), null);
  assert.equal(store.reject(7), null);
  assert.equal(store.verify({ toString: () => 'hyp_1' }), null);

  // Non-number confidence must not be Number()-coerced into a plausible value.
  const structured = store.upsert({ claim: 'c', confidence: { valueOf: () => 0.99 } });
  assert.equal(structured.confidence, 0.5, 'structured confidence falls back to the default');
  assert.equal(store.upsert({ claim: 'c2', confidence: '0.9' }).confidence, 0.5, 'string confidence falls back to the default');

  // A valid string id still works end to end.
  const created = store.upsert({ id: 'hyp_1', claim: 'valid' });
  assert.equal(created.id, 'hyp_1');
  assert.ok(store.get('hyp_1'));
}

{
  // Numeric evidence ids must not launder into support sets through String().
  const store = new HypothesisStore({ get: () => ({ status: "verified" }), has: (id) => id === "ev-ok" });
  const record = store.upsert({ claim: 'c', supportEvidenceIds: [42, 'ev-ok'] });
  assert.deepEqual(record.supportEvidenceIds, ['ev-ok'], 'numeric evidence id must be dropped, not String()-ed');
}

console.log("issue #3096 hypothesis authority boundaries: PASS");

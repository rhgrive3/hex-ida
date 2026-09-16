import assert from 'node:assert/strict';
import test from 'node:test';
import { EvidenceStore } from '../../../js/ai/evidence.js';
import { legacyAiEvidenceToCanonical, canonicalEvidenceToLegacyAi } from '../../../js/core/evidence/compat.js';
import { stableStringify } from '../../../js/core/identity/index.js';

/*
 * #8788: `EvidenceStore.add()` used to collapse every `sourceBinding` through
 * `String(...)`, so two structurally distinct provenance objects hashed into
 * the same auto-generated evidence ID and the second `add()` merged onto the
 * first (the canonical snapshot then held one node instead of two).
 *
 * The repair keeps primitive string binding-key semantics intact (existing
 * behavior for #4519/#1672), preserves an owned/json-safe structured value
 * end-to-end through legacy<->canonical round-trip (#1163), canonicalizes
 * property insertion order, and fails closed on non-canonical shapes
 * (function, symbol, cyclic) instead of laundering them into a shared token.
 */

function fresh(input) {
  const store = new EvidenceStore();
  return { store, record: store.add(input) };
}

test('#8788 distinct structured sourceBinding does not mint one evidence ID', () => {
  const store = new EvidenceStore();
  const a = store.add({ kind:'k', status:'supported', title:'same', sourceTool:'tool',
    sourceBinding:{ type:'fn', target:'A' }, summary:'A' });
  const b = store.add({ kind:'k', status:'supported', title:'same', sourceTool:'tool',
    sourceBinding:{ type:'fn', target:'B' }, summary:'B' });
  assert.ok(a && b, 'both records are accepted');
  assert.notEqual(a.id, b.id, 'distinct structured bindings yield distinct IDs (#8788)');
  assert.deepEqual(a.sourceBinding, { target:'A', type:'fn' },
    'stored binding is the canonicalized structured value, not "[object Object]"');
  assert.deepEqual(b.sourceBinding, { target:'B', type:'fn' });
  assert.equal(store.canonicalSnapshot().toJSON().nodes.length, 2,
    'canonical snapshot does not lose a distinct provenance (#8788)');
});

test('#8788 semantically identical binding with different property order yields one ID', () => {
  const store = new EvidenceStore();
  const c = store.add({ kind:'k', status:'supported', title:'t', sourceTool:'tool',
    sourceBinding:{ b:2, a:1 } });
  const d = store.add({ kind:'k', status:'supported', title:'t', sourceTool:'tool',
    sourceBinding:{ a:1, b:2 } });
  assert.equal(c.id, d.id, 'canonical identity is insertion-order independent');
  assert.deepEqual(c.sourceBinding, d.sourceBinding);
});

test('#8788 primitive binding-key behavior is preserved (#4519 regression)', () => {
  const a = fresh({ kind:'k', status:'supported', title:'t', sourceTool:'tool',
    sourceBinding:'row:0x1000' });
  const b = fresh({ kind:'k', status:'supported', title:'t', sourceTool:'tool',
    sourceBinding:'row:0x2000' });
  assert.equal(a.record.sourceBinding, 'row:0x1000');
  assert.notEqual(a.record.id, b.record.id,
    'primitive binding keys remain distinguished as before');
});

test('#8788 custom toString() object is not laundered to a primitive identity token', () => {
  const store = new EvidenceStore();
  const forged = store.add({ kind:'k', status:'supported', title:'t', sourceTool:'tool',
    sourceBinding:{ toString(){ return 'row:0x1000'; } } });
  const plain = store.add({ kind:'k', status:'supported', title:'t', sourceTool:'tool',
    sourceBinding:'row:0x1000' });
  assert.notEqual(forged.id, plain.id,
    'structured value with a custom toString() must not equal the primitive string id (#8788)');
});

test('#8788 non-canonical sourceBinding shapes fail closed instead of aliasing', () => {
  for (const bad of [Symbol('x'), function fn() {}, (() => { const c = { a:1 }; c.self = c; return c; })()]) {
    assert.throws(
      () => new EvidenceStore().add({ kind:'k', status:'supported', title:'t', sourceTool:'tool', sourceBinding:bad }),
      (err) => err instanceof TypeError && err.message === 'evidence-invalid-sourceBinding',
      `non-canonical sourceBinding must fail closed, not collapse to "[object Object]"`,
    );
  }
});

test('#8788 structured sourceBinding still round-trips through legacy<->canonical compat (#1163)', () => {
  const binding = { type:'function', target:'0x1000' };
  const canonical = legacyAiEvidenceToCanonical({
    id:'ev-8788-1', kind:'k', status:'supported', title:'t', sourceTool:'tool', sourceBinding:binding,
  });
  const roundTrip = canonicalEvidenceToLegacyAi(canonical);
  assert.deepEqual(roundTrip.sourceBinding, binding,
    'compat round-trip preserves the structured value without String() coercion');
});

test('#8788 stable identity is derived via canonical (sorted-key) stringify', () => {
  const a = fresh({ kind:'k', status:'supported', title:'t', sourceTool:'tool',
    sourceBinding:{ zeta:1, alpha:{ two:2, one:1 } } });
  const b = fresh({ kind:'k', status:'supported', title:'t', sourceTool:'tool',
    sourceBinding:{ alpha:{ one:1, two:2 }, zeta:1 } });
  // Different top-level insertion order must yield the same identity.
  assert.equal(a.record.id, b.record.id,
    'stable identity must be a function of sorted-key canonical form');
  assert.equal(stableStringify(a.record.sourceBinding), stableStringify(b.record.sourceBinding));
});

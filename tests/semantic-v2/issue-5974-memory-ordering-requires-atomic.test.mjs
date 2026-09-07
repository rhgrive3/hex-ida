import assert from 'node:assert/strict';
import { createSemanticMemoryAccess } from '../../js/semantics/ir/types.js';

// Issue #5974: a concrete memory ordering is an atomicity claim. Canonical IR
// must fail closed unless `atomic:true` proves the ordering applies — the old
// check only rejected `atomic:false`, letting `atomic:'unknown'` carry
// acquire/release/seq-cst authority that no input proved.

for (const ordering of ['relaxed', 'acquire', 'release', 'acq-rel', 'seq-cst']) {
  assert.throws(
    () => createSemanticMemoryAccess({
      addressSpace: 'memory',
      addressValueId: 'addr',
      widthBits: 32,
      endian: 'little',
      ordering,
      // atomic intentionally omitted -> 'unknown'
    }),
    (err) => err instanceof Error && err.message === 'semantic-ir-memory-ordering-requires-atomic',
    `ordering '${ordering}' with atomic:'unknown' must be rejected`,
  );
  assert.throws(
    () => createSemanticMemoryAccess({
      addressSpace: 'memory',
      addressValueId: 'addr',
      widthBits: 32,
      endian: 'little',
      ordering,
      atomic: false,
    }),
    (err) => err.message === 'semantic-ir-memory-ordering-requires-atomic',
    `ordering '${ordering}' with atomic:false must stay rejected`,
  );
}

// Proven atomicity keeps concrete orderings canonical.
const proven = createSemanticMemoryAccess({
  addressSpace: 'memory',
  addressValueId: 'addr',
  widthBits: 32,
  endian: 'little',
  atomic: true,
  ordering: 'seq-cst',
});
assert.equal(proven.atomic, true);
assert.equal(proven.ordering, 'seq-cst');

// Fully unknown access stays representable.
const unknown = createSemanticMemoryAccess({
  addressSpace: 'memory',
  addressValueId: 'addr',
  widthBits: 32,
  endian: 'little',
});
assert.equal(unknown.atomic, 'unknown');
assert.equal(unknown.ordering, 'unknown');

// Non-atomic access without ordering stays representable.
const plain = createSemanticMemoryAccess({
  addressSpace: 'memory',
  addressValueId: 'addr',
  widthBits: 32,
  endian: 'little',
  atomic: false,
});
assert.equal(plain.atomic, false);
assert.equal(plain.ordering, 'unknown');

console.log('issue-5974 semantic-ir memory ordering requires proven atomicity: ok');

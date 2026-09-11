import assert from 'node:assert/strict';
import test from 'node:test';
import { createSemanticMemoryAccess } from '../../js/semantics/ir/types.js';

// A concrete memory ordering is a canonical fact only for a proven-atomic
// access. The old check rejected `atomic:false` only, so an access whose
// atomicity was merely `unknown` (the default) could carry
// `acquire/release/acq-rel/seq-cst` ordering as a canonical Semantic IR fact
// (#5974). Fail closed: only `atomic:true` may carry a concrete ordering.

const BASE = { addressSpace: 'memory', addressValueId: 'value_addr', widthBits: 32, endian: 'little' };

test('issue-5974: unknown atomicity with concrete ordering is rejected', () => {
  assert.throws(
    () => createSemanticMemoryAccess({ ...BASE, ordering: 'seq-cst' }),
    /semantic-ir-memory-ordering-requires-atomic/,
  );
  assert.throws(
    () => createSemanticMemoryAccess({ ...BASE, atomic: 'unknown', ordering: 'acquire' }),
    /semantic-ir-memory-ordering-requires-atomic/,
  );
});

test('issue-5974: non-atomic access with concrete ordering stays rejected', () => {
  assert.throws(
    () => createSemanticMemoryAccess({ ...BASE, atomic: false, ordering: 'seq-cst' }),
    /semantic-ir-memory-ordering-requires-atomic/,
  );
});

test('issue-5974: every concrete ordering requires proven atomicity', () => {
  for (const ordering of ['acquire', 'release', 'acq-rel', 'seq-cst', 'relaxed']) {
    assert.throws(
      () => createSemanticMemoryAccess({ ...BASE, ordering }),
      /semantic-ir-memory-ordering-requires-atomic/,
      ordering,
    );
  }
});

test('issue-5974: proven-atomic access keeps its concrete ordering', () => {
  const access = createSemanticMemoryAccess({ ...BASE, atomic: true, ordering: 'seq-cst' });
  assert.equal(access.atomic, true);
  assert.equal(access.ordering, 'seq-cst');
});

test('issue-5974: unknown/non-atomic accesses keep ordering unknown', () => {
  const unknown = createSemanticMemoryAccess({ ...BASE, atomic: 'unknown', ordering: 'unknown' });
  assert.equal(unknown.atomic, 'unknown');
  assert.equal(unknown.ordering, 'unknown');

  const unspecified = createSemanticMemoryAccess({ ...BASE });
  assert.equal(unspecified.atomic, 'unknown');
  assert.equal(unspecified.ordering, 'unknown');

  const plain = createSemanticMemoryAccess({ ...BASE, atomic: false, ordering: 'unknown' });
  assert.equal(plain.atomic, false);
  assert.equal(plain.ordering, 'unknown');
});

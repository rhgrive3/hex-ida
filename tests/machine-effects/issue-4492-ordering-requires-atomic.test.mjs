import assert from 'node:assert/strict';

import { createMemoryAccess } from '../../js/semantics/effects/index.js';

const BASE = Object.freeze({
  space: 'memory',
  addressExpr: { kind:'bitvector', widthBits:64, value:'4096' },
  widthBits: 64,
  endian: 'little',
});

// #4492: concrete ordering is a canonical machine-effects fact only when
// atomicity is explicitly proven true.
for (const ordering of ['acquire', 'release', 'acq-rel', 'seq-cst', 'relaxed']) {
  const access = createMemoryAccess({ ...BASE, atomic:true, ordering });
  assert.equal(access.atomic, true);
  assert.equal(access.ordering, ordering);
}

for (const atomic of [false, undefined]) {
  const input = { ...BASE, ordering:'acquire' };
  if (atomic !== undefined) input.atomic = atomic;
  assert.throws(
    () => createMemoryAccess(input),
    /machine-effects-ordering-requires-atomic-access/,
    `ordering must reject atomic=${String(atomic)}`,
  );
}

const ordinary = createMemoryAccess(BASE);
assert.equal('atomic' in ordinary, false, 'ordering-free accesses keep the existing omitted atomic shape');
assert.equal('ordering' in ordinary, false, 'ordering-free accesses keep the existing omitted ordering shape');

assert.throws(
  () => createMemoryAccess({ ...BASE, atomic:true, ordering:'not-an-ordering' }),
  /machine-effects-invalid-memory-ordering/,
);

console.log('issue-4492 machine-effects ordering atomic boundary: PASS');

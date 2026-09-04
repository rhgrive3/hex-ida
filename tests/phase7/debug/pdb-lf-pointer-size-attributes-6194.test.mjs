import test from 'node:test';
import assert from 'node:assert/strict';
import { describeTypeIndex } from '../../../js/analysis/debug/pdb.js';

test('issue #6194: LF_POINTER attributes Size and Kind determine pointer widthBits', () => {
  const types = new Map();

  types.set(0x1000, {
    kind: 'pointer',
    referent: 0x0074,
    attributes: (4 << 13) | 0x0a,
  });

  const ptr32 = describeTypeIndex(0x1000, types);
  assert.equal(ptr32.name, 'int *');
  assert.equal(ptr32.widthBits, 32, 'Size=4 must yield widthBits: 32');
  assert.equal(ptr32.class, 'pointer');
  assert.equal(ptr32.complete, true);

  types.set(0x1001, {
    kind: 'pointer',
    referent: 0x0074,
    attributes: (8 << 13) | 0x0c,
  });

  const ptr64 = describeTypeIndex(0x1001, types);
  assert.equal(ptr64.name, 'int *');
  assert.equal(ptr64.widthBits, 64, 'Size=8 must yield widthBits: 64');
  assert.equal(ptr64.class, 'pointer');
  assert.equal(ptr64.complete, true);

  types.set(0x1002, {
    kind: 'pointer',
    referent: 0x0074,
    attributes: (12 << 13) | (2 << 5),
  });

  const ptrMember = describeTypeIndex(0x1002, types);
  assert.equal(ptrMember.name, 'int *');
  assert.equal(ptrMember.widthBits, 96, 'Size=12 must yield widthBits: 96');
  assert.equal(ptrMember.class, 'pointer');
  assert.equal(ptrMember.complete, true);

  types.set(0x1003, {
    kind: 'pointer',
    referent: 0x0074,
    attributes: (8 << 13) | 0x0a,
  });

  const contradictory = describeTypeIndex(0x1003, types);
  assert.equal(contradictory.complete, false, 'Contradictory size/kind must fail closed');
  assert.equal(contradictory.widthBits, null, 'Malformed pointer attributes must not expose machine width authority');

  types.set(0x1004, {
    kind: 'pointer',
    referent: 0x0074,
    attributes: 0,
  });

  const zeroSize = describeTypeIndex(0x1004, types);
  assert.equal(zeroSize.complete, false, 'Zero size with unknown kind must not complete');
  assert.equal(zeroSize.widthBits, null, 'Unknown pointer width must remain unknown');
});

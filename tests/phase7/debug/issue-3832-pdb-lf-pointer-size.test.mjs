import assert from 'node:assert/strict';
import { describeTypeIndex } from '../../../js/analysis/debug/pdb.js';

const INT = 0x0074;

function pointerType(attributes, referent = INT) {
  return new Map([[0x1100, { leaf: 0x1002, kind: 'pointer', referent, attributes }]]);
}

// Near32 kinds: 0x0a (near32), 0x0b (const near32?); Near64: 0x0c; member: 0x00.
const NEAR32 = 0x0a;
const NEAR64 = 0x0c;
const MEMBER = 0x00;

{
  const described = describeTypeIndex(0x1100, pointerType((4 << 13) | NEAR32));
  assert.equal(described.widthBits, 32);
  assert.equal(described.class, 'pointer');
  assert.equal(described.complete, true);
}
{
  const described = describeTypeIndex(0x1100, pointerType((8 << 13) | NEAR64));
  assert.equal(described.widthBits, 64);
  assert.equal(described.complete, true);
}
{
  const described = describeTypeIndex(0x1100, pointerType((4 << 13) | MEMBER));
  assert.equal(described.widthBits, 32);
  assert.equal(described.complete, true);
}
{
  for (const attributes of [MEMBER, (0 << 13) | 0x1f, (100 << 13) | MEMBER, NEAR64]) {
    const described = describeTypeIndex(0x1100, pointerType(attributes));
    if (attributes === NEAR64) {
      assert.equal(described.widthBits, 64);
      assert.equal(described.complete, true);
      continue;
    }
    if (described.widthBits === 64 && described.complete) {
      assert.fail(`attributes 0x${attributes.toString(16)} must not be promoted to exact 64-bit`);
    }
  }
}
{
  const described = describeTypeIndex(0x1100, pointerType((8 << 13) | NEAR32));
  assert.equal(described.complete, false);
}
{
  const described = describeTypeIndex(0x1100, pointerType((4 << 13) | NEAR32, 0x1234));
  assert.equal(described.complete, false);
}

console.log('issue-3832-pdb-lf-pointer-size: PASS');

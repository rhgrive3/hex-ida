import assert from 'node:assert/strict';

import { canonicalAggregateLayout } from '../../../js/targets/abi/aggregate-layout.js';

{
  const sourceMembers = [
    { bits:8, bytes:1, byteOffset:0 },
    { bits:8, bytes:1, byteOffset:1 },
  ];
  const layout = canonicalAggregateLayout({ bits:16, bytes:2, members:sourceMembers, padding:[] });
  assert.ok(layout, 'valid two-member aggregate must canonicalize');
  assert.equal(Object.isFrozen(layout), true);
  assert.equal(Object.isFrozen(layout.members), true);
  assert.equal(Object.isFrozen(layout.members[0]), true);
  assert.equal(Object.isFrozen(layout.members[1]), true);
  assert.throws(() => { layout.members[1].byteOffset = 0; }, TypeError);
  assert.deepEqual(layout.members.map(({ byteOffset, bytes }) => [byteOffset, bytes]), [[0,1],[1,1]]);

  sourceMembers[1].byteOffset = 0;
  sourceMembers[1].bytes = 2;
  assert.deepEqual(
    layout.members.map(({ byteOffset, bytes }) => [byteOffset, bytes]),
    [[0,1],[1,1]],
    'canonical member authority must be detached from later source mutation',
  );
}

{
  const sourcePadding = [{ bytes:1, byteOffset:1 }];
  const layout = canonicalAggregateLayout({
    bits:8,
    bytes:2,
    members:[{ bits:8, bytes:1, byteOffset:0 }],
    padding:sourcePadding,
  });
  assert.ok(layout, 'member plus explicit trailing padding must canonicalize');
  assert.equal(Object.isFrozen(layout.padding), true);
  assert.equal(Object.isFrozen(layout.padding[0]), true);
  assert.deepEqual(layout.padding[0], { offset:1, bytes:1, end:2 });
  assert.throws(() => { layout.padding[0].offset = 0; }, TypeError);
  assert.throws(() => { layout.padding[0].bytes = 2; }, TypeError);
  assert.throws(() => { layout.padding[0].end = 3; }, TypeError);
  assert.deepEqual(layout.padding[0], { offset:1, bytes:1, end:2 });

  sourcePadding[0].byteOffset = 0;
  sourcePadding[0].bytes = 2;
  assert.deepEqual(
    layout.padding[0],
    { offset:1, bytes:1, end:2 },
    'canonical padding authority must be detached from later source mutation',
  );
}

console.log('issue #5599 aggregate layout canonical immutability regression: ok');

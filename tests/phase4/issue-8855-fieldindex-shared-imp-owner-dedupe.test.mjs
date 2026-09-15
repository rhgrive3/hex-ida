// Issue #8855 regression: FieldIndex de-duplicated the owner list of a shared
// IMP with a linear `owners.some(...)` scan per insertion. Objective-C metadata
// legally shares one implementation across tens of thousands of distinct
// selectors (#272 made methodOwner 1:N for exactly this case), so constructing
// a FieldIndex over a valid 60 000-method image performed ~Θ(M²) comparisons
// in ONE synchronous turn and blocked analysis for seconds. Dedupe must stay
// exact — same (className, sel, kind) identity, first insertion wins — but the
// scan must be table-driven, not per-owner linear.
import assert from 'node:assert/strict';
import test from 'node:test';

import { FieldIndex } from '../../js/fields.js';

function sharedImpModel(methodsPerClass, classes = 2, addr = 0x1000n) {
  return { classes: Array.from({ length: classes }, (_, c) => ({
    name: `C${c}`,
    instanceSize: 32,
    ivars: [],
    methods: Array.from({ length: methodsPerClass }, (_, i) => ({
      sel: `s_${c}_${i}`, addr, kind: '-',
    })),
    classMethods: [],
  })) };
}

test('#8855 shared-IMP owner construction is linear-bounded, not Θ(M²)', () => {
  // 50 000 distinct selectors sharing ONE executable IMP. The pre-fix scan
  // needs ~1.25 billion comparisons (~6 s on the audit machine, 9 s at the
  // issue's 60 000-method scale); the dedupe table makes this a few ms.
  const model = sharedImpModel(25_000, 2);
  const startedAt = performance.now();
  const index = new FieldIndex(model);
  const elapsedMs = performance.now() - startedAt;
  assert.ok(elapsedMs < 2500,
    `FieldIndex over 50 000 shared-IMP owners took ${elapsedMs.toFixed(0)} ms (bound 2500 ms)`);
});

test('#8855 all shared-IMP owners are retained with first-insert order', () => {
  const index = new FieldIndex(sharedImpModel(500, 3));
  const owners = index.ownersOf(0x1000n);
  assert.equal(owners.length, 1500);
  assert.equal(owners[0].className, 'C0');
  assert.equal(owners[0].sel, 's_0_0');
  assert.equal(owners[1499].className, 'C2');
  assert.equal(owners[1499].sel, 's_2_499');
  const owner = index.ownerOf(0x1000n);
  assert.equal(owner.ambiguous, true);
  assert.equal(owner.owners.length, 1500);
});

test('#8855 duplicate (className, sel, kind) identities stay deduplicated exactly', () => {
  const addr = 0x2000n;
  const index = new FieldIndex({ classes: [
    { name: 'Dup', instanceSize: 8, ivars: [], methods: [
      { sel: 'same', addr, kind: '-' },
      { sel: 'same', addr, kind: '-' },          // exact duplicate -> dropped
      { sel: 'same', addr, kind: '+' },          // different kind -> retained
      { addr, kind: '-' },                       // null selector retained
      { addr, kind: '-' },                       // duplicate null-sel -> dropped
    ], classMethods: [
      { sel: 'same', addr, kind: '+' },          // classMethods list shares the identity space
    ] },
    { name: 'Other', instanceSize: 8, ivars: [], methods: [
      { sel: 'same', addr, kind: '-' },          // different class -> retained
    ], classMethods: [] },
  ] });
  const owners = index.ownersOf(addr);
  assert.equal(owners.length, 4);
  assert.deepEqual(owners.map((o) => `${o.className}\u0000${o.sel ?? ''}\u0000${o.kind}`), [
    'Dup\u0000same\u0000-', 'Dup\u0000same\u0000+', 'Dup\u0000\u0000-', 'Other\u0000same\u0000-',
  ]);
});

test('#8855 unrelated IMPs and empty models keep their exact shape', () => {
  const index = new FieldIndex({ classes: [
    { name: 'Solo', instanceSize: 8, ivars: [], methods: [
      { sel: 'a', addr: 0x3000n, kind: '-' },
      { sel: 'b', addr: 0x3001n, kind: '-' },
    ], classMethods: [] },
  ] });
  assert.equal(index.ownersOf(0x3000n).length, 1);
  assert.equal(index.ownersOf(0x3001n).length, 1);
  assert.equal(index.ownerOf(0x3000n).sel, 'a');
  assert.deepEqual(new FieldIndex({ classes: [] }).ownersOf(0x3002n), []);
});

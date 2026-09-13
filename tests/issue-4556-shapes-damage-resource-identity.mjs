// #4556: damage-source resource matching must preserve object identity.
import assert from 'node:assert/strict';

import { AMOUNT, SHAPE, damageSources, evidenceFor, foldShapes, resources } from '../js/shapes.js';

function scanOf(fields) {
  const count = fields.count;
  return {
    count,
    complete: true,
    capped: false,
    disp: Int32Array.from(fields.disp),
    size: Uint8Array.from(fields.size),
    flags: Uint8Array.from(fields.flags),
    amtKind: Uint8Array.from(fields.amtKind),
    amtDisp: Int32Array.from(fields.amtDisp),
    amtSize: Uint8Array.from(fields.amtSize),
    addr: BigUint64Array.from(fields.addr),
    baseIdentity: fields.baseIdentity,
    amtBaseIdentity: fields.amtBaseIdentity,
  };
}

// Cross-object: A(+0x40, size4) is the resource; the damage source B reduces a
// DIFFERENT object C's +0x40 (size8, not a resource). B must not be credited
// for A's resource just because the raw displacement collides.
{
  const scan = scanOf({
    count: 10,
    disp: [64, 64, 64, 64, 64, 64, 64, 64, 64, 64],
    size: [4, 4, 4, 4, 4, 4, 8, 8, 8, 8],
    flags: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    amtKind: [0, 0, 0, 0, 0, 0, 1, 1, 1, 1],
    amtDisp: [0, 0, 0, 0, 0, 0, 128, 128, 128, 128],
    amtSize: [0, 0, 0, 0, 0, 0, 4, 4, 4, 4],
    addr: [0n, 4n, 8n, 12n, 16n, 20n, 24n, 28n, 32n, 36n],
    baseIdentity: ['A', 'A', 'A', 'A', 'A', 'A', 'C', 'C', 'C', 'C'],
    amtBaseIdentity: [null, null, null, null, null, null, 'B', 'B', 'B', 'B'],
  });
  const folded = foldShapes(scan);
  const res = resources(folded, 24);
  const dmg = damageSources(folded, res, 24);
  const b = dmg.find((x) => x.identity === 'B');
  assert.ok(b, 'expected damage source B');
  assert.equal(b.score, 0.45, `cross-object A must not inflate B score (got ${b.score})`);
  const ev = evidenceFor(folded, 128, 'damage');
  const code = ev?.codes.find((c) => c.code === 'loc-damage-source');
  assert.equal(code?.strength, 0.45, `evidenceFor must not inflate cross-object strength (got ${code?.strength})`);
}

// Same identity: B reducing A's own +0x40 resource keeps the +0.25 credit.
{
  const scan = scanOf({
    count: 10,
    disp: [64, 64, 64, 64, 64, 64, 64, 64, 64, 64],
    size: [4, 4, 4, 4, 4, 4, 8, 8, 8, 8],
    flags: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    amtKind: [0, 0, 0, 0, 0, 0, 1, 1, 1, 1],
    amtDisp: [0, 0, 0, 0, 0, 0, 64, 64, 64, 64],
    amtSize: [0, 0, 0, 0, 0, 0, 4, 4, 4, 4],
    addr: [0n, 4n, 8n, 12n, 16n, 20n, 24n, 28n, 32n, 36n],
    baseIdentity: ['A', 'A', 'A', 'A', 'A', 'A', 'A', 'A', 'A', 'A'],
    amtBaseIdentity: [null, null, null, null, null, null, 'B', 'B', 'B', 'B'],
  });
  const folded = foldShapes(scan);
  const res = resources(folded, 24);
  const dmg = damageSources(folded, res, 24);
  const b = dmg.find((x) => x.identity === 'B');
  assert.ok(b, 'expected damage source B');
  assert.equal(b.score, 0.70, `same-identity A resource must retain +0.25 credit (got ${b.score})`);
}

// Legacy unknown-provenance recall survives: with no identities, displacement
// aggregation still connects the source to the resource (under penalty).
{
  const scan = scanOf({
    count: 10,
    disp: [64, 64, 64, 64, 64, 64, 64, 64, 64, 64],
    size: [4, 4, 4, 4, 4, 4, 8, 8, 8, 8],
    flags: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    amtKind: [0, 0, 0, 0, 0, 0, 1, 1, 1, 1],
    amtDisp: [0, 0, 0, 0, 0, 0, 128, 128, 128, 128],
    amtSize: [0, 0, 0, 0, 0, 0, 4, 4, 4, 4],
    addr: [0n, 4n, 8n, 12n, 16n, 20n, 24n, 28n, 32n, 36n],
    baseIdentity: [null, null, null, null, null, null, null, null, null, null],
    amtBaseIdentity: [null, null, null, null, null, null, null, null, null, null],
  });
  const folded = foldShapes(scan);
  const res = resources(folded, 24);
  const dmg = damageSources(folded, res, 24);
  assert.ok(dmg.length >= 1, 'legacy unknown scan must still yield a damage source');
  assert.ok(dmg[0].score > 0, 'legacy unknown recall preserved under penalty');
}

console.log('issue-4556: ok');

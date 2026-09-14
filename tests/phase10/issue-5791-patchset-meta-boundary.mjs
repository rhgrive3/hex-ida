// Regression for #5791: PatchSet.add() meta may only carry descriptive
// metadata — the validated structural fields (offset/before/after) must always
// win, so the apply()-time before-byte guard can never be overwritten away.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PatchSet } from '../../js/patch.js';

test('#5791 meta.before cannot overwrite the validated before-bytes guard', async () => {
  const patches = new PatchSet();
  patches.add(0n, new Uint8Array([0x41]), new Uint8Array([0x42]), { before: new Uint8Array(0) });
  await assert.rejects(patches.apply(new Blob([new Uint8Array([0x99])])), /元のバイトが変わっています|before/, 'untouched source bytes must not pass the before-byte guard');
});

test('#5791 meta cannot overwrite offset, after, or their lengths', () => {
  const patches = new PatchSet();
  patches.add(
    0n,
    new Uint8Array([0x41, 0x41]),
    new Uint8Array([0x42, 0x42]),
    { offset: 999n, after: new Uint8Array([0x00]), before: new Uint8Array([0x00]) },
  );
  const [item] = patches.list();
  assert.equal(item.offset, 0n);
  assert.equal(item.after.length, 2);
  assert.equal(item.before.length, 2);
  assert.deepEqual([...item.before], [0x41, 0x41]);
  assert.deepEqual([...item.after], [0x42, 0x42]);
});

test('#5791 metadata cannot move a stored patch out of overlap validation', () => {
  const patches = new PatchSet();
  patches.add(0n, new Uint8Array([0x41, 0x41]), new Uint8Array([0x42, 0x42]), {
    offset: 100n,
    before: new Uint8Array([0x00]),
    after: new Uint8Array([0x00]),
  });
  assert.equal(patches.at(0n).offset, 0n);
  assert.throws(
    () => patches.add(1n, new Uint8Array([0x43]), new Uint8Array([0x44])),
    /overlaps existing patch/,
  );
});

test('#5791 descriptive meta is preserved and __proto__ cannot retarget the item', () => {
  const patches = new PatchSet();
  const hostileMeta = JSON.parse('{"note":"legit","__proto__":{"evil":true}}');
  patches.add(0n, new Uint8Array([0x41]), new Uint8Array([0x42]), hostileMeta);
  const [item] = patches.list();
  assert.equal(item.note, 'legit');
  assert.ok(Object.hasOwn(item, '__proto__'));
  assert.deepEqual(item.__proto__, { evil: true });
  assert.equal(Object.getPrototypeOf(item), Object.prototype);
  assert.deepEqual([...item.before], [0x41]);
});

test('#5791 a normal patch still applies end to end', async () => {
  const patches = new PatchSet();
  patches.add(1n, new Uint8Array([0x41, 0x42]), new Uint8Array([0x99, 0x98]), { note: 'ok' });
  const output = await patches.apply(new Blob([new Uint8Array([0x00, 0x41, 0x42, 0xff])]));
  const bytes = new Uint8Array(await output.arrayBuffer());
  assert.deepEqual([...bytes], [0x00, 0x99, 0x98, 0xff]);
});

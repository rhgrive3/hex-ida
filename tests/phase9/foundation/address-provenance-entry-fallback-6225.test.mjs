import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Load the real classic-script implementation. These state-transition tests
// do not decode instructions; the worker-composition regression does that.
const context = {};
runInNewContext(readFileSync(new URL('../../../js/address-provenance.js', import.meta.url), 'utf8'), context);
const fallback = { allowEntryFallback: true };
const create = (options = {}) => context.AddressProvenance.create({
  words: { KIND: {} }, rangeStart: 0n, rangeEnd: 64n, pairWindow: 4,
  entryKills: [[12n, [0]], [12n, [1]]], ...options,
});

for (const reverse of [false, true]) {
  test(`#6225 duplicate kills retain explicit first-visit fallback (reverse=${reverse})`, () => {
    const entryKills = [[12n, [0]], [12n, [1]]];
    if (reverse) entryKills.reverse();
    const original = structuredClone(entryKills);
    const p = create({ entryKills });
    p.note(0, 0x1000n, 0);
    p.note(1, 0x2000n, 1);
    p.note(2, 0x3000n, 0);
    assert.equal(p.pendingEntries, 1);
    assert.equal(p.enter(12n), true);
    assert.equal(p.base(0, 3), null, 'old x0 must not become exact at the merge');
    assert.equal(p.base(1, 3), null, 'old x1 must not become exact at the merge');
    assert.equal(p.base(0, 3, fallback), 0x1000n);
    assert.equal(p.base(1, 3, fallback), 0x2000n);
    assert.equal(p.base(2, 3), 0x3000n);
    assert.equal(p.pendingEntries, 0);
    const generation = p.generation;
    assert.equal(p.enter(12n), false, 'a consumed entry must not be applied twice');
    assert.equal(p.generation, generation);
    assert.equal(p.base(0, 6, fallback), null, 'fallback obeys the original pair window');
    assert.equal(p.base(1, 6, fallback), null);
    assert.deepEqual(entryKills, original, 'normalization must not mutate caller kill lists');
  });
}

test('#6225 an immediately preceding exact construction survives only for its own register', () => {
  const p = create();
  p.note(0, 0x1000n, 2);
  p.note(1, 0x2000n, 0);
  p.enter(12n);
  assert.equal(p.base(0, 3), 0x1000n);
  assert.equal(p.base(1, 3), null);
  assert.equal(p.base(1, 3, fallback), 0x2000n);
  p.kill(1);
  assert.equal(p.base(1, 3, fallback), null, 'a later write must remove the fallback');
  p.note(1, 0x4000n, 3);
  assert.equal(p.base(1, 3), 0x4000n);
  assert.equal(p.base(1, 3, fallback), 0x4000n);
  p.clear();
  assert.equal(p.base(0, 3, fallback), null);
  assert.equal(p.base(1, 3, fallback), null);
});

for (const boundary of ['functionStarts', 'branchEntries']) {
  test(`#6225 ${boundary} still clears all exact and fallback state`, () => {
    const p = create({ [boundary]: [12n] });
    p.note(0, 0x1000n, 2);
    p.note(1, 0x2000n, 0);
    p.note(2, 0x3000n, 0);
    assert.equal(p.enter(12n), true);
    for (const reg of [0, 1, 2]) {
      assert.equal(p.base(reg, 3), null);
      assert.equal(p.base(reg, 3, fallback), null);
    }
    assert.equal(p.pendingEntries, 0);
  });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { SymbolIndex } from '../js/symbols.js';

function makeIndex() {
  return new SymbolIndex({
    addrs: new BigUint64Array([0x1000n, 0x2000n, 0x3000n]),
    kinds: new Uint8Array([0, 0, 0]),
    names: '_orig_a\n_orig_b\n_orig_c',
    funcs: new BigUint64Array([0x1000n, 0x2000n, 0x3000n]),
  });
}

test('renameMany: 150,000 entries complete in < 1000ms with single refresh and accurate lookups', () => {
  const COUNT = 150_000;
  const index = new SymbolIndex({});

  // Deliberately supply entries in non-sorted (interleaved) order to exercise O(N log N) sort path.
  const entries = new Array(COUNT);
  for (let i = 0; i < COUNT; i++) {
    const shuffled = (i * 7919) % COUNT;
    const addr = 0x100000000n + BigInt(shuffled) * 4n;
    entries[i] = [addr, `fn_${shuffled}`];
  }

  let refreshCount = 0;
  const origRefresh = index._refreshRenameAddrs.bind(index);
  index._refreshRenameAddrs = () => {
    refreshCount++;
    return origRefresh();
  };

  const genBefore = index.gen;
  const t0 = performance.now();
  const applied = index.renameMany(entries, { replace: true });
  const elapsedMs = performance.now() - t0;

  console.log(`[symbols-batch-rename-perf] 150,000 renameMany elapsed: ${elapsedMs.toFixed(1)} ms`);

  assert.equal(applied, COUNT);
  assert.equal(refreshCount, 1, '_refreshRenameAddrs must run exactly once');
  assert.equal(index.gen, genBefore + 1, 'gen must increment exactly once');
  assert.ok(elapsedMs < 1000, `expected < 1000ms for 150,000 renames, got ${elapsedMs.toFixed(1)}ms`);

  // Verify sorted _renameAddrs invariant and representative / boundary lookups
  assert.equal(index._renameAddrs.length, COUNT);
  for (let i = 1; i < COUNT; i++) {
    assert.ok(index._renameAddrs[i - 1] < index._renameAddrs[i]);
  }

  const sampleIndices = [0, 1, 12345, 75000, 149998, 149999];
  for (const s of sampleIndices) {
    const addr = 0x100000000n + BigInt(s) * 4n;
    const expected = `fn_${s}`;
    assert.equal(index.nameAt(addr), expected);
    assert.equal(index.renamedAt(addr), expected);
    assert.equal(index.exact(addr)?.name, expected);
    assert.equal(index.nearest(addr + 2n)?.name, expected);
    assert.equal(index.nearest(addr + 2n)?.delta, 2n);
  }
});

test('renameMany: replace:true clears existing renames, replace:false appends and deletes', () => {
  const index = makeIndex();
  index.rename(0x1000n, 'old_a');
  index.rename(0x2000n, 'old_b');

  // replace: true with object entries ({ addr, name })
  const appliedReplace = index.renameMany([
    { addr: 0x2000n, name: 'new_b' },
    { addr: 0x4000n, name: 'new_d' },
  ], { replace: true });
  assert.equal(appliedReplace, 2);
  assert.equal(index.renamedAt(0x1000n), null, 'old_a must be cleared on replace:true');
  assert.equal(index.nameAt(0x1000n), '_orig_a', 'original binary symbol restored');
  assert.equal(index.nameAt(0x2000n), 'new_b');
  assert.equal(index.nameAt(0x4000n), 'new_d');
  assert.deepEqual(index._renameAddrs, [0x2000n, 0x4000n]);

  // replace: false appends new entry, updates existing, and deletes with '' / null
  const appliedPatch = index.renameMany([
    [0x3000n, 'added_c'],
    [0x2000n, 'updated_b'],
    [0x4000n, ''],
    [0x9999n, null], // deleting non-existent key is a safe no-op
    ['0x5000', 'hex_str_e'],
  ], { replace: false });
  assert.equal(appliedPatch, 4);
  assert.equal(index.nameAt(0x2000n), 'updated_b');
  assert.equal(index.nameAt(0x3000n), 'added_c');
  assert.equal(index.renamedAt(0x4000n), null);
  assert.equal(index.nameAt(0x5000n), 'hex_str_e');
  assert.deepEqual(index._renameAddrs, [0x2000n, 0x3000n, 0x5000n]);

  // replace: true with empty list clears all renames
  const genBeforeClear = index.gen;
  assert.equal(index.renameMany([], { replace: true }), 0);
  assert.equal(index.renames.size, 0);
  assert.deepEqual(index._renameAddrs, []);
  assert.equal(index.gen, genBeforeClear + 1);
});

test('single rename: existing update skips _refreshRenameAddrs, insert/delete maintain sorted order and boundary addresses', () => {
  const index = makeIndex();
  let refreshCount = 0;
  const origRefresh = index._refreshRenameAddrs.bind(index);
  index._refreshRenameAddrs = () => {
    refreshCount++;
    return origRefresh();
  };

  // Insert out-of-order using BigInt and hex string, including boundary 0n and u64 max
  index.rename(0x3000n, 'fn_3000');
  index.rename(0n, 'fn_zero');
  index.rename('0x1000', 'fn_1000_hex');
  index.rename(0xffffffffffffffffn, 'fn_u64_max');
  index.rename('0x2000', 'fn_2000_hex');

  assert.equal(refreshCount, 0, 'single rename must use binary-search insert instead of full _refreshRenameAddrs');
  assert.deepEqual(index._renameAddrs, [0n, 0x1000n, 0x2000n, 0x3000n, 0xffffffffffffffffn]);
  assert.equal(index.nameAt(0n), 'fn_zero');
  assert.equal(index.nameAt(0x1000n), 'fn_1000_hex');
  assert.equal(index.nameAt(0x2000n), 'fn_2000_hex');
  assert.equal(index.nameAt(0xffffffffffffffffn), 'fn_u64_max');

  // Update existing key: must bump gen without calling _refreshRenameAddrs or duplicating _renameAddrs
  const genBeforeUpdate = index.gen;
  index.rename(0x2000n, 'fn_2000_v2');
  assert.equal(refreshCount, 0);
  assert.equal(index.gen, genBeforeUpdate + 1);
  assert.equal(index.nameAt(0x2000n), 'fn_2000_v2');
  assert.deepEqual(index._renameAddrs, [0n, 0x1000n, 0x2000n, 0x3000n, 0xffffffffffffffffn]);

  // Delete middle and boundary entries
  index.rename('0x2000', '');
  index.rename(0n, null);
  assert.equal(refreshCount, 0);
  assert.equal(index.renamedAt(0x2000n), null);
  assert.equal(index.nameAt(0x2000n), '_orig_b');
  assert.equal(index.renamedAt(0n), null);
  assert.deepEqual(index._renameAddrs, [0x1000n, 0x3000n, 0xffffffffffffffffn]);

  // Invalid / structured addresses must be ignored (#5970 compatibility)
  const genBeforeInvalid = index.gen;
  index.rename(['4096'], 'forged');
  index.rename(-1n, 'negative');
  index.rename('not-a-hex', 'bad');
  assert.equal(index.gen, genBeforeInvalid);
  assert.deepEqual(index._renameAddrs, [0x1000n, 0x3000n, 0xffffffffffffffffn]);
});

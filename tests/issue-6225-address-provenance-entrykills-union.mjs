import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadProvenance() {
  const context = vm.createContext({
    console, TextDecoder, TextEncoder, Uint8Array, Uint8ClampedArray, Uint16Array,
    Uint32Array, Int32Array, BigUint64Array, BigInt64Array, DataView, ArrayBuffer,
    BigInt, Map, Set, WeakMap, WeakSet, Promise, Object, Array, Math, Number,
    String, Boolean, RegExp, Error, TypeError, RangeError, JSON, Date,
  });
  context.globalThis = context;
  context.self = context;
  for (const file of ['js/words.js', 'js/address-provenance.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  }
  return context.AddressProvenance;
}

const AddressProvenance = loadProvenance();

// 1. Multiple entryKills for the same target must union all killed registers
{
  const p = AddressProvenance.create({
    range: [0n, 0x10000n],
    entryKills: [
      [8n, [0]],
      [8n, [1]],
    ],
  });

  p.note(0, 0x1000n, 0);
  p.note(1, 0x2000n, 0);
  p.note(2, 0x3000n, 0);

  // Before enter, all are present
  assert.equal(p.base(0, 2), 0x1000n);
  assert.equal(p.base(1, 2), 0x2000n);
  assert.equal(p.base(2, 2), 0x3000n);

  p.enter(8n);

  // Both register 0 and register 1 must be killed (null for regular base queries without fallback scanIndex)
  assert.equal(p.base(0, 2), null, 'r0 must be killed by first entryKill');
  assert.equal(p.base(1, 2), null, 'r1 must be killed by second entryKill');
  assert.equal(p.base(2, 2), 0x3000n, 'r2 must not be killed');
}

// 2. Commutativity: reversing entry order produces identical results
{
  const p = AddressProvenance.create({
    range: [0n, 0x10000n],
    entryKills: [
      [8n, [1]],
      [8n, [0]],
    ],
  });

  p.note(0, 0x1000n, 0);
  p.note(1, 0x2000n, 0);
  p.note(2, 0x3000n, 0);

  p.enter(8n);

  assert.equal(p.base(0, 2), null, 'r0 must be killed');
  assert.equal(p.base(1, 2), null, 'r1 must be killed');
  assert.equal(p.base(2, 2), 0x3000n, 'r2 must not be killed');
}

// 3. Duplicate registers across entries are cleanly deduplicated
{
  const p = AddressProvenance.create({
    range: [0n, 0x10000n],
    entryKills: [
      [8n, [0, 1]],
      [8n, [1, 2]],
    ],
  });

  assert.equal(p.pendingEntries, 1, 'duplicate targets should count as 1 pending entry');

  p.note(0, 0x1000n, 0);
  p.note(1, 0x2000n, 0);
  p.note(2, 0x3000n, 0);
  p.note(3, 0x4000n, 0);

  p.enter(8n);

  assert.equal(p.base(0, 2), null);
  assert.equal(p.base(1, 2), null);
  assert.equal(p.base(2, 2), null);
  assert.equal(p.base(3, 2), 0x4000n);
}

// 4. Different targets do not contaminate each other
{
  const p = AddressProvenance.create({
    range: [0n, 0x10000n],
    entryKills: [
      [8n, [0]],
      [16n, [1]],
    ],
  });

  assert.equal(p.pendingEntries, 2);

  p.note(0, 0x1000n, 0);
  p.note(1, 0x2000n, 0);

  p.enter(8n);

  assert.equal(p.base(0, 2), null);
  assert.equal(p.base(1, 2), 0x2000n, 'r1 must remain valid when entering target 8n');

  p.enter(16n);
  assert.equal(p.base(1, 2), null, 'r1 must be killed upon entering target 16n');
}

console.log('issue #6225 address-provenance entryKills union regressions PASS');

import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import { parseClassicBindings } from '../../js/binary/macho-dyld.js';
import { createMachOMetadataBudget } from '../../js/binary/macho-budget.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

function reader(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const leb = (p, end) => {
    let value = 0n;
    let shift = 0n;
    const start = p;
    while (p < end && p - start < 10) {
      const b = bytes[p++];
      value |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return { value, next:p };
      shift += 7n;
    }
    throw new Error('truncated uleb');
  };
  return {
    length:bytes.length,
    bytes,
    u8:(offset) => view.getUint8(offset),
    u64:(offset) => view.getBigUint64(offset, true),
    uleb:(p, _max, end) => leb(p, end),
    sleb:(p, _max, end) => leb(p, end),
    slice:(p, size) => bytes.slice(p, p + size),
  };
}

function image() {
  return {
    bits:64,
    metadata:{},
    warnings:[],
    imports:[],
    libraries:['libA.dylib'],
    addressToOffset(address) { return address >= 0x1000n && address < 0x1100n ? address - 0x1000n : null; },
  };
}

const segment = { address:0x1000n, size:0x100n };

// SET_SYMBOL "ab"; SET_SEGMENT 0; THREADED_SET_BIND_ORDINAL_TABLE_SIZE(1);
// DO_BIND (records template); THREADED_APPLY; DONE. The pointer at offset 0
// encodes bind ordinal 0 with a terminating delta.
function threadedStream() {
  const bytes = Uint8Array.from([
    0x40, 0x61, 0x62, 0x00,
    0x70, 0x00,
    0xd0, 0x01,
    0x90,
    0xd1,
    0x00,
  ]);
  return bytes;
}

test('threaded output cannot retain a name past stringBytes budget', () => {
  const target = image();
  // The decoder and ordinal-table template each fit, but retaining the threaded
  // output name must exceed this limit.
  const budget = createMachOMetadataBudget(target, { limits:{
    stringBytes:9, inputBytes:1024, records:100, objects:100, operations:100,
    warnings:100, estimatedHeapBytes:1024 * 1024, wallClockMs:1000,
  } });
  const stream = threadedStream();
  const status = parseClassicBindings(reader(stream), { offset:0, size:stream.length }, target, [segment], 'bind', budget);
  assert.equal(status.complete, false);
  assert.equal(target.imports.length, 0);
});

test('repeat bind stops after the first output-budget failure', () => {
  const target = image();
  const budget = createMachOMetadataBudget(target, { limits:{
    stringBytes:9, inputBytes:1024, records:100, objects:100, operations:1000,
    warnings:100, estimatedHeapBytes:1024 * 1024, wallClockMs:1000,
  } });
  // SET_SYMBOL "ab"; SET_SEGMENT; DO_BIND_ULEB_TIMES_SKIPPING_ULEB repeat=20 step=0; DONE.
  const stream = Uint8Array.from([0x40,0x61,0x62,0x00,0x70,0x00,0xc0,0x14,0x00,0x00]);
  const status = parseClassicBindings(reader(stream), { offset:0, size:stream.length }, target, [segment], 'bind', budget);
  assert.equal(status.complete, false);
  assert.ok(target.warnings.length <= 2, `budget failure generated ${target.warnings.length} warnings`);
  assert.ok(target.imports.length <= 1, 'repeat loop continued after the retained-name budget failed');
});

class StorageMock {
  constructor() { this.map = new Map(); this.throwKey = null; }
  get length() { return this.map.size; }
  key(index) { return [...this.map.keys()][index] ?? null; }
  getItem(key) { if (key === this.throwKey) throw new Error('storage fault'); return this.map.get(String(key)) ?? null; }
  setItem(key, value) { this.map.set(String(key), String(value)); }
  removeItem(key) { this.map.delete(String(key)); }
}

test('NoteStore refuses compaction after an incomplete delta scan and validates schema', async () => {
  const storage = new StorageMock();
  globalThis.localStorage = storage;
  const prefix = 'hex.notes.review6372';
  storage.setItem(prefix, JSON.stringify({ v:2, names:{ '1':'base' }, comments:{}, vars:{}, types:{}, structs:[] }));
  const unreadable = `${prefix}.delta.00-unreadable`;
  storage.setItem(unreadable, 'opaque');
  storage.setItem(`${prefix}.delta.01-invalid-delete`, JSON.stringify({ kind:'names', key:'1', deleted:'false', value:'poison' }));
  storage.throwKey = unreadable;

  const { NoteStore } = await import('../../js/names.js');
  const notes = new NoteStore('review6372');
  assert.equal(notes.nameOf(1n), 'base', 'invalid deleted type mutated the map');
  assert.equal(notes._deltaLoadComplete, false);
  assert.equal(notes.save(), false);
  assert.equal(notes.lastSaveError?.code, 'DELTA_LOAD_INCOMPLETE');
  assert.equal(storage.getItem(unreadable), null, 'mock read remains unavailable');
  assert.equal(storage.map.has(unreadable), true, 'incomplete scan allowed stale delta cleanup');

  storage.throwKey = null;
  notes._loadDeltas();
  assert.equal(notes._deltaLoadComplete, true);
  assert.equal(notes.save(), true);
  assert.equal(storage.map.has(unreadable), false);
});

console.log('review-6372-unresolved-findings: PASS');

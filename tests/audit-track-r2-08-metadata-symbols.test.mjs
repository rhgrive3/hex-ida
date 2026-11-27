import assert from 'node:assert/strict';
import test from 'node:test';

import { parseMetadata, parseMetadataAutoAsync } from '../js/il2cpp.js';
import { buildObjcModel, pagedReader, sanitizePointer } from '../js/objc-legacy.js';
import { readSwiftMangledName } from '../js/swift.js';
import { NoteStore } from '../js/names.js';
import { SymbolIndex } from '../js/symbols.js';
import { readVtable } from '../js/rtti.js';

const IL2CPP_WORKER_URL = new URL('../js/il2cpp-worker.js', import.meta.url);

// ============================================================================
// [P1-1] js/il2cpp.js: parseLiterals / parseLiteralsAsync heap budget
// ============================================================================
function buildIl2CppLiteralFixture({ literalCount, literalBytes, version = 33 }) {
  const enc = new TextEncoder();
  const strTable = enc.encode('MyClass\0MyMethod\0');
  const typeSize = 92;
  const methodSize = 40;
  const literalData = new Uint8Array(literalBytes);
  literalData.fill(0x41); // 'A'

  const align8 = (n) => (n + 7) & ~7;
  const stringOffset = 256;
  const typeDefOffset = align8(stringOffset + strTable.length);
  const methodOffset = align8(typeDefOffset + typeSize);
  const litIndexOffset = align8(methodOffset + methodSize);
  const litIndexSize = literalCount * 8;
  const litDataOffset = align8(litIndexOffset + litIndexSize);
  const total = align8(litDataOffset + literalData.length + 16);

  const buf = new Uint8Array(total);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, 0xfab11baf, true);
  dv.setInt32(4, version, true);

  // PAIR indices: stringLiteral=0, stringLiteralData=1, string=2, methods=5, typeDefinitions=19
  const setPair = (pairIdx, off, size) => {
    dv.setInt32(8 + pairIdx * 8, off, true);
    dv.setInt32(8 + pairIdx * 8 + 4, size, true);
  };
  setPair(0, litIndexOffset, litIndexSize);
  setPair(1, litDataOffset, literalData.length);
  setPair(2, stringOffset, strTable.length);
  setPair(5, methodOffset, methodSize);
  setPair(19, typeDefOffset, typeSize);

  buf.set(strTable, stringOffset);
  dv.setInt32(typeDefOffset, 0, true);      // name = "MyClass"
  dv.setInt32(typeDefOffset + 4, -1, true); // namespace = none
  dv.setInt32(methodOffset, 8, true);       // name = "MyMethod"
  dv.setInt32(methodOffset + 4, 0, true);   // owner = 0

  buf.set(literalData, litDataOffset);
  for (let i = 0; i < literalCount; i++) {
    const o = litIndexOffset + i * 8;
    dv.setInt32(o, literalBytes, true); // len
    dv.setInt32(o + 4, 0, true);        // off (aliased to offset 0)
  }
  return buf;
}

test('[P1-1] il2cpp parseLiterals charges expanded string heap and enforces 96 MiB budget (sync & async)', async () => {
  // 2,000 aliased references to one 64 KiB literal => ~128 MiB raw / ~256 MiB UTF-16 > 96 MiB default budget
  const bomb = buildIl2CppLiteralFixture({ literalCount: 2000, literalBytes: 65536 });
  assert.ok(bomb.byteLength < 100_000, 'fixture input itself stays tiny (<100 KiB)');

  assert.throws(
    () => parseMetadata(bomb),
    (err) => err?.code === 'IL2CPP_METADATA_BUDGET',
    'sync parseMetadata must abort with IL2CPP_METADATA_BUDGET instead of OOMing on aliased literals',
  );
  await assert.rejects(
    () => parseMetadataAutoAsync(bomb),
    (err) => err?.code === 'IL2CPP_METADATA_BUDGET',
    'async parseMetadataAutoAsync must abort with IL2CPP_METADATA_BUDGET on aliased literals',
  );

  // Small legitimate literal table still parses cleanly and accounts for string heap
  const small = buildIl2CppLiteralFixture({ literalCount: 4, literalBytes: 16 });
  const meta = parseMetadata(small);
  assert.equal(meta.literals.length, 4);
  assert.equal(meta.literals[0].text, 'A'.repeat(16));
  assert.ok(meta.parseBudget.estimatedHeapBytes >= 4 * 16 * 2);
});

// ============================================================================
// [P1-2] js/objc-legacy.js: pagedReader.get rejects negative addresses
// ============================================================================
test('[P1-2] objc pagedReader.get rejects negative addresses instead of slicing page tail', async () => {
  const pageBytes = 64;
  const page0 = new Uint8Array(pageBytes);
  page0.fill(0x11);
  // Put a recognizable sentinel at the tail of page 0
  page0.set([0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe, 0xba, 0xbe], pageBytes - 10);

  let readCalls = 0;
  const get = pagedReader(async (addr, len) => {
    readCalls++;
    if (addr === 0n) return page0.subarray(0, Math.min(pageBytes, len));
    return null;
  }, pageBytes, 8);

  // Prime page 0 into cache
  const head = await get(0n, 4);
  assert.deepEqual(Array.from(head), [0x11, 0x11, 0x11, 0x11]);
  assert.equal(readCalls, 1);

  // Negative addresses must return null rather than buf.subarray(-10, -2)
  assert.equal(await get(-10n, 8), null);
  assert.equal(await get(-1n, 1), null);
  assert.equal(await get(-10, 8), null);
  assert.equal(readCalls, 1, 'negative address must be rejected before hitting underlying read');
});

// ============================================================================
// [P1-3] js/swift.js: absolute symbolic reference (0x18..0x1f) pointer address
// ============================================================================
test('[P1-3] swift readSwiftMangledName passes pointer payload address (tag + 1) to pointerResolver', async () => {
  const base = 0x2000n;
  const prefix = '4Main';
  const mem = new Uint8Array(0x100);
  for (let i = 0; i < prefix.length; i++) mem[i] = prefix.charCodeAt(i);
  const tagOff = prefix.length; // 5
  mem[tagOff] = 0x18;           // absolute symbolic reference
  const dv = new DataView(mem.buffer);
  const encodedPtr = 0x8010000000005678n;
  dv.setBigUint64(tagOff + 1, encodedPtr, true);
  mem[tagOff + 9] = 'V'.charCodeAt(0);
  mem[tagOff + 10] = 0;

  const expectedTagAddr = base + BigInt(tagOff);
  const expectedPtrAddr = base + BigInt(tagOff + 1);
  const chainedFixupTable = new Map([[expectedPtrAddr.toString(), 0x100009000n]]);

  const seenCalls = [];
  const info = await readSwiftMangledName(
    async (addr, len) => {
      const off = Number(addr - base);
      if (off < 0 || off >= mem.length) return null;
      return mem.subarray(off, Math.min(mem.length, off + len));
    },
    base,
    {
      compilerMetadata: true,
      resolvePointer(raw, ctx) {
        seenCalls.push({ raw, ctx });
        return chainedFixupTable.get(ctx.address.toString()) ?? null;
      },
    },
  );

  assert.equal(info.complete, true);
  assert.equal(seenCalls.length, 1);
  assert.equal(seenCalls[0].raw, encodedPtr);
  assert.equal(seenCalls[0].ctx.address, expectedPtrAddr, 'pointerResolver must receive pointer payload address (tag + 1)');
  assert.equal(seenCalls[0].ctx.swiftSymbolicReferenceKind, 0x18);
  assert.equal(info.symbolicReferences[0].address, expectedTagAddr);
  assert.equal(info.symbolicReferences[0].resolvedTarget, 0x100009000n);
  assert.equal(info.referencesResolved, true);
});

// ============================================================================
// [P1-4] js/objc-legacy.js: instance baseProperties propagates completeness
// ============================================================================
function buildObjcPropertyFixture({ propsPtr, propCount = 0 }) {
  const base = 0x100000000n;
  const mem = new Uint8Array(0x1000);
  const dv = new DataView(mem.buffer);
  const writeCstr = (off, s) => {
    for (let i = 0; i < s.length; i++) mem[off + i] = s.charCodeAt(i);
    mem[off + s.length] = 0;
    return base + BigInt(off);
  };

  const classListOff = 0x100;
  const classOff = 0x200;
  const roOff = 0x300;
  const namePtr = writeCstr(0x400, 'MyObjcClass');

  // __objc_classlist: 1 entry pointing to class_t
  dv.setBigUint64(classListOff, base + BigInt(classOff), true);

  // class_t (40 bytes): isa=0, super=0, data=roAddr at offset 32
  dv.setBigUint64(classOff + 32, base + BigInt(roOff), true);

  // class_ro_t (72 bytes): instanceSize=16 at +8, name at +24, baseProperties at +64
  dv.setUint32(roOff + 8, 16, true);
  dv.setBigUint64(roOff + 24, namePtr, true);
  dv.setBigUint64(roOff + 64, propsPtr, true);

  if (propsPtr >= base && propsPtr < base + BigInt(mem.length)) {
    const pOff = Number(propsPtr - base);
    dv.setUint32(pOff, 16, true);        // entsize = 16
    dv.setUint32(pOff + 4, propCount, true);
    if (propCount === 1) {
      const pName = writeCstr(0x600, 'hp');
      const pAttr = writeCstr(0x620, 'Ti,N,V_hp');
      dv.setBigUint64(pOff + 8, pName, true);
      dv.setBigUint64(pOff + 16, pAttr, true);
    }
  }

  const read = async (addr, len) => {
    if (addr < base) return null;
    const off = Number(addr - base);
    if (off < 0 || off >= mem.length) return null;
    return mem.subarray(off, Math.min(mem.length, off + len));
  };
  return { read, classList: { vmAddr: base + BigInt(classListOff), size: 8n }, base };
}

test('[P1-4] objc buildObjcModel propagates completeness for instance baseProperties failures and caps', async () => {
  // Unreadable baseProperties pointer
  const unreadable = buildObjcPropertyFixture({ propsPtr: 0x100009000n });
  const m1 = await buildObjcModel(unreadable.read, unreadable.classList, null, unreadable.base);
  assert.equal(m1.classes.length, 1);
  assert.equal(m1.completeness.complete, false, 'unreadable instance baseProperties must mark completeness false');
  assert.ok(m1.completeness.classes.invalidProperties >= 1);
  assert.ok(m1.completeness.classes.reasons.includes('property-list-unreadable'));

  // Capped baseProperties (count > MAX_PROPS = 400)
  const capped = buildObjcPropertyFixture({ propsPtr: 0x100000500n, propCount: 401 });
  const m2 = await buildObjcModel(capped.read, capped.classList, null, capped.base);
  assert.equal(m2.completeness.complete, false, 'capped instance baseProperties must mark completeness false');
  assert.ok(m2.completeness.classes.invalidProperties >= 1);
  assert.ok(m2.completeness.classes.reasons.includes('property-list-capped'));

  // Valid baseProperties remains complete
  const valid = buildObjcPropertyFixture({ propsPtr: 0x100000500n, propCount: 1 });
  const m3 = await buildObjcModel(valid.read, valid.classList, null, valid.base);
  assert.equal(m3.completeness.complete, true);
  assert.equal(m3.classes[0].properties.length, 1);
  assert.equal(m3.classes[0].properties[0].name, 'hp');
});

// ============================================================================
// [P2-5] & [P2-6] js/names.js: clear() DELTA_SCAN_INCOMPLETE & legacy early return
// ============================================================================
function withMockLocalStorage(fn) {
  const map = new Map();
  const failReadKeys = new Set();
  const storage = {
    map,
    failReadKeys,
    get length() { return map.size; },
    key(i) { return [...map.keys()][i] ?? null; },
    getItem(k) {
      if (failReadKeys.has(k)) throw new Error('simulated read failure');
      return map.get(k) ?? null;
    },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
    clear() { map.clear(); },
  };
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: storage });
  try {
    return fn(storage);
  } finally {
    if (desc) Object.defineProperty(globalThis, 'localStorage', desc);
    else delete globalThis.localStorage;
  }
}

test('[P2-5] NoteStore.clear() resets DELTA_SCAN_INCOMPLETE so subsequent saves succeed', () => {
  withMockLocalStorage((storage) => {
    const id = 'clear-resets-scan-incomplete';
    const seed = new NoteStore(id);
    assert.equal(seed.setName(0x1000n, 'initial'), true);
    assert.equal(seed.setComment(0x2000n, 'will-fail'), true);

    const deltaKey = [...storage.map.keys()].find((k) => k.includes('.delta.'));
    assert.ok(deltaKey);

    storage.failReadKeys.add(deltaKey);
    const store = new NoteStore(id);
    assert.equal(store._deltaScanComplete, false);
    assert.equal(store.save(), false);
    assert.equal(store.lastSaveError?.code, 'DELTA_SCAN_INCOMPLETE');

    // clear() writes a new-generation tombstone and must clear the stale scan-incomplete state
    storage.failReadKeys.clear();
    assert.equal(store.clear(), true);
    assert.equal(store._deltaScanComplete, true);
    assert.equal(store._unreadableDeltaKeys.size, 0);
    assert.equal(store.lastSaveError, null);

    // Subsequent edits and full saves must succeed cleanly
    assert.equal(store.setName(0x3000n, 'fresh_after_clear'), true);
    assert.equal(store.save(), true);
    assert.equal(store.lastSaveError, null);
    assert.equal(new NoteStore(id).nameOf(0x3000n), 'fresh_after_clear');
  });
});

test('[P2-6] NoteStore.load() continues checking later legacyIds when an earlier legacy entry is corrupt JSON', () => {
  withMockLocalStorage((storage) => {
    storage.setItem('hex.notes.legacy-corrupt', '{not valid json');
    storage.setItem('hex.notes.legacy-valid', JSON.stringify({
      v: 1,
      names: { '4096': 'recovered_legacy_fn' },
    }));

    const store = new NoteStore('current-id', ['legacy-corrupt', 'legacy-valid']);
    assert.equal(store.legacyCandidate?.sourceId, 'legacy-valid');
    assert.equal(store.importLegacyCandidate(), true);
    assert.equal(store.nameOf(0x1000n), 'recovered_legacy_fn');
  });
});

// ============================================================================
// [P2-7] & [P2-8] js/symbols.js: 64-bit wraparound & nextFunctionStart boundary
// ============================================================================
test('[P2-7] SymbolIndex.canonicalizeFunctionStarts rejects negative and >= 2^64 addresses instead of wrapping', () => {
  assert.throws(
    () => SymbolIndex.canonicalizeFunctionStarts([-1n]),
    /symbol-function-start-transport-invalid/,
  );
  assert.throws(
    () => SymbolIndex.canonicalizeFunctionStarts([1n << 64n]),
    /symbol-function-start-transport-invalid/,
  );
  assert.throws(
    () => SymbolIndex.canonicalizeFunctionStarts(['0x10000000000000000']),
    /symbol-function-start-transport-invalid/,
  );
  assert.throws(
    () => new SymbolIndex({ funcs: [(1n << 64n) + 0x1000n] }),
    /symbol-function-start-transport-invalid/,
  );

  // Exact uint64 bounds remain valid
  const idx = new SymbolIndex({ funcs: [0n, 0xffffffffffffffffn] });
  assert.equal(idx.funcs[0], 0n);
  assert.equal(idx.funcs[1], 0xffffffffffffffffn);
});

test('[P2-8] SymbolIndex.nextFunctionStart handles pre-first-start and cross-region boundaries accurately', () => {
  // Inside executable region, before first known function start => returns funcs[0]
  const singleRegion = [{ id: 'text', vmAddr: 0x1000n, size: 0x2000n, exec: true }];
  const s1 = new SymbolIndex({ funcs: new BigUint64Array([0x1100n, 0x1200n]), regions: singleRegion });
  assert.equal(s1.nextFunctionStart(0x1000n), 0x1100n, 'in-region address before first start finds funcs[0]');
  assert.equal(s1.nextFunctionStart(0x500n), null, 'out-of-region address returns null');
  assert.equal(s1.nextFunctionStart(0x1100n), 0x1200n);
  assert.equal(s1.nextFunctionStart(0x1200n), null);

  // Regionless index before first known start => returns funcs[0]
  const sRegionless = new SymbolIndex({ funcs: new BigUint64Array([0x1100n, 0x1200n]) });
  assert.equal(sRegionless.nextFunctionStart(0x1000n), 0x1100n);

  // Cross-region gap: next start in a different executable region must not be returned
  const splitRegions = [
    { id: 'text-a', vmAddr: 0x1000n, size: 0x100n, exec: true },
    { id: 'text-b', vmAddr: 0x5000n, size: 0x100n, exec: true },
  ];
  const sSplit = new SymbolIndex({ funcs: new BigUint64Array([0x1000n, 0x5000n]), regions: splitRegions });
  assert.equal(sSplit.nextFunctionStart(0x1000n), null, 'must not cross executable-region gap');
});

// ============================================================================
// [P2-9] js/rtti.js: slotCount: null must not coerce to 0
// ============================================================================
test('[P2-9] rtti readVtable treats slotCount: null as omitted rather than 0', async () => {
  const buf = new Uint8Array(5 * 8);
  const dv = new DataView(buf.buffer);
  dv.setBigInt64(0, 0n, true);          // offsetToTop
  dv.setBigUint64(8, 0x2000n, true);    // typeinfo
  dv.setBigUint64(16, 0x4000n, true);   // slot 0
  dv.setBigUint64(24, 0x4010n, true);   // slot 1
  dv.setBigUint64(32, 0x4020n, true);   // slot 2

  const read = async (_addr, len) => buf.subarray(0, Math.min(buf.length, len));
  const isExecutable = (a) => a >= 0x4000n && a < 0x5000n;

  const withNull = await readVtable(read, 0x1000n, null, 64, { slotCount: null, isExecutable });
  assert.equal(withNull.slots.length, 3, 'slotCount: null must fall back to maxSlots');

  const withZero = await readVtable(read, 0x1000n, null, 64, { slotCount: 0, isExecutable });
  assert.equal(withZero.slots.length, 0, 'explicit slotCount: 0 must remain exact 0-slot mode');
});

// ============================================================================
// [P2-10] js/objc-legacy.js: sanitizePointer BigInt + Number crash
// ============================================================================
test('[P2-10] objc sanitizePointer handles Number imageBase without BigInt + Number TypeError', () => {
  // Encoded pointer with high bits set (v >= 0x0001000000000000n), bind bit clear, low < base
  const rawOffsetPtr = 0x0010000000001234n;
  const resolved = sanitizePointer(rawOffsetPtr, 0x100000000);
  assert.equal(resolved, 0x100001234n);

  // Bind bit set with Number base
  const rawBindPtr = 0x8010000000001234n;
  assert.equal(sanitizePointer(rawBindPtr, 0x100000000), null);
});

// ============================================================================
// [P2-11] js/il2cpp-worker.js: maxInputBytes propagates to parseMetadataAutoAsync
// ============================================================================
test('[P2-11] il2cpp-worker propagates maxInputBytes to parseMetadataAutoAsync when file.size is absent', async () => {
  const posts = [];
  const priorSelf = globalThis.self;
  const scope = { postMessage: (msg) => posts.push(msg) };
  globalThis.self = scope;
  try {
    await import(`${IL2CPP_WORKER_URL.href}?r2-08=${Math.random()}`);
    // File without declared .size/.byteLength whose materialized buffer exceeds maxInputBytes (64)
    const file = {
      async arrayBuffer() { return new ArrayBuffer(256); },
    };
    await scope.onmessage({ data: { t: 'parse', id: 42, file, maxInputBytes: 64 } });
    const reply = posts.at(-1);
    assert.equal(reply.id, 42);
    assert.equal(reply.ok, false);
    assert.equal(reply.error.code, 'IL2CPP_METADATA_BUDGET');
  } finally {
    if (priorSelf === undefined) delete globalThis.self;
    else globalThis.self = priorSelf;
  }
});

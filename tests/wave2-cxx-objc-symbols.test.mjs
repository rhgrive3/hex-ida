import test from 'node:test';
import assert from 'node:assert/strict';

import { ObjcMetadataProvider } from '../js/metadata/objc.js';
import {
  STL_CONTAINER_KIND,
  createStlPatternRecognizer,
} from '../js/analysis/cxx/stl-pattern-recognizer.js';
import {
  buildCxxClassEvidence,
  parseItaniumTypeInfo,
} from '../js/analysis/cxx/rtti-evidence.js';
import { SymbolIndex, SYM_DEFINED } from '../js/symbols.js';

// ── 1. js/metadata/objc.js: runtimeIndex shape validation & reuse ──

test('objc: reuses prebuilt model.runtimeIndex when shape is valid (no duplicate buildObjcRuntimeIndex)', async () => {
  const provider = new ObjcMetadataProvider({
    sections: [{ name: '__objc_classlist', vmAddr: 0x1000n, size: 0n }],
    readAt: async () => new Uint8Array(0),
    architecture: 'arm64',
    platform: 'ios',
  });
  await provider.probe();
  assert.ok(provider.cachedModel, 'model should be parsed');
  assert.ok(provider.cachedModel.runtimeIndex, 'buildObjcRuntimeModel should populate runtimeIndex');
  assert.equal(provider.cachedModel.runtimeIndex.runtime, 'objc');
  assert.ok(provider.cachedModel.runtimeIndex.methodsBySelector);
  assert.equal(
    provider.cachedIndex,
    provider.cachedModel.runtimeIndex,
    'ObjcMetadataProvider.probe() must reuse valid model.runtimeIndex without rebuilding',
  );
});

// ── 2. js/analysis/cxx/stl-pattern-recognizer.js ──

test('stl-pattern-recognizer: MAP_TREE and UNORDERED_MAP do not double-count access idioms or false-positive on generic 3-ptr structs', () => {
  const rec = createStlPatternRecognizer(32);

  // Generic 3-pointer struct (like std::vector without vector idiom) must NOT match MAP_TREE or UNORDERED_MAP
  const generic3Ptr = rec.recognize('fn_generic_3ptr', {
    structSize: 24,
    fields: [{ offset: 0, size: 8 }, { offset: 8, size: 8 }, { offset: 16, size: 8 }],
    accessPatterns: [],
    symbols: [],
  });
  assert.equal(generic3Ptr.recognized, false, 'generic 3-ptr struct with no idioms/symbols must not match');

  // MAP_TREE with totalSize === 0 + rb_tree_walk -> 2 independent pieces (layout_rb_tree_node + tree_traversal_idiom)
  const mapNoSize = rec.recognize('fn_map_nosize', {
    fields: [{ offset: 0, size: 8 }, { offset: 8, size: 8 }, { offset: 16, size: 8 }],
    accessPatterns: ['rb_tree_walk'],
  });
  assert.equal(mapNoSize.recognized, true);
  assert.equal(mapNoSize.primary.kind, STL_CONTAINER_KIND.MAP_TREE);
  assert.deepEqual(mapNoSize.primary.evidence, ['layout_rb_tree_node', 'tree_traversal_idiom']);

  // MAP_TREE with rb_tree_walk alone (no 3-ptr layout, no symbol) -> only 1 evidence, must NOT match
  const mapOnlyWalk = rec.recognize('fn_map_walk_only', {
    fields: [{ offset: 0, size: 8 }],
    accessPatterns: ['rb_tree_walk'],
  });
  assert.equal(mapOnlyWalk.recognized, false);

  // UNORDERED_MAP with totalSize === 0 + hash_mod_bucket_count -> 2 independent pieces
  const umapNoSize = rec.recognize('fn_umap_nosize', {
    fields: [{ offset: 0, size: 8 }, { offset: 8, size: 8 }],
    accessPatterns: ['hash_mod_bucket_count'],
  });
  assert.equal(umapNoSize.recognized, true);
  assert.equal(umapNoSize.primary.kind, STL_CONTAINER_KIND.UNORDERED_MAP);
  assert.deepEqual(umapNoSize.primary.evidence, ['layout_hash_bucket_table', 'bucket_modulo_lookup']);

  // UNORDERED_MAP with hash_mod_bucket_count alone (no layout, no symbol) -> must NOT match
  const umapOnlyMod = rec.recognize('fn_umap_mod_only', {
    fields: [],
    accessPatterns: ['hash_mod_bucket_count'],
  });
  assert.equal(umapOnlyMod.recognized, false);
});

test('stl-pattern-recognizer: UNIQUE_PTR recognition (including totalSize === 0) and binaryKey cache isolation', () => {
  const rec = createStlPatternRecognizer(32);

  // UNIQUE_PTR with explicit structSize === ptrSize + deleter idiom
  const uptrExact = rec.recognize('fn_uptr', {
    binaryKey: 'binA',
    structSize: 8,
    fields: [{ offset: 0, size: 8 }],
    accessPatterns: ['unique_ptr_deleter_call'],
  });
  assert.equal(uptrExact.recognized, true);
  assert.equal(uptrExact.primary.kind, STL_CONTAINER_KIND.UNIQUE_PTR);
  assert.deepEqual(uptrExact.primary.evidence, ['layout_unique_ptr_single', 'unique_ptr_deleter_idiom']);
  assert.equal(uptrExact.primary.pathA1Overlay.methodHint, 'uptr.get()');
  assert.equal(uptrExact.primary.pathBC11Struct, 'struct hex_std_unique_ptr { void* ptr; };');

  // UNIQUE_PTR with totalSize === 0 + symbol_unique_ptr
  const uptrNoSize = rec.recognize('fn_uptr_nosize', {
    fields: [{ offset: 0, size: 8 }],
    symbols: ['std::__1::unique_ptr<Foo, std::__1::default_delete<Foo>>'],
  });
  assert.equal(uptrNoSize.recognized, true);
  assert.equal(uptrNoSize.primary.kind, STL_CONTAINER_KIND.UNIQUE_PTR);
  assert.equal(uptrNoSize.primary.abiFamily, 'libc++');

  // Same funcKey under a different binaryKey must NOT collide with binA cache entry
  const uptrBinB = rec.recognize('fn_uptr', {
    binaryKey: 'binB',
    structSize: 24,
    fields: [{ offset: 0, size: 8 }, { offset: 8, size: 8 }, { offset: 16, size: 8 }],
    accessPatterns: ['end_eq_cap_grow'],
  });
  assert.equal(uptrBinB.recognized, true);
  assert.equal(uptrBinB.primary.kind, STL_CONTAINER_KIND.VECTOR);
  assert.equal(uptrBinB.funcKey, 'binB:fn_uptr');

  // Without binaryKey, funcKey remains backward-compatible plain string
  assert.equal(uptrNoSize.funcKey, 'fn_uptr_nosize');
});

// ── 3. js/analysis/cxx/rtti-evidence.js: resolvePointer across vtable & typeinfo ──

function makeMemoryReader(segments) {
  return async (address, length) => {
    for (const seg of segments) {
      const segEnd = seg.base + BigInt(seg.bytes.length);
      if (address >= seg.base && address < segEnd) {
        const off = Number(address - seg.base);
        const end = Math.min(seg.bytes.length, off + length);
        return seg.bytes.subarray(off, end);
      }
    }
    return null;
  };
}

function u64Words(...words) {
  const buf = new Uint8Array(words.length * 8);
  const dv = new DataView(buf.buffer);
  words.forEach((w, i) => dv.setBigUint64(i * 8, BigInt.asUintN(64, w), true));
  return buf;
}

test('rtti-evidence: resolvePointer decodes PAC/fixup vtable slots, typeinfo pointer, type_info internals (vptr/name/base), aliases, _ZTI stop, negative offset-to-top stop, and fail-closed on throw', async () => {
  const PAC_TAG = 0x9abc000000000000n; // bit 63 set (looks negative as signed i64!)
  const VTABLE_ADDR = 0x10000n;
  const TYPEINFO_ADDR = 0x20000n;
  const BASE_TYPEINFO_ADDR = 0x21000n;
  const ABI_SI_VTABLE = 0x30000n;
  const NAME_ADDR = 0x40000n;
  const METHOD_0 = 0x50000n;
  const METHOD_1 = 0x50040n;
  const SECONDARY_TYPEINFO = 0x22000n;

  // Vtable layout: [offsetToTop=0, encoded(TYPEINFO_ADDR), encoded(METHOD_0), encoded(METHOD_1), -0x18n (secondary offset-to-top), encoded(SECONDARY_TYPEINFO)]
  const vtableBytes = u64Words(
    0n,
    PAC_TAG | TYPEINFO_ADDR,
    PAC_TAG | METHOD_0,
    PAC_TAG | METHOD_1,
    -0x18n,
    PAC_TAG | SECONDARY_TYPEINFO,
  );

  // __si_class_type_info: [encoded(ABI_SI_VTABLE), encoded(NAME_ADDR), encoded(BASE_TYPEINFO_ADDR)]
  const typeinfoBytes = u64Words(
    PAC_TAG | ABI_SI_VTABLE,
    PAC_TAG | NAME_ADDR,
    PAC_TAG | BASE_TYPEINFO_ADDR,
  );

  const nameBytes = new TextEncoder().encode('6Player\0');

  const read = makeMemoryReader([
    { base: VTABLE_ADDR, bytes: vtableBytes },
    { base: TYPEINFO_ADDR, bytes: typeinfoBytes },
    { base: NAME_ADDR, bytes: nameBytes },
  ]);

  const symbols = {
    addrs: [VTABLE_ADDR, METHOD_0, METHOD_1, ABI_SI_VTABLE, SECONDARY_TYPEINFO],
    names: [
      '__ZTV6Player',
      '__ZN6Player4tickEv',
      '__ZN6Player4drawEv',
      '__ZTVN10__cxxabiv120__si_class_type_infoE',
      '__ZTI9Component',
    ],
    nameAt(a) {
      const idx = this.addrs.indexOf(a);
      return idx >= 0 ? this.names[idx] : null;
    },
  };

  // Fixup-backed resolver: knows exact slot virtual addresses that carry PAC/fixups
  const fixupMap = new Map([
    [(VTABLE_ADDR + 8n).toString(), TYPEINFO_ADDR],
    [(VTABLE_ADDR + 16n).toString(), METHOD_0],
    [(VTABLE_ADDR + 24n).toString(), METHOD_1],
    [(TYPEINFO_ADDR + 0n).toString(), ABI_SI_VTABLE],
    [(TYPEINFO_ADDR + 8n).toString(), NAME_ADDR],
    [(TYPEINFO_ADDR + 16n).toString(), BASE_TYPEINFO_ADDR],
  ]);

  const observedCtx = [];
  const ev = await buildCxxClassEvidence({
    symbols,
    read,
    pointerBytes: 8,
    maxSlots: 8,
    symbolSizeOf: (a) => (a === VTABLE_ADDR ? BigInt(vtableBytes.length) : null),
    resolvePointer: (raw, ctx) => {
      observedCtx.push({ raw, ...ctx });
      return fixupMap.get(ctx.address.toString()) ?? null;
    },
  });

  assert.equal(ev.classes.length, 1);
  const cls = ev.classes[0];
  assert.equal(cls.className, 'Player');
  assert.equal(cls.typeinfoAddress, TYPEINFO_ADDR);
  assert.equal(cls.typeinfoRaw, PAC_TAG | TYPEINFO_ADDR);
  assert.equal(cls.typeinfoKind, '__si_class_type_info');
  assert.equal(cls.baseEvidence, 'si-base-pointer');
  assert.equal(cls.bases.length, 1);
  assert.equal(cls.bases[0].typeinfoAddress, BASE_TYPEINFO_ADDR);

  // Slots 0 and 1 resolved with aliases; slot 2 (-0x18n) stopped as secondary sub-table
  assert.equal(cls.slots.length, 2);
  assert.equal(cls.slots[0].address, METHOD_0);
  assert.equal(cls.slots[0].unresolved, false);
  assert.deepEqual(cls.slots[0].aliases, ['__ZN6Player4tickEv']);
  assert.equal(cls.slots[1].address, METHOD_1);
  assert.deepEqual(cls.slots[1].aliases, ['__ZN6Player4drawEv']);
  assert.equal(cls.secondarySubTableAt, 2);

  // Verify ctx includes exact virtual address, vtableAddress, slotOffset, pointerBytes
  const slot0Ctx = observedCtx.find((c) => c.address === VTABLE_ADDR + 16n);
  assert.ok(slot0Ctx);
  assert.equal(slot0Ctx.vtableAddress, VTABLE_ADDR);
  assert.equal(slot0Ctx.slotOffset, 16);
  assert.equal(slot0Ctx.pointerBytes, 8);

  // Also test _ZTI termination when a resolved slot alias is a typeinfo symbol (e.g. offset-to-top = 0n)
  const vtableZtiBytes = u64Words(
    0n,
    TYPEINFO_ADDR,
    PAC_TAG | METHOD_0,
    0n, // non-negative offset-to-top for secondary sub-table
    PAC_TAG | SECONDARY_TYPEINFO,
  );
  const evZti = await buildCxxClassEvidence({
    symbols,
    read: makeMemoryReader([
      { base: VTABLE_ADDR, bytes: vtableZtiBytes },
      { base: TYPEINFO_ADDR, bytes: typeinfoBytes },
      { base: NAME_ADDR, bytes: nameBytes },
    ]),
    pointerBytes: 8,
    maxSlots: 8,
    symbolSizeOf: (a) => (a === VTABLE_ADDR ? BigInt(vtableZtiBytes.length) : null),
    resolvePointer: (_raw, ctx) => {
      if (ctx.address === VTABLE_ADDR + 16n) return METHOD_0;
      if (ctx.address === VTABLE_ADDR + 32n) return SECONDARY_TYPEINFO;
      return fixupMap.get(ctx.address.toString()) ?? null;
    },
  });
  assert.equal(evZti.classes[0].slots.length, 1, '_ZTI alias on resolved slot must pop preceding offset-to-top and stop');
  assert.equal(evZti.classes[0].secondarySubTableAt, 1);

  // Throwing resolver must fail-closed
  const evThrow = await buildCxxClassEvidence({
    symbols,
    read,
    pointerBytes: 8,
    maxSlots: 8,
    symbolSizeOf: (a) => (a === VTABLE_ADDR ? BigInt(vtableBytes.length) : null),
    resolvePointer: () => { throw new Error('boom'); },
  });
  // Without resolution, slot 0 has bit 63 set -> treated as negative offset-to-top (fail-closed)
  assert.equal(evThrow.classes[0].slots.length, 0);
  assert.equal(evThrow.classes[0].typeinfoAddress, null);

  // Unencoded high-bit (bit 63 clear, > 48-bit limit) with Promise return must fail-closed as encoded-pointer-without-fixup-context
  const HIGH_TAG = 0x1234000000000000n;
  const badRetBytes = u64Words(0n, 0n, HIGH_TAG | METHOD_0);
  const evBadRet = await buildCxxClassEvidence({
    symbols,
    read: makeMemoryReader([{ base: VTABLE_ADDR, bytes: badRetBytes }]),
    pointerBytes: 8,
    maxSlots: 4,
    symbolSizeOf: (a) => (a === VTABLE_ADDR ? BigInt(badRetBytes.length) : null),
    resolvePointer: () => Promise.resolve(METHOD_0),
  });
  assert.equal(evBadRet.classes[0].slots.length, 1);
  assert.equal(evBadRet.classes[0].slots[0].unresolved, true);
  assert.equal(evBadRet.classes[0].slots[0].reason, 'encoded-pointer-without-fixup-context');
});

test('rtti-evidence: parseItaniumTypeInfo resolves __vmi_class_type_info vptr, namePointer, and base pointers', async () => {
  const PAC_TAG = 0x8001000000000000n;
  const TI = 0x20000n;
  const ABI_VMI = 0x31000n;
  const NAME = 0x41000n;
  const BASE0 = 0x22000n;
  const BASE1 = 0x23000n;

  const buf = new Uint8Array(16 + 8 + 32);
  const dv = new DataView(buf.buffer);
  dv.setBigUint64(0, PAC_TAG | ABI_VMI, true);
  dv.setBigUint64(8, PAC_TAG | NAME, true);
  dv.setUint32(16, 0, true); // flags
  dv.setUint32(20, 2, true); // base_count = 2
  dv.setBigUint64(24, PAC_TAG | BASE0, true);
  dv.setBigUint64(32, 2n, true); // public, offset 0
  dv.setBigUint64(40, PAC_TAG | BASE1, true);
  dv.setBigUint64(48, (0x18n << 8n) | 2n, true); // public, offset 0x18

  const fixups = new Map([
    [(TI + 0n).toString(), ABI_VMI],
    [(TI + 8n).toString(), NAME],
    [(TI + 24n).toString(), BASE0],
    [(TI + 40n).toString(), BASE1],
  ]);

  const parsed = await parseItaniumTypeInfo({
    read: makeMemoryReader([
      { base: TI, bytes: buf },
      { base: NAME, bytes: new TextEncoder().encode('5Enemy\0') },
    ]),
    symbols: {
      nameAt: (a) => (a === ABI_VMI ? '__ZTVN10__cxxabiv121__vmi_class_type_infoE' : null),
    },
    typeinfoAddress: TI,
    pointerBytes: 8,
    resolvePointer: (_raw, ctx) => fixups.get(ctx.address.toString()) ?? null,
  });

  assert.equal(parsed.className, 'Enemy');
  assert.equal(parsed.kind, '__vmi_class_type_info');
  assert.equal(parsed.baseEvidence, 'vmi-base-array');
  assert.equal(parsed.bases.length, 2);
  assert.equal(parsed.bases[0].typeinfoAddress, BASE0);
  assert.equal(parsed.bases[1].typeinfoAddress, BASE1);
  assert.equal(parsed.bases[1].offsetToTop, 0x18n);
});

// ── 4. js/symbols.js: frozen singleton provenance sharing & Map compatibility ──

test('symbols: default nameProvenance and functionProvenance share frozen singletons while keeping Map contract', () => {
  const symExact = new SymbolIndex({
    addrs: new BigUint64Array([0x1000n, 0x1040n]),
    kinds: new Uint8Array([SYM_DEFINED, SYM_DEFINED]),
    flags: new Uint8Array([0, 0]),
    names: ['_foo', '_bar'],
    funcs: new BigUint64Array([0x1000n, 0x1040n]),
    funcEnds: new BigUint64Array([0x1040n, 0x1080n]),
    functionStartsExact: true,
  });

  assert.equal(symExact.nameProvenance.size, 2);
  assert.equal(symExact.functionProvenance.size, 2);
  const n0 = symExact.nameProvenance.get(0x1000n.toString());
  const n1 = symExact.nameProvenance.get(0x1040n.toString());
  assert.equal(n0, n1, 'default nameProvenance entries should share one frozen singleton');
  assert.equal(Object.isFrozen(n0), true);
  assert.deepEqual(n0, { source: 'binary-symbol', confidence: 1, confirmed: true });

  const f0 = symExact.functionProvenance.get(0x1000n.toString());
  const f1 = symExact.functionProvenance.get(0x1040n.toString());
  assert.equal(f0, f1, 'default exact functionProvenance entries should share one frozen singleton');
  assert.equal(Object.isFrozen(f0), true);
  assert.deepEqual(f0, { source: 'function-starts', confidence: 1, confirmed: true });

  // Non-exact metadata fallback uses frozen metadata singleton; explicit provenance is cloned
  const customProv = { source: 'symtab', confidence: 0.99, confirmed: true };
  const symMeta = new SymbolIndex({
    addrs: new BigUint64Array([0x2000n, 0x2040n]),
    kinds: new Uint8Array([SYM_DEFINED, SYM_DEFINED]),
    flags: new Uint8Array([0, 0]),
    names: ['_a', '_b'],
    nameProvenance: [customProv, null],
    funcs: new BigUint64Array([0x2000n, 0x2040n]),
    funcEnds: new BigUint64Array([0x2040n, 0x2080n]),
    functionStartsExact: false,
  });

  const m0 = symMeta.functionProvenance.get(0x2000n.toString());
  const m1 = symMeta.functionProvenance.get(0x2040n.toString());
  assert.equal(m0, m1);
  assert.equal(Object.isFrozen(m0), true);
  assert.deepEqual(m0, { source: 'metadata', confidence: 0.7, confirmed: false });

  const c0 = symMeta.nameProvenance.get(0x2000n.toString());
  assert.notEqual(c0, customProv, 'explicitly provided provenance is defensively cloned');
  assert.deepEqual(c0, customProv);
  assert.equal(symMeta.nameProvenance.get(0x2040n.toString()), n0);
});

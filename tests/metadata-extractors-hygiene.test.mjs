import assert from 'node:assert/strict';
import test from 'node:test';
import { FieldIndex } from '../js/fields.js';
import { buildObjcRuntimeModel } from '../js/objc.js';
import {
  readSwiftMangledName,
  parseSwiftConformanceDescriptor,
  parseSwiftWitnessTable,
  buildSwiftMetadataModel,
  classifySwiftRuntimeCall,
} from '../js/swift.js';
import {
  demangleCxx,
  demangleSwift,
  readableName,
  shortName,
  findCxxClasses,
} from '../js/rtti.js';
import { bindMethodAddresses } from '../js/il2cpp.js';

/* ─────────────────────────── js/fields.js ─────────────────────────── */

test('fields: address key normalization handles hex, uppercase 0X, whitespace, bigint, and number', () => {
  const fields = new FieldIndex({
    classes: [{
      name: 'Player',
      instanceSize: 0x40,
      ivars: [{ name: '_hp', offset: 0x10, size: 4, offsetVar: ' 0x2000 ' }],
      methods: [{ addr: ' 0x1000 ', sel: 'hp', kind: '-' }],
    }],
  });

  for (const key of [0x1000n, 0x1000, '4096', ' 4096 ', '0x1000', '0X1000', ' 0x1000 ']) {
    assert.equal(fields.ownersOf(key).length, 1, `ownersOf(${String(key)})`);
    assert.equal(fields.ownerOf(key)?.className, 'Player');
  }

  for (const key of [0x2000n, 0x2000, '8192', ' 8192 ', '0x2000', '0X2000', ' 0x2000 ']) {
    assert.equal(fields.fieldAtOffsetVar(key)?.field?.name, '_hp', `fieldAtOffsetVar(${String(key)})`);
    assert.equal(fields.resolveAccess({ base: 'x0', indexAddr: key, self: true })?.name, '_hp');
  }
});

test('fields: resolveAccess falls back to declaredType when ivar type is missing or unknown', () => {
  const intType = { kind: 'int', bytes: 4, signed: true };
  const floatType = { kind: 'float', bytes: 4 };
  const fields = new FieldIndex({
    classes: [{
      name: 'Hero',
      instanceSize: 0x40,
      ivars: [
        { name: '_hp', offset: 0x10, size: 4, type: null, offsetVar: 0x3000n },
        { name: '_mp', offset: 0x14, size: 4, type: { kind: 'unknown' }, offsetVar: 0x3004n },
        { name: '_speed', offset: 0x18, size: 4, type: floatType },
      ],
      properties: [
        { name: 'hp', ivar: '_hp', type: intType },
        { name: 'mp', ivar: '_mp', type: intType },
        { name: 'speed', ivar: '_speed', type: intType },
      ],
    }],
  });

  assert.deepEqual(fields.resolveAccess({ base: 'x0', disp: 0x10n, self: true }, 'Hero')?.type, intType);
  assert.deepEqual(fields.resolveAccess({ base: 'x0', indexAddr: 0x3000n, self: true })?.type, intType);
  assert.deepEqual(fields.resolveAccess({ base: 'x0', disp: 0x14n, self: true }, 'Hero')?.type, intType);
  assert.deepEqual(fields.resolveAccess({ base: 'x0', indexAddr: 0x3004n, self: true })?.type, intType);
  assert.deepEqual(fields.resolveAccess({ base: 'x0', disp: 0x18n, self: true }, 'Hero')?.type, floatType);
});

test('fields: accessorField supports custom getter/setter and rejects multi-arg setX:y: selectors', () => {
  const fields = new FieldIndex({
    classes: [{
      name: 'Toggle',
      instanceSize: 0x40,
      ivars: [
        { name: '_enabled', offset: 0x10, size: 1 },
        { name: '_hp', offset: 0x14, size: 4 },
      ],
      properties: [
        { name: 'enabled', ivar: '_enabled', getter: 'isEnabled', setter: 'changeEnabled:' },
        { name: 'hp', ivar: '_hp' },
      ],
      methods: [
        { addr: 0x100n, sel: 'isEnabled', kind: '-' },
        { addr: 0x104n, sel: 'changeEnabled:', kind: '-' },
        { addr: 0x108n, sel: 'setHp:', kind: '-' },
        { addr: 0x10cn, sel: 'setHp:animated:', kind: '-' },
      ],
    }],
  });

  assert.equal(fields.ownerOf(0x100n)?.accessorField?.name, '_enabled');
  assert.equal(fields.ownerOf(0x104n)?.accessorField?.name, '_enabled');
  assert.equal(fields.ownerOf(0x108n)?.accessorField?.name, '_hp');
  assert.equal(fields.ownerOf(0x10cn)?.accessorField, null);
});

test('fields: findFields guards non-string ivar names, searches property.name, and avoids _undefined binding', () => {
  const fields = new FieldIndex({
    classes: [{
      name: 'Entity',
      instanceSize: 0x40,
      ivars: [
        { name: undefined, offset: 0x08, size: 4 },
        { name: '_undefined', offset: 0x0c, size: 4 },
        { name: '_storage', offset: 0x10, size: 4 },
      ],
      properties: [
        { type: { kind: 'int', bytes: 4 } }, // missing both ivar and name
        { name: 'health', ivar: '_storage' },
      ],
    }],
  });

  assert.equal(fields.findFields(/undefined/i).map((x) => x.field.offset).includes(0x08), false);
  assert.equal(fields.fieldAt('Entity', 0x0c)?.field?.property, undefined);
  const healthHits = fields.findFields(/health/i);
  assert.equal(healthHits.length, 1);
  assert.equal(healthHits[0].field.name, '_storage');
});

test('fields: fieldAt computes minimum own offset across unsorted ivars before walking superclass', () => {
  const fields = new FieldIndex({
    classes: [
      {
        name: 'Base',
        instanceSize: 0x20,
        ivars: [
          { name: '_baseLow', offset: 0x08, size: 4 },
          { name: '_baseHigh', offset: 0x18, size: 4 },
        ],
      },
      {
        name: 'Child',
        superName: 'Base',
        instanceSize: 0x30,
        // Unsorted: 0x20 appears before 0x10
        ivars: [
          { name: '_later', offset: 0x20, size: 4 },
          { name: '_earlier', offset: 0x10, size: 4 },
        ],
      },
    ],
  });

  assert.equal(fields.fieldAt('Child', 0x08)?.field?.name, '_baseLow');
  assert.equal(fields.fieldAt('Child', 0x18), null, 'offset >= minOwnOffset (0x10) must not walk to superclass');
});

/* ─────────────────────────── js/objc.js ─────────────────────────── */

function buildObjcFixture({ arch = 'arm64', imp = 0x7000n, categoryClassName = null } = {}) {
  const mem = new Uint8Array(0x10000);
  const dv = new DataView(mem.buffer);
  const is32 = arch === 'armv7' || arch === 'arm';
  const ptrSize = is32 ? 4 : 8;
  const setPtr = (addr, val) => is32
    ? dv.setUint32(Number(addr), Number(val), true)
    : dv.setBigUint64(Number(addr), BigInt(val), true);
  const setU32 = (addr, val) => dv.setUint32(Number(addr), Number(val), true);
  const setStr = (addr, text) => mem.set(new TextEncoder().encode(`${text}\0`), Number(addr));

  const CATLIST = 0x1000n;
  const CAT = 0x2000n;
  const CAT_NAME = 0x3000n;
  const CLS_LIST = 0x0800n;
  const CLS = 0x4000n;
  const CLS_RO = 0x4200n;
  const CLS_NAME = 0x4400n;
  const ML = 0x5000n;
  const SEL = 0x6000n;
  const TYPES = 0x6100n;

  setPtr(CLS_LIST, CLS);
  setPtr(CLS + BigInt(4 * ptrSize), CLS_RO);
  setU32(CLS_RO + 8n, 32);
  setPtr(CLS_RO + (is32 ? 16n : 24n), CLS_NAME);
  setStr(CLS_NAME, 'KnownClass');

  setPtr(CATLIST, CAT);
  setPtr(CAT, CAT_NAME);
  setPtr(CAT + BigInt(ptrSize), categoryClassName ? CLS : 0xdeadbeefn);
  setPtr(CAT + BigInt(2 * ptrSize), ML);
  setStr(CAT_NAME, 'Extras');

  setU32(ML, 3 * ptrSize);
  setU32(ML + 4n, 1);
  setPtr(ML + 8n, SEL);
  setPtr(ML + 8n + BigInt(ptrSize), TYPES);
  setPtr(ML + 8n + BigInt(2 * ptrSize), imp);
  setStr(SEL, 'doWork');
  setStr(TYPES, 'v@:');

  const read = async (address, length, soft = false) => {
    const at = Number(address);
    if (!Number.isSafeInteger(at) || at < 0 || at >= mem.length) return null;
    const end = Math.min(mem.length, at + length);
    if (end - at < length && !soft) return null;
    return mem.subarray(at, end);
  };

  return {
    read,
    classList: { vmAddr: CLS_LIST, size: BigInt(ptrSize) },
    sections: {
      categoryList: { vmAddr: CATLIST, size: BigInt(ptrSize) },
      architecture: arch,
      executableRanges: [{ vmAddr: 0x7000n, size: 0x200n }],
      resolvePointer: async (raw) => BigInt(raw) === 0xdeadbeefn ? null : BigInt(raw),
    },
  };
}

test('objc: 32-bit ARM accepts Thumb odd IMPs while arm64 rejects odd IMPs', async () => {
  const thumbFixture = buildObjcFixture({ arch: 'armv7', imp: 0x7001n, categoryClassName: 'KnownClass' });
  const thumbModel = await buildObjcRuntimeModel(thumbFixture.read, thumbFixture.classList, thumbFixture.sections, null, 0n, null);
  assert.equal(thumbModel.categories[0]?.methods?.[0]?.implementationProven, true);
  assert.ok(thumbModel.names.some((n) => n.name === '-[KnownClass(Extras) doWork]' && n.addr === 0x7001n));

  const arm64BadFixture = buildObjcFixture({ arch: 'arm64', imp: 0x7001n, categoryClassName: 'KnownClass' });
  const arm64BadModel = await buildObjcRuntimeModel(arm64BadFixture.read, arm64BadFixture.classList, arm64BadFixture.sections, null, 0n, null);
  assert.equal(arm64BadModel.categories[0]?.methods?.[0]?.implementationProven, false);
  assert.equal(arm64BadModel.names.some((n) => n.name.includes('doWork')), false);
});

test('objc: suppresses <unknown> pseudo-symbols for categories with unresolved className and preserves spread order', async () => {
  const unknownFixture = buildObjcFixture({ arch: 'arm64', imp: 0x7000n, categoryClassName: null });
  const unknownModel = await buildObjcRuntimeModel(unknownFixture.read, unknownFixture.classList, unknownFixture.sections, null, 0n, null);
  assert.equal(unknownModel.names.some((n) => n.name.includes('<unknown>')), false);

  const knownFixture = buildObjcFixture({ arch: 'arm64', imp: 0x7000n, categoryClassName: 'KnownClass' });
  // Caller passes undefined/stale keys in options; spread order must not overwrite computed imageBase/classes/resolvePointer
  const knownModel = await buildObjcRuntimeModel(
    knownFixture.read,
    knownFixture.classList,
    knownFixture.sections,
    null,
    0n,
    null,
    { imageBase: undefined, classes: [], resolvePointer: undefined, signal: undefined, priority: undefined },
  );
  assert.equal(knownModel.categories[0]?.className, 'KnownClass');
  assert.ok(knownModel.names.some((n) => n.name === '-[KnownClass(Extras) doWork]'));
});

/* ─────────────────────────── js/swift.js ─────────────────────────── */

test('swift: binaryImage.resolvePointer and decodePointer preserve this binding across all 3 sites', async () => {
  class StatefulImage {
    constructor(bias, methodName) {
      this.bias = bias;
      this[methodName] = function (raw) {
        return BigInt(raw) + this.bias;
      };
    }
  }

  // 1. readSwiftMangledName absolute symbolic reference (kind 0x18)
  {
    const mem = new Uint8Array(64);
    const dv = new DataView(mem.buffer);
    mem[0] = 0x18;
    dv.setBigUint64(1, 0x100n, true);
    mem[9] = 0;
    const read = async (addr, len) => mem.subarray(Number(addr), Number(addr) + len);
    const img = new StatefulImage(0x5000n, 'decodePointer');
    const res = await readSwiftMangledName(read, 0n, { compilerMetadata: true, binaryImage: img });
    assert.equal(res.complete, true);
    assert.equal(res.symbolicReferences[0]?.resolvedTarget, 0x5100n);
  }

  // 2. parseSwiftConformanceDescriptor -> resolveAbsolutePointer (indirect protocol pointer)
  {
    const mem = new Uint8Array(0x200);
    const dv = new DataView(mem.buffer);
    // At 0x20: indirect relative pointer to 0x80 => offset = 0x60 | 1 = 0x61
    dv.setInt32(0x20, 0x61, true);
    dv.setInt32(0x24, 0x10, true); // rawTypeRef -> 0x34
    dv.setInt32(0x28, 0x20, true); // witnessTable
    dv.setUint32(0x2c, 0, true);   // typeReferenceKind = 0
    dv.setBigUint64(0x80, 0x200n, true);
    const read = async (addr, len) => mem.subarray(Number(addr), Number(addr) + len);
    const img = new StatefulImage(0x9000n, 'resolvePointer');
    const conf = await parseSwiftConformanceDescriptor(read, 0x20n, { binaryImage: img });
    assert.equal(conf?.protocol, 0x9200n);
  }

  // 3. parseSwiftWitnessTable
  {
    const mem = new Uint8Array(0x100);
    const dv = new DataView(mem.buffer);
    dv.setBigUint64(0x10, 0x40n, true);
    const read = async (addr, len) => mem.subarray(Number(addr), Number(addr) + len);
    const img = new StatefulImage(0x8000n, 'decodePointer');
    const entries = await parseSwiftWitnessTable(read, 0x10n, 1, 16, { binaryImage: img });
    assert.equal(entries[0]?.target, 0x8040n);
    assert.equal(entries[0]?.resolved, true);
  }
});

test('swift: failed parseSwiftGenericContext marks genericContextsComplete false and classifySwiftRuntimeCall handles $S', async () => {
  // Build a minimal __swift5_types section pointing to a generic struct descriptor whose generic header is unreadable
  const mem = new Uint8Array(0x40);
  const dv = new DataView(mem.buffer);
  // __swift5_types at 0x00: relative pointer to 0x10 (+0x10)
  dv.setInt32(0x00, 0x10, true);
  // Struct descriptor at 0x10: flags = 17 (struct) | 0x80 (generic) = 0x91
  dv.setUint32(0x10, 0x91, true);
  dv.setInt32(0x14, 0, true);     // parent
  dv.setInt32(0x18, 0x18, true);  // name at 0x18 + 0x18 = 0x30
  dv.setInt32(0x1c, 0, true);     // metadataAccessor
  dv.setInt32(0x20, 0, true);     // fieldDescriptor
  dv.setUint32(0x24, 0, true);    // numFields
  dv.setUint32(0x28, 0, true);    // fieldOffsetVectorOffset
  // Generic header would be at 0x2c (8 bytes -> 0x2c..0x34), make reads at >=0x2c for generic context fail by placing name at 0x30 and returning null for reads at 0x2c
  mem.set(new TextEncoder().encode('Box\0'), 0x30);

  const read = async (addr, len, soft = false) => {
    const a = Number(addr);
    if (a === 0x2c) return null; // force parseSwiftGenericContext to fail
    if (a < 0 || a >= mem.length) return null;
    const end = Math.min(mem.length, a + len);
    if (end - a < len && !soft) return null;
    return mem.subarray(a, end);
  };

  const model = await buildSwiftMetadataModel(read, [{ name: '__swift5_types', vmAddr: 0n, size: 4n }], { reader: read });
  assert.equal(model.types.length, 1);
  assert.equal(model.completeness.genericContexts.complete, false);
  assert.equal(model.complete, false);

  assert.equal(classifySwiftRuntimeCall('$S4main3fooyyF')?.runtime, 'swift');
  assert.equal(classifySwiftRuntimeCall('_$S4main3fooyyF')?.runtime, 'swift');
  assert.equal(classifySwiftRuntimeCall('$s4main3fooyyF')?.runtime, 'swift');
});

/* ─────────────────────────── js/rtti.js ─────────────────────────── */

test('rtti: demangleSwift preserves identifier suffixes matching kind codes', () => {
  assert.equal(demangleSwift('$s3App3PVC'), 'App.PVC');
  assert.equal(demangleSwift('$s3App3FOO'), 'App.FOO');
  assert.equal(demangleSwift('$s3App4Save'), 'App.Save');
  assert.equal(demangleSwift('$s3App4ItemC'), 'App.Item   [class]');
});

test('rtti: simplifyStd fixes unordered_set arity and advances search cursor past earlier templates', () => {
  const uset = '_ZNSt3__113unordered_setIiNS_4hashIiEENS_8equal_toIiEENS_9allocatorIiEEE4findERKi';
  assert.equal(readableName(uset), 'std::unordered_set<int>::find(const int &)');

  // Earlier non-std template Foo<int> must not block simplifying later std::vector<int, std::allocator<int>>
  const multi = '_ZN3FooIiE3barENSt3__16vectorIiNS1_9allocatorIiEEEE';
  assert.equal(readableName(multi), 'Foo<int>::bar(std::vector<int>)');
});

test('rtti: shortName protects operator()', () => {
  assert.equal(shortName('_ZN4Game7FunctorclEi'), 'Functor::operator()');
  assert.equal(shortName('_ZN4Game7FunctorclEi', { keepNamespace: true }), 'Game::Functor::operator()');
});

test('rtti: supports Itanium ABI tags B<len><tag> and std::__ndk1:: / std::__cxx11::', () => {
  assert.equal(demangleCxx('_Z3fooB5cxx11v'), 'foo()');
  assert.equal(demangleCxx('_ZN3Foo3barB7abi_tagEv'), 'Foo::bar()');

  const cxx11 = '_ZNSt7__cxx1112basic_stringIcSt11char_traitsIcESaIcEEC1Ev';
  assert.equal(demangleCxx(cxx11), 'std::__cxx11::basic_string<char, std::char_traits<char>, std::allocator<char>>::basic_string()');
  assert.equal(readableName(cxx11), 'std::string::basic_string()');

  const ndk1 = '_ZNSt6__ndk16vectorIiNS_9allocatorIiEEE4sizeEv';
  assert.equal(readableName(ndk1), 'std::vector<int>::size()');
});

test('rtti: findCxxClasses only enforces limit on new classes and still populates RTTI fields for existing ones', () => {
  const symbols = {
    names: ['_ZTV3Foo', '_ZTV3Bar', '_ZTI3Foo', '_ZTS3Foo'],
    addrs: [0x1000n, 0x2000n, 0x1100n, 0x1200n],
  };
  const classes = findCxxClasses(symbols, 1);
  assert.equal(classes.length, 1);
  assert.equal(classes[0].name, 'Foo');
  assert.equal(classes[0].vtable, 0x1000n);
  assert.equal(classes[0].typeinfo, 0x1100n);
  assert.equal(classes[0].typeName, 0x1200n);
});

/* ─────────────────────────── js/il2cpp.js ─────────────────────────── */

test('il2cpp: skips tiny data sections, scans ELF .data/.rodata/.data.rel.ro, and reads short module names at section end', async () => {
  // Layout:
  // 0x1000..0x1010: tiny .data (16 bytes < minimum 24) — must be skipped, not abort scan
  // 0x2000..0x2100: .data.rel.ro containing a real count=20 CodeGenModule
  // 0x3000..0x3009: .rodata containing "Game.dll\0" right at section end (only 9 bytes total!)
  // 0x4000..0x4100: .data containing pointer table (20 entries * 8 = 160 bytes)
  // 0x5000..0x6000: .text (exec)
  const mem = new Map();
  const tiny = new Uint8Array(16);
  const relro = new Uint8Array(0x100);
  const relroDv = new DataView(relro.buffer);
  const rodata = new TextEncoder().encode('Game.dll\0'); // exact 9 bytes
  const tableBuf = new Uint8Array(0x100);
  const tableDv = new DataView(tableBuf.buffer);

  for (let i = 0; i < 20; i++) {
    tableDv.setBigUint64(i * 8, 0x5000n + BigInt(i * 0x10), true);
  }

  // Real candidate at 0x2040: namePtr=0x3000, count=20, table=0x4000
  relroDv.setBigUint64(0x40, 0x3000n, true);
  relroDv.setUint32(0x48, 20, true);
  relroDv.setBigUint64(0x50, 0x4000n, true);

  const regions = [
    { section: '.data', vmAddr: 0x1000n, size: 16n, exec: false, zerofill: false },
    { section: '.data.rel.ro', vmAddr: 0x2000n, size: 0x100n, exec: false, zerofill: false },
    { section: '.rodata', vmAddr: 0x3000n, size: BigInt(rodata.length), exec: false, zerofill: false },
    { section: '.data', vmAddr: 0x4000n, size: 0x100n, exec: false, zerofill: false },
    { section: '.text', vmAddr: 0x5000n, size: 0x1000n, exec: true, zerofill: false },
  ];
  mem.set(0x1000n, tiny);
  mem.set(0x2000n, relro);
  mem.set(0x3000n, rodata);
  mem.set(0x4000n, tableBuf);

  const read = async (addr, len) => {
    for (const r of regions) {
      if (addr >= r.vmAddr && addr + BigInt(len) <= r.vmAddr + r.size) {
        const buf = mem.get(r.vmAddr);
        if (!buf) return null;
        const off = Number(addr - r.vmAddr);
        return buf.subarray(off, off + len);
      }
    }
    return null;
  };

  const methods = Array.from({ length: 20 }, (_, i) => ({
    index: i,
    name: `m${i}`,
    classIndex: 0,
    token: 0x06000001 + i,
  }));
  const meta = {
    images: [{ index: 0, name: 'Game.dll', typeStart: 0, typeCount: 1 }],
    methods,
    warnings: [],
  };

  const res = await bindMethodAddresses(meta, { regions, read });
  assert.equal(res.preferred, 'codegen-modules');
  assert.equal(res.bound, 20);
  assert.equal(res.verified, true);
  assert.equal(methods[0].address, 0x5000n);
  assert.equal(methods[19].address, 0x5000n + 19n * 0x10n);
});

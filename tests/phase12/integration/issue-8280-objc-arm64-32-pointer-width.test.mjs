// Regression for #8280: Objective-C runtime metadata hard-coded 8-byte native
// pointers. On arm64_32 (watchOS ILP32) every runtime pointer is 4 bytes, so a
// correct __objc_classlist entry was read as half of a 64-bit pointer and the
// section was reported as "declared 0 + 4 misaligned bytes" — every class,
// protocol, and category silently disappeared. A non-relative method entry is
// three native pointers, so the fixed 24-byte minimum also rejected valid
// 12-byte ILP32 entries. The native pointer width now comes from one authority
// (explicit width > declared architecture > documented LP64 default), shared by
// the legacy parser, the extended parser, and the runtime facade, and a
// declared-but-unknown ABI fails closed instead of being widened to LP64.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { parseMachO } from '../../../js/binary/macho.js';
import {
  buildObjcModel,
  resolveObjcPointerBytes,
} from '../../../js/objc-legacy.js';
import { parseObjcExtendedMetadata } from '../../../js/apple/objc-metadata.js';
import { buildObjcRuntimeModel } from '../../../js/objc.js';

function readerFor(mem) {
  return async (addr, len) => {
    const at = Number(addr);
    if (!Number.isSafeInteger(at) || at < 0 || at >= mem.length) return null;
    return mem.subarray(at, Math.min(mem.length, at + len));
  };
}

function fixture() {
  const mem = new Uint8Array(0x4000);
  const dv = new DataView(mem.buffer);
  const p32 = (at, v) => dv.setUint32(at, Number(v) >>> 0, true);
  const str = (at, s) => {
    const bytes = new TextEncoder().encode(s);
    mem.set(bytes, at);
    mem[at + bytes.length] = 0;
  };
  return { mem, p32, str, read: readerFor(mem) };
}

function fixedMachOString(bytes, at, length) {
  return new TextDecoder().decode(bytes.subarray(at, at + length)).replace(/\0.*$/s, '');
}

function compilerFixtureRelocations(bytes, sectionName) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getUint32(0, true), 0xfeedface, 'fixture is a 32-bit ARM64_32 Mach-O object');
  const ncmds = view.getUint32(16, true);
  let commandAt = 28;
  let section = null;
  let symbolTable = null;

  for (let index = 0; index < ncmds; index++) {
    const command = view.getUint32(commandAt, true);
    const commandSize = view.getUint32(commandAt + 4, true);
    if (command === 1) { // LC_SEGMENT
      const sectionCount = view.getUint32(commandAt + 48, true);
      for (let sectionIndex = 0; sectionIndex < sectionCount; sectionIndex++) {
        const entryAt = commandAt + 56 + sectionIndex * 68;
        if (fixedMachOString(bytes, entryAt, 16) !== sectionName) continue;
        section = {
          address: view.getUint32(entryAt + 32, true),
          fileOffset: view.getUint32(entryAt + 40, true),
          relocationOffset: view.getUint32(entryAt + 48, true),
          relocationCount: view.getUint32(entryAt + 52, true),
        };
      }
    } else if (command === 2) { // LC_SYMTAB
      symbolTable = {
        symbolOffset: view.getUint32(commandAt + 8, true),
        symbolCount: view.getUint32(commandAt + 12, true),
        stringOffset: view.getUint32(commandAt + 16, true),
      };
    }
    commandAt += commandSize;
  }

  assert.ok(section, `compiler fixture has ${sectionName}`);
  assert.ok(symbolTable, 'compiler fixture has an LC_SYMTAB command');
  const symbolNames = Array.from({ length: symbolTable.symbolCount }, (_, index) => {
    const stringIndex = view.getUint32(symbolTable.symbolOffset + index * 12, true);
    const start = symbolTable.stringOffset + stringIndex;
    let end = start;
    while (end < bytes.length && bytes[end] !== 0) end++;
    return fixedMachOString(bytes, start, end - start);
  });
  const relocations = Array.from({ length: section.relocationCount }, (_, index) => {
    const entryAt = section.relocationOffset + index * 8;
    const address = view.getInt32(entryAt, true);
    const info = view.getUint32(entryAt + 4, true);
    const symbolIndex = info & 0x00ffffff;
    return {
      address,
      symbol: info & 0x08000000 ? symbolNames[symbolIndex] : null,
    };
  });
  return { section, relocations };
}

// A minimal arm64_32 Objective-C image: one class with one non-relative 12-byte
// method entry, and one protocol whose pointer fields are all 4 bytes.
function ilp32Image() {
  const f = fixture();
  const classList = 0x200;
  const classAddr = 0x1000;
  const classRo = 0x1200;
  const methodList = 0x1400;
  const ivarList = 0x1600;
  const ivarOffset = 0x1a00;
  const classProperties = 0x1700;
  const className = 0x1800;
  const selector = 0x1900;
  const ivarName = 0x1a20;
  const ivarType = 0x1a40;
  const propertyName = 0x1a60;
  const propertyAttributes = 0x1a80;

  // __objc_classlist: one 4-byte class pointer.
  f.p32(classList, classAddr);
  // Compiler-emitted class_t is 20 bytes; data is at +0x10 on ARM64_32.
  f.p32(classAddr + 16, classRo);
  // class_ro_t: instanceSize@8, name@16, methods@20, ivars@28,
  // baseProperties@36. These offsets match clang's arm64_32 output.
  f.p32(classRo + 8, 0x20);
  f.p32(classRo + 16, className);
  f.p32(classRo + 20, methodList);
  f.p32(classRo + 28, ivarList);
  f.p32(classRo + 36, classProperties);
  f.str(className, 'ILP32Victim');
  // method_list_t: entsize 12 (no REL flag), one entry of three 4-byte pointers.
  f.p32(methodList, 12);
  f.p32(methodList + 4, 1);
  f.p32(methodList + 8, selector);
  f.p32(methodList + 12, 0);
  f.p32(methodList + 16, 0x2100);
  f.str(selector, 'doThing:');

  // ivar_list_t and property_list_t use the same 4-byte native pointer ABI.
  f.p32(ivarList, 20);
  f.p32(ivarList + 4, 1);
  f.p32(ivarList + 8, ivarOffset);
  f.p32(ivarList + 12, ivarName);
  f.p32(ivarList + 16, ivarType);
  f.p32(ivarList + 20, 4);
  f.p32(ivarList + 24, 4);
  f.p32(ivarOffset, 16);
  f.str(ivarName, 'count');
  f.str(ivarType, 'i');
  f.p32(classProperties, 8);
  f.p32(classProperties + 4, 1);
  f.p32(classProperties + 8, propertyName);
  f.p32(classProperties + 12, propertyAttributes);
  f.str(propertyName, 'count');
  f.str(propertyAttributes, 'Ti,N,V_count');

  const protocolList = 0x300;
  const protocol = 0x2400;
  const protocolName = 0x2800;
  const protocolProperties = 0x1b00;
  const protocolClassProperties = 0x1b20;
  // __objc_protolist: one 4-byte protocol_t pointer.
  f.p32(protocolList, protocol);
  // protocol_t: name@4, protocols@8, methods@12.., instanceProperties@28,
  // size@32, flags@36, and classProperties@48 (clang emits size 52).
  f.p32(protocol + 4, protocolName);
  f.p32(protocol + 28, protocolProperties);
  f.p32(protocol + 32, 52);
  f.p32(protocol + 36, 0);
  f.p32(protocol + 48, protocolClassProperties);
  f.str(protocolName, 'ILP32Protocol');
  for (const list of [protocolProperties, protocolClassProperties]) {
    f.p32(list, 8);
    f.p32(list + 4, 0);
  }

  const categoryList = 0x400;
  const category = 0x2c00;
  const categoryName = 0x2e00;
  const categoryProperties = 0x2d00;
  const categoryClassProperties = 0x2d20;
  // category_t: name@0, class@4, and 4-byte method/protocol/property pointers.
  f.p32(categoryList, category);
  f.p32(category, categoryName);
  f.p32(category + 4, classAddr);
  f.p32(category + 20, categoryProperties);
  f.p32(category + 24, categoryClassProperties);
  f.str(categoryName, 'ILP32Category');
  for (const list of [categoryProperties, categoryClassProperties]) {
    f.p32(list, 8);
    f.p32(list + 4, 0);
  }

  return {
    read: f.read,
    setProtocolSize(value) { f.p32(protocol + 32, value); },
    classList: { vmAddr: BigInt(classList), size: 4n },
    protocolList: { vmAddr: BigInt(protocolList), size: 4n },
    categoryList: { vmAddr: BigInt(categoryList), size: 4n },
    classAddress: BigInt(classAddr),
    protocolProperties: BigInt(protocolProperties),
    protocolClassProperties: BigInt(protocolClassProperties),
    categoryProperties: BigInt(categoryProperties),
    categoryClassProperties: BigInt(categoryClassProperties),
  };
}

test('#8280 the native pointer ABI authority is explicit, total, and ordered', () => {
  assert.deepEqual(resolveObjcPointerBytes({ pointerBytes: 4 }), { bytes: 4, provenance: 'explicit' });
  assert.deepEqual(resolveObjcPointerBytes({ pointerSize: 8 }), { bytes: 8, provenance: 'explicit' });
  assert.deepEqual(
    resolveObjcPointerBytes({ pointerBytes: 4 }, { architecture: 'arm64' }),
    { bytes: 4, provenance: 'explicit' },
    'an explicit width must outrank a declared architecture',
  );
  assert.deepEqual(resolveObjcPointerBytes({ architecture: 'arm64_32' }), { bytes: 4, provenance: 'architecture', architecture: 'arm64_32' });
  assert.deepEqual(resolveObjcPointerBytes({ architecture: 'armv7k' }), { bytes: 4, provenance: 'architecture', architecture: 'armv7k' });
  assert.deepEqual(resolveObjcPointerBytes({ architecture: 'arm64e' }), { bytes: 8, provenance: 'architecture', architecture: 'arm64e' });
  assert.deepEqual(resolveObjcPointerBytes({ architecture: 'x86_64' }), { bytes: 8, provenance: 'architecture', architecture: 'x86_64' });
  assert.deepEqual(resolveObjcPointerBytes(), { bytes: 8, provenance: 'default-lp64' });

  const unsupported = resolveObjcPointerBytes({ architecture: 'mips64' });
  assert.equal(unsupported.bytes, null);
  assert.equal(unsupported.reason, 'objc-pointer-abi-unsupported');
  const invalid = resolveObjcPointerBytes({ pointerBytes: 16 });
  assert.equal(invalid.bytes, null);
  assert.equal(invalid.reason, 'objc-pointer-abi-invalid');
});

test('#8280 compiler-generated ARM64_32 Mach-O confirms Objective-C field offsets and strides', () => {
  // Generated from the neighboring .m fixture with clang 14:
  // clang --target=arm64_32-apple-watchos7.0 -fobjc-runtime=watchos -fno-objc-arc -c
  const bytes = new Uint8Array(readFileSync(new URL('./fixtures/issue-8280-arm64_32-objc.o', import.meta.url)));
  const image = parseMachO(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(image.arch, 'arm64_32');
  for (const name of ['__objc_classlist', '__objc_protolist', '__objc_catlist']) {
    assert.equal(image.sections.find((section) => section.name === name)?.size, 4n, `${name} holds one native pointer`);
  }

  const classData = image.sections.find((section) => section.name === '__objc_data');
  const classSymbol = image.symbols.find((symbol) => symbol.name === '_OBJC_CLASS_$_Foo');
  const classDataRelocations = compilerFixtureRelocations(bytes, '__objc_data').relocations;
  assert.ok(classData && classSymbol);
  assert.ok(classDataRelocations.some((relocation) => (
    relocation.address === Number(classSymbol.address - classData.address) + 16
      && relocation.symbol === '__OBJC_CLASS_RO_$_Foo'
  )), 'class_t data relocation is at +16');

  const classRoSection = image.sections.find((section) => section.name === '__objc_const');
  const classRoSymbol = image.symbols.find((symbol) => symbol.name === '__OBJC_CLASS_RO_$_Foo');
  const classRoRelocations = compilerFixtureRelocations(bytes, '__objc_const').relocations;
  assert.ok(classRoSection && classRoSymbol);
  const classRoOffset = Number(classRoSymbol.address - classRoSection.address);
  const fieldOffsets = Object.fromEntries(classRoRelocations
    .filter((relocation) => relocation.address >= classRoOffset && relocation.address < classRoOffset + 40)
    .map((relocation) => [relocation.symbol, relocation.address - classRoOffset]));
  assert.deepEqual(fieldOffsets, {
    l_OBJC_CLASS_NAME_: 16,
    '__OBJC_$_INSTANCE_METHODS_Foo': 20,
    '__OBJC_$_INSTANCE_VARIABLES_Foo': 28,
    '__OBJC_$_PROP_LIST_Foo': 36,
  });

  for (const [symbolName, stride] of [
    ['__OBJC_$_INSTANCE_METHODS_Foo', 12],
    ['__OBJC_$_INSTANCE_VARIABLES_Foo', 20],
    ['__OBJC_$_PROP_LIST_Foo', 8],
  ]) {
    const symbol = image.symbols.find((item) => item.name === symbolName);
    assert.ok(symbol, `compiler fixture has ${symbolName}`);
    const entryAt = Number(classRoSection.fileOffset + symbol.address - classRoSection.address);
    assert.equal(view.getUint32(entryAt, true) & 0xffff, stride, `${symbolName} stride`);
  }
});

test('#8280 legacy model decodes the 4-byte class list and 12-byte method entry only under ILP32', async () => {
  const ilp32 = ilp32Image();
  const model = await buildObjcModel(ilp32.read, ilp32.classList, null, 0n, null, { architecture: 'arm64_32' });
  assert.equal(model.pointerBytes, 4);
  assert.equal(model.classes.length, 1, 'a 4-byte class pointer must yield one class');
  assert.equal(model.classes[0].name, 'ILP32Victim');
  assert.equal(model.classes[0].methods.length, 1, 'a 12-byte non-relative entry is a valid ILP32 method');
  assert.equal(model.classes[0].methods[0].sel, 'doThing:');
  assert.equal(model.classes[0].ivars[0]?.name, 'count');
  assert.equal(model.classes[0].ivars[0]?.offset, 16);
  assert.equal(model.classes[0].properties[0]?.name, 'count');
  assert.equal(model.classes[0].properties[0]?.ivar, '_count');
  assert.equal(model.completeness.classes.declared, 1);
  assert.equal(model.completeness.classes.misalignedBytes, 0);
  assert.equal(model.completeness.complete, true);

  // Explicit width behaves identically to the declared architecture.
  const byWidth = await buildObjcModel(ilp32.read, ilp32.classList, null, 0n, null, { pointerSize: 4 });
  assert.equal(byWidth.classes[0]?.name, 'ILP32Victim');

  // Control: with no ABI claim the documented LP64 default genuinely cannot read
  // this fixture, so the 4 bytes are a misaligned remainder — never half a pointer.
  const lp64 = await buildObjcModel(ilp32.read, ilp32.classList, null, 0n);
  assert.equal(lp64.classes.length, 0);
  assert.equal(lp64.completeness.classes.misalignedBytes, 4);
  assert.ok(lp64.completeness.classes.reasons.includes('class-list-size-misaligned'));
  assert.equal(lp64.completeness.complete, false);
});

test('#8280 an unknown declared ABI fails closed instead of widening to LP64', async () => {
  const ilp32 = ilp32Image();
  const model = await buildObjcModel(ilp32.read, ilp32.classList, null, 0n, null, { architecture: 'unknown' });
  assert.equal(model.classes.length, 0, 'no class may be fabricated from an undecodable ABI');
  assert.equal(model.pointerBytes, null);
  assert.equal(model.pointerAbiReason, 'objc-pointer-abi-unsupported');
  assert.ok(model.completeness.classes.reasons.includes('objc-pointer-abi-unsupported'));
  assert.equal(model.completeness.classes.sizeValid, false);
  assert.equal(model.completeness.complete, false);
});

test('#8280 extended protocol parser reads 4-byte pointers on ILP32', async () => {
  const ilp32 = ilp32Image();
  const sections = { protocolList: ilp32.protocolList, categoryList: ilp32.categoryList };
  const options = { architecture: 'arm64_32', classes: [{ addr: ilp32.classAddress, name: 'ILP32Victim' }] };

  const ilp32Result = await parseObjcExtendedMetadata(ilp32.read, sections, options);
  assert.equal(ilp32Result.pointerBytes, 4);
  assert.equal(ilp32Result.protocols.length, 1);
  assert.equal(ilp32Result.protocols[0].name, 'ILP32Protocol');
  assert.equal(ilp32Result.protocols[0].instancePropertiesAddress, ilp32.protocolProperties);
  assert.equal(ilp32Result.protocols[0].classPropertiesAddress, ilp32.protocolClassProperties);
  assert.equal(ilp32Result.categories.length, 1);
  assert.equal(ilp32Result.categories[0].name, 'ILP32Category');
  assert.equal(ilp32Result.categories[0].className, 'ILP32Victim');
  assert.equal(ilp32Result.categories[0].instancePropertiesAddress, ilp32.categoryProperties);
  assert.equal(ilp32Result.categories[0].classPropertiesAddress, ilp32.categoryClassProperties);
  assert.equal(ilp32Result.completeness.protocols.declared, 1);
  assert.equal(ilp32Result.completeness.protocols.misalignedBytes, 0);
  assert.equal(ilp32Result.completeness.complete, true);

  const undersized = ilp32Image();
  undersized.setProtocolSize(39);
  const undersizedResult = await parseObjcExtendedMetadata(undersized.read, {
    protocolList: undersized.protocolList,
  }, options);
  assert.equal(undersizedResult.protocols[0]?.size, 39);
  assert.equal(undersizedResult.protocols[0]?.completeness.complete, false,
    'the ILP32 protocol_t size must include both 32-bit size and flags fields');
  assert.equal(undersizedResult.completeness.protocols.incompleteItems, 1);
  assert.equal(undersizedResult.completeness.complete, false);

  const byWidth = await parseObjcExtendedMetadata(ilp32.read, sections, { ...options, pointerBytes: 4 });
  assert.equal(byWidth.protocols[0]?.name, 'ILP32Protocol');
  assert.equal(byWidth.categories[0]?.name, 'ILP32Category');

  // LP64 control: the same 4-byte section is a misaligned remainder.
  const lp64 = await parseObjcExtendedMetadata(ilp32.read, sections, {});
  assert.equal(lp64.protocols.length, 0);
  assert.equal(lp64.categories.length, 0);
  assert.equal(lp64.completeness.protocols.misalignedBytes, 4);
  assert.equal(lp64.completeness.categories.misalignedBytes, 4);
  assert.equal(lp64.completeness.complete, false);

  // Declared but unsupported / invalid ABI must publish an explicit reason and
  // no partially-decoded protocols.
  for (const [opts, reason] of [
    [{ architecture: 'mips64' }, 'objc-pointer-abi-unsupported'],
    [{ pointerBytes: 16 }, 'objc-pointer-abi-invalid'],
  ]) {
    const failed = await parseObjcExtendedMetadata(ilp32.read, sections, opts);
    assert.equal(failed.protocols.length, 0);
    assert.equal(failed.categories.length, 0);
    assert.equal(failed.pointerBytes, null);
    assert.equal(failed.pointerAbiReason, reason);
    assert.equal(failed.completeness.complete, false);
  }
});

test('#8280 runtime facade passes the declared architecture to both parsers', async () => {
  const ilp32 = ilp32Image();
  const model = await buildObjcRuntimeModel(
    ilp32.read,
    ilp32.classList,
    {
      protocolList: ilp32.protocolList,
      categoryList: ilp32.categoryList,
      architecture: 'arm64_32',
      executableRanges: [{ vmAddr: 0x2000n, size: 0x1000n }],
    },
    null,
    0n,
  );
  assert.equal(model.pointerBytes, 4, 'the facade must surface the shared ILP32 width');
  assert.equal(model.classes.length, 1);
  assert.equal(model.classes[0].name, 'ILP32Victim');
  assert.equal(model.protocols.length, 1);
  assert.equal(model.protocols[0].name, 'ILP32Protocol');
  assert.equal(model.categories.length, 1);
  assert.equal(model.categories[0].className, 'ILP32Victim');
  assert.equal(model.runtimeCompleteness.complete, true);
});

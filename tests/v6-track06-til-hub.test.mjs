/**
 * Track 6 Comprehensive Test Suite: 2-Tier TIL, TIL1 Binary Compiler,
 * C11 Header Parser, .tbd & .swiftinterface Parsers, SDK Fingerprinting/Matching,
 * Storage & Pack Manager LRU Eviction, Batch Compiler, build-til-hub.mjs,
 * Round 1 Security/Parity/Resilience Regressions, and INV-005.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fflate from '../js/vendor/fflate.js';

import {
  TIL_PRIM,
  TIL_NS,
  TIL_TYPE_INVALID,
  HEX_KIND,
  SIG_FLAG,
  FMT_FAMILY,
  CALL_CONV,
  makeHexTypeId,
  unpackHexTypeId,
  hexTypeIsNone,
  hexPtr,
  getCoreTilIr,
  formatHexTypeId,
} from '../js/analysis/types/core/til-lite-data.js';

import {
  TIL1_MAGIC,
  TIL1_CORE_MAX_BYTES,
  TIL1_HASH_INDEX_OFFSET,
  fnv1a32,
  compileTil1,
  validateTil1Buffer,
  parseTil1Buffer,
  Til1View,
} from '../js/analysis/types/core/til-binary-compiler.js';

import {
  TilLiteResolver,
  normalizeSymbolForTil,
  SLOT_ID,
} from '../js/analysis/types/core/til-lite-resolver.js';

import {
  parseLocalTypesHeader,
  evalIntExpr,
  DeferredHeaderTypeTable,
} from '../js/analysis/types/core/c11-header-parser.js';

import { parseTbd, tbdToSdkIrUnit } from '../js/analysis/types/core/tbd-parser.js';
import { parseSwiftInterface, swiftInterfaceToSdkIrUnit } from '../js/analysis/types/core/swiftinterface-parser.js';
import { fingerprintBinarySdk } from '../js/analysis/types/core/sdk-fingerprint.js';
import { matchSdkPacks } from '../js/analysis/types/core/sdk-matcher.js';
import {
  MemoryTilStorage,
  IndexedDbTilStorage,
  sha256Hex,
  sha256HexSync,
  verifySha256,
} from '../js/analysis/types/core/til-storage.js';
import {
  TilPackManager,
  PACK_LIMITS,
  validateCommunityMirrorUrl,
  validateManifestPayload,
  decompressTilPayload,
} from '../js/analysis/types/core/til-pack-manager.js';
import {
  compileSdkBatch,
  extractSdkZipFiles,
  validateSdkFilePath,
} from '../js/analysis/types/core/sdk-batch-compiler.js';
import { buildTilHub } from '../scripts/build-til-hub.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL  ${name}`);
    console.error(err);
  }
}

console.log('=== Track 6: 2-Tier TIL & TIL-Hub Test Suite ===');

// ---------------------------------------------------------------------------
// 1. INV-005 Boundary Check
// ---------------------------------------------------------------------------
await test('INV-005: zero imports from js/targets/architecture/ under js/analysis/types/core/', () => {
  const coreDir = path.join(REPO_ROOT, 'js', 'analysis', 'types', 'core');
  const files = fs.readdirSync(coreDir).filter((f) => f.endsWith('.js'));
  assert.ok(files.length >= 10, `Expected >= 10 core TIL files, found ${files.length}`);
  for (const f of files) {
    const src = fs.readFileSync(path.join(coreDir, f), 'utf8');
    const importSpecifiers = [
      ...src.matchAll(/(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g),
      ...src.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
    ].map((m) => m[1]);
    for (const spec of importSpecifiers) {
      assert.ok(
        !spec.includes('targets/architecture') && !spec.includes('/architecture/'),
        `INV-005 violation in ${f}: forbidden import '${spec}'`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 2. HexTypeId bit layout & Core TIL-lite compilation / budget
// ---------------------------------------------------------------------------
await test('HexTypeId bit layout pack/unpack & Core TIL1 <= 160 KiB', () => {
  const constCharPtr = hexPtr(TIL_PRIM.I8, { isConst: true, depth: 1 });
  const u = unpackHexTypeId(constCharPtr);
  assert.equal(u.baseTilId, TIL_PRIM.I8);
  assert.equal(u.ptrDepth, 1);
  assert.equal(u.isConst, true);
  assert.equal(u.isPacSigned, false);
  assert.equal(hexTypeIsNone(constCharPtr), false);
  assert.equal(hexTypeIsNone(0xFFFFFFFF), true);
  assert.equal(formatHexTypeId(constCharPtr), 'const char*');

  const coreIr = getCoreTilIr();
  const coreBytes = compileTil1(coreIr);
  assert.ok(coreBytes.byteLength <= TIL1_CORE_MAX_BYTES, `Core TIL1 too large: ${coreBytes.byteLength}`);
  assert.ok(coreIr.functions.length >= 180, 'Core TIL should have rich curated functions');

  const val = validateTil1Buffer(coreBytes);
  assert.equal(val.ok, true, val.error);
  assert.equal(val.header.magic, TIL1_MAGIC);
  assert.equal(val.header.isCore, true);
  assert.equal(val.header.hasExtChunk, true);
  assert.equal(val.header.entryCount, coreIr.functions.length);
  assert.equal(val.header.selCount, coreIr.selectors.length);
});

// ---------------------------------------------------------------------------
// 3. TIL1 binary round-trip, relative TID remapping & malformed rejection
// ---------------------------------------------------------------------------
await test('TIL1 binary compile/parse round-trip, relative TID remapping & tidCap bounds', () => {
  const customTypeTid = TIL_NS.PACK_MIN + 5;
  const ir = {
    packId: 'test-pack',
    isCore: false,
    localTidRelative: true,
    types: [
      { tid: customTypeTid, name: 'MyCustomCtx', kind: HEX_KIND.STRUCT, bits: 128, qualifiers: 0, pointeeTid: 0 },
    ],
    functions: [
      {
        name: 'custom_init',
        retHexType: hexPtr(customTypeTid, { kindTag: HEX_KIND.STRUCT }),
        paramHexTypes: [hexPtr(TIL_PRIM.I8, { isConst: true }), makeHexTypeId({ baseTilId: TIL_PRIM.U32 })],
        flags: SIG_FLAG.ALLOC,
        fmtArgIdx: 0xFF,
        callConv: CALL_CONV.AAPCS64,
      },
    ],
    selectors: [
      {
        name: '+MyClass:sharedInstance',
        retHexType: makeHexTypeId({ baseTilId: TIL_PRIM.OBJC_ID, kindTag: HEX_KIND.OBJC_OR_SWIFT_OBJ }),
        paramHexTypes: [
          makeHexTypeId({ baseTilId: TIL_PRIM.OBJC_ID, kindTag: HEX_KIND.OBJC_OR_SWIFT_OBJ }),
          makeHexTypeId({ baseTilId: TIL_PRIM.OBJC_SEL }),
        ],
        flags: SIG_FLAG.OBJC_CLASS_METHOD,
        fmtArgIdx: 0xFF,
        callConv: CALL_CONV.AAPCS64,
      },
    ],
    enums: [
      { tid: customTypeTid, name: 'MyCustomCtx', items: [{ name: 'ERR_OK', value: 0 }, { name: 'ERR_FAIL', value: -1 }] },
    ],
    structLayouts: [
      {
        tid: customTypeTid,
        name: 'MyCustomCtx',
        totalSize: 16,
        members: [
          { offset: 0, name: 'magic', hexType: makeHexTypeId({ baseTilId: TIL_PRIM.U32 }), size: 4, bfLsb: 0, bfWidth: 0 },
          { offset: 8, name: 'next', hexType: hexPtr(customTypeTid, { kindTag: HEX_KIND.STRUCT }), size: 8, bfLsb: 0, bfWidth: 0 },
        ],
      },
    ],
  };

  const buf = compileTil1(ir);
  const remappedBase = TIL_NS.PACK_MIN + 2560; // Slot B base
  const parsed = parseTil1Buffer(buf, { tidBase: remappedBase });

  assert.equal(parsed.functions.length, 1);
  assert.equal(parsed.functions[0].name, 'custom_init');
  assert.equal(parsed.functions[0].retHexType & 0xFFFF, remappedBase + 5);
  assert.equal(parsed.functions[0].paramHexTypes[0] & 0xFFFF, TIL_PRIM.I8);
  assert.equal(parsed.selectors.length, 1);
  assert.equal(parsed.enums.length, 1);
  assert.equal(parsed.enums[0].items[1].value, -1);
  assert.equal(parsed.structLayouts.length, 1);
  assert.equal(parsed.structLayouts[0].members[1].hexType & 0xFFFF, remappedBase + 5);

  // Verify remapTid strictly limits to 0x1000..0x5FFF and checks tidCap
  const view = new Til1View(buf, { tidBase: 0x2000, tidCap: 4 });
  assert.equal(view.remapTid(0x0040), 0x0040); // Core TID unchanged
  assert.equal(view.remapTid(0x6001), 0x6001); // Local header TID (> 0x5FFF) unchanged
  assert.equal(view.remapTid(0x1003), 0x2003); // delta 3 < tidCap 4 -> remapped
  assert.equal(view.remapTid(0x1004), TIL_TYPE_INVALID); // delta 4 >= tidCap 4 -> INVALID
});

await test('TIL1 validator rejects malformed buffers (magic, version, checksum, arity, unsorted hash, non-NUL string)', () => {
  const valid = compileTil1(getCoreTilIr());

  assert.equal(validateTil1Buffer(valid.subarray(0, 40)).ok, false);

  const badMagic = new Uint8Array(valid);
  badMagic[0] = 0x58;
  assert.equal(validateTil1Buffer(badMagic).ok, false);

  const badVer = new Uint8Array(valid);
  new DataView(badVer.buffer).setUint16(0x04, 99, true);
  assert.equal(validateTil1Buffer(badVer).ok, false);

  const badCsum = new Uint8Array(valid);
  badCsum[badCsum.length - 1] ^= 0xFF;
  assert.equal(validateTil1Buffer(badCsum).ok, false);

  // Corrupt arity > 12 with recomputed checksum
  const badArity = new Uint8Array(valid);
  const dvA = new DataView(badArity.buffer);
  const sigPoolOff = dvA.getUint32(0x14, true);
  dvA.setUint8(sigPoolOff + 9, 25);
  dvA.setUint32(0x20, fnv1a32(badArity, 0x20, 0x24), true);
  assert.equal(validateTil1Buffer(badArity).ok, false);

  // Corrupt Hash Index ordering (swap entries 0 and 1) with recomputed checksum -> must reject
  const badSort = new Uint8Array(valid);
  const e0 = badSort.slice(TIL1_HASH_INDEX_OFFSET, TIL1_HASH_INDEX_OFFSET + 12);
  const e1 = badSort.slice(TIL1_HASH_INDEX_OFFSET + 12, TIL1_HASH_INDEX_OFFSET + 24);
  badSort.set(e1, TIL1_HASH_INDEX_OFFSET);
  badSort.set(e0, TIL1_HASH_INDEX_OFFSET + 12);
  new DataView(badSort.buffer).setUint32(0x20, fnv1a32(badSort, 0x20, 0x24), true);
  assert.equal(validateTil1Buffer(badSort).ok, false);

  // Corrupt StringPool to remove trailing NUL terminators with recomputed checksum -> must reject
  const smallValid = compileTil1({
    packId: 'nul-test',
    isCore: false,
    types: [],
    functions: [{ name: 'foo_bar', retHexType: 1, paramHexTypes: [], flags: 0, fmtArgIdx: 0xFF, callConv: 0 }],
  });
  const badNul = new Uint8Array(smallValid);
  const dvN = new DataView(badNul.buffer);
  const strPoolOff = dvN.getUint32(0x18, true);
  for (let i = strPoolOff; i < badNul.length; i++) {
    if (badNul[i] === 0) badNul[i] = 0x41; // overwrite NUL with 'A'
  }
  dvN.setUint32(0x20, fnv1a32(badNul, 0x20, 0x24), true);
  assert.equal(validateTil1Buffer(badNul).ok, false);
});

// ---------------------------------------------------------------------------
// 4. Core TIL Resolution, Symbol Normalization & Strict Priority Ordering
// ---------------------------------------------------------------------------
await test('Core TIL resolution: POSIX, Darwin, ObjC, C++ ABI, IL2CPP & symbol normalization', () => {
  const resolver = new TilLiteResolver();

  const r1 = resolver.resolveSymbol('_memcpy');
  assert.ok(r1 && r1.matchedName === 'memcpy' && r1.arity === 3);

  const r2 = resolver.resolveSymbol('__imp_j_open$UNIX2003');
  assert.ok(r2 && r2.matchedName === 'open' && r2.arity === 2);

  const r3 = resolver.resolveSymbol('snprintf@@GLIBC_2.17');
  assert.ok(r3 && r3.matchedName === 'snprintf' && r3.formatFamily === FMT_FAMILY.PRINTF && r3.fmtArgIdx === 2);

  const normCxx = normalizeSymbolForTil('__Znwm');
  assert.equal(normCxx.kind, 'itanium-cxx');
  assert.ok(normCxx.candidates.includes('_Znwm'));
  assert.ok(!normCxx.candidates.includes('Znwm'));
  const rCxx = resolver.resolveSymbol('__Znwm');
  assert.ok(rCxx && rCxx.matchedName === '_Znwm' && rCxx.arity === 1);

  const rSel = resolver.resolveSymbol('+[NSString stringWithUTF8String:]');
  assert.ok(rSel && rSel.matchedName === '+NSString:stringWithUTF8String:' && rSel.arity === 3);

  const rStub = resolver.resolveSymbol('_objc_msgSend$UTF8String');
  assert.ok(rStub && rStub.matchedName === '*:UTF8String');

  const rOsLog = resolver.resolveSymbol('__os_log_impl');
  assert.ok(rOsLog && rOsLog.arity === 6 && rOsLog.formatFamily === FMT_FAMILY.OS_LOG_FIXED);

  const rIl2 = resolver.resolveSymbol('il2cpp_runtime_invoke');
  assert.ok(rIl2 && rIl2.arity === 4);

  const callSig = resolver.resolveKnownCallSignature('malloc');
  assert.ok(callSig && callSig.isAlloc && callSig.retTypeStr === 'void*' && callSig.arity === 1);
});

await test('Priority ordering strictly enforces User Header > Pack B > Pack A > Core TIL', () => {
  const resolver = new TilLiteResolver();

  const makeOverridePack = (packId, retPrim) =>
    compileTil1({
      packId,
      isCore: false,
      localTidRelative: true,
      types: [],
      functions: [
        {
          name: 'malloc',
          retHexType: makeHexTypeId({ baseTilId: retPrim }),
          paramHexTypes: [makeHexTypeId({ baseTilId: TIL_PRIM.U64 })],
          flags: 0,
          fmtArgIdx: 0xFF,
          callConv: CALL_CONV.AAPCS64,
        },
      ],
    });

  assert.equal(resolver.resolveSymbol('malloc').source, 'core-til');

  resolver.mountPack(SLOT_ID.PACK_A, makeOverridePack('pack-a', TIL_PRIM.I32), { packId: 'pack-a' });
  let hit = resolver.resolveSymbol('malloc');
  assert.equal(hit.source, 'pack-a');
  assert.equal(hit.retHexType & 0xFFFF, TIL_PRIM.I32);

  resolver.mountPack(SLOT_ID.PACK_B, makeOverridePack('pack-b', TIL_PRIM.I64), { packId: 'pack-b' });
  hit = resolver.resolveSymbol('malloc');
  assert.equal(hit.source, 'pack-b');
  assert.equal(hit.retHexType & 0xFFFF, TIL_PRIM.I64);

  resolver.setUserHeader(makeOverridePack('user-hdr', TIL_PRIM.F64));
  hit = resolver.resolveSymbol('malloc');
  assert.equal(hit.source, 'user-header');
  assert.equal(hit.retHexType & 0xFFFF, TIL_PRIM.F64);
});

// ---------------------------------------------------------------------------
// 5. C11 Header Parser + 64-bit #define + Deep Nesting Guard
// ---------------------------------------------------------------------------
await test('C11 header parser: structs, bitfields, #pragma pack, typedefs, enums, 64-bit #define & deep nesting safety', () => {
  const header = `
    #include <stdint.h>
    #include "missing_local.h"
    #if defined(__APPLE__)
    #define MAGIC_BASE 0x100
    #define MAGIC_SHIFT (MAGIC_BASE | (1 << 3))
    #define BIG_MASK_40 (1ULL << 40)
    #define BIG_MASK_60 (1ULL << 60)
    #endif

    typedef struct Node Node;

    enum PacketFlags {
      PKT_NONE = 0,
      PKT_SYN = 1 << 0,
      PKT_ACK = 1 << 1,
      PKT_FIN = 1 << 2
    };

    struct BitHeader {
      uint32_t version : 4;
      uint32_t ihl : 4;
      uint32_t dscp : 6;
      uint32_t flags : 18;
      uint16_t length;
    };

    #pragma pack(push, 1)
    struct PackedRecord {
      uint8_t tag;
      uint64_t value;
    };
    #pragma pack(pop)

    struct Node {
      int32_t id;
      Node *next;
      uint8_t payload[];
    };

    typedef int (*CompareFn)(const void * restrict a, const void * restrict b);

    ??? broken syntax here ;

    extern const char *format_packet(const struct BitHeader *hdr, int count, ...);
  `;

  const parsed = parseLocalTypesHeader(header);
  assert.equal(parsed.includes.length, 2);
  assert.equal(parsed.defines.get('MAGIC_BASE'), 0x100);
  assert.equal(parsed.defines.get('MAGIC_SHIFT'), 0x108);
  assert.equal(parsed.defines.get('BIG_MASK_40'), 1099511627776); // 2^40 exact!
  assert.equal(parsed.defines.get('BIG_MASK_60'), 1n << 60n); // > MAX_SAFE_INTEGER preserved as BigInt!

  // Deeply nested expression (> 64 parens) safely returns null without stack overflow
  const deepExpr = '('.repeat(120) + '1' + ')'.repeat(120);
  assert.equal(evalIntExpr(deepExpr, null, 64), null);

  // Deeply nested structs (> 64 levels) safely recover without stack overflow
  const deepStructs =
    'struct S0 { '.repeat(80) + 'int leaf;' + ' }; '.repeat(80) + '\nint after_deep(int x);';
  const parsedDeep = parseLocalTypesHeader(deepStructs, { maxDepth: 64 });
  assert.ok(parsedDeep.diagnostics.some((d) => d.message.includes('nesting depth')));
  assert.ok(parsedDeep.functions.some((f) => f.name === 'after_deep'));

  const pktFlags = parsed.enums.get('PacketFlags');
  assert.ok(pktFlags && pktFlags.isBitmask);
  assert.equal(pktFlags.items.find((i) => i.name === 'PKT_FIN').value, 4);

  const bh = parsed.structs.get('BitHeader');
  assert.ok(bh && bh.layoutState === 'defined');
  assert.equal(bh.members[0].bfLsb, 0);
  assert.equal(bh.members[0].bfWidth, 4);
  assert.equal(bh.members[3].bfLsb, 14);
  assert.equal(bh.members[3].bfWidth, 18);
  assert.equal(bh.members[4].offset, 4);
  assert.equal(bh.size, 8);

  const packed = parsed.structs.get('PackedRecord');
  assert.equal(packed.members[1].offset, 1);
  assert.equal(packed.size, 9);

  const node = parsed.structs.get('Node');
  assert.equal(node.members[1].offset, 8);
  assert.equal(node.size, 16);

  assert.ok(parsed.typedefs.get('CompareFn')?.isFuncPtr);
  assert.ok(parsed.diagnostics.length >= 1);
  assert.ok(parsed.functions.find((f) => f.name === 'format_packet')?.isVariadic);

  const deferred = new DeferredHeaderTypeTable(parsed);
  assert.ok(deferred.lookupFunction('format_packet'));
  const slot3Buf = compileTil1(deferred.selectForSlot3(new Set(['format_packet'])));
  assert.equal(validateTil1Buffer(slot3Buf).ok, true);
});

// ---------------------------------------------------------------------------
// 6. Apple .tbd Parser (v4 YAML & v5 JSON)
// ---------------------------------------------------------------------------
await test('Apple .tbd v4 YAML & v5 JSON parsing', () => {
  const tbdV4 = `--- !tapi-tbd
tbd-version:     4
targets:         [ arm64-ios, arm64e-ios ]
install-name:    '/System/Library/Frameworks/Foundation.framework/Foundation'
current-version: 2202.0.0
compatibility-version: 300.0.0
exports:
  - targets:         [ arm64-ios, arm64e-ios ]
    symbols:         [ _NSLog, _NSStringFromClass,
                       _NSSearchPathForDirectoriesInDomains ]
    objc-classes:    [ NSObject, NSString, NSArray ]
    objc-ivars:      [ NSObject.isa ]
...`;

  const parsedV4 = parseTbd(tbdV4);
  assert.equal(parsedV4.tbdVersion, 4);
  assert.equal(parsedV4.installName, '/System/Library/Frameworks/Foundation.framework/Foundation');
  assert.deepEqual(parsedV4.archs, ['arm64', 'arm64e']);
  assert.ok(parsedV4.symbols.includes('_NSLog'));
  assert.deepEqual(parsedV4.objcClasses, ['NSObject', 'NSString', 'NSArray']);
  assert.deepEqual(parsedV4.objcIvars, ['NSObject.isa']);

  const irUnit = tbdToSdkIrUnit(parsedV4);
  assert.equal(irUnit.types.length, 3);
  assert.ok(irUnit.functions.some((f) => f.name === 'NSLog'));

  const tbdV5 = JSON.stringify({
    tapi_tbd_version: 5,
    main_library: {
      target_info: [{ target: 'arm64-macos' }],
      install_names: [{ name: '/usr/lib/libSystem.B.dylib' }],
      current_versions: [{ version: '1345.100.2' }],
      exported_symbols: [
        {
          targets: ['arm64-macos'],
          text: { global: ['_malloc', '_free'] },
          data: { objc_class: ['OS_dispatch_queue'] },
        },
      ],
    },
  });
  const parsedV5 = parseTbd(tbdV5);
  assert.equal(parsedV5.tbdVersion, 5);
  assert.ok(parsedV5.symbols.includes('_malloc'));
  assert.ok(parsedV5.objcClasses.includes('OS_dispatch_queue'));
});

// ---------------------------------------------------------------------------
// 7. Swift .swiftinterface Parser
// ---------------------------------------------------------------------------
await test('Swift .swiftinterface parser extracts structs, classes, funcs, @_cdecl, @objc, swiftcall', () => {
  const swiftSrc = `
    // swift-compiler-version: Apple Swift version 5.10
    // swift-module-flags: -target arm64-apple-ios17.0 -module-name GameCore
    import Foundation
    import Swift

    public struct Vec3 {
      public var x: Float
      public var y: Float
      public var z: Float
      public func length() -> Float {
        return (x * x + y * y + z * z).squareRoot()
      }
    }

    @objc
    public class PlayerController : NSObject {
      public let playerId: Int64
      @objc(applyDamage:critical:)
      public func applyDamage(_ amount: Int32, critical isCrit: Bool) -> Bool
    }

    @_cdecl("game_core_tick")
    public func tick(dt: Double) -> Int32
  `;

  const parsed = parseSwiftInterface(swiftSrc);
  assert.equal(parsed.moduleName, 'GameCore');
  assert.equal(parsed.targetTriple, 'arm64-apple-ios17.0');
  assert.equal(parsed.types.length, 2);

  const ir = swiftInterfaceToSdkIrUnit(parsed);
  const swiftFn = ir.functions.find((f) => f.name === 'GameCore.Vec3.length()');
  assert.ok(swiftFn && swiftFn.callConv === CALL_CONV.SWIFTCALL);
  const cdeclFn = ir.functions.find((f) => f.name === 'game_core_tick');
  assert.ok(cdeclFn && cdeclFn.callConv === CALL_CONV.AAPCS64);
  const objcSel = ir.selectors.find((s) => s.name === '-PlayerController:applyDamage:critical:');
  assert.ok(objcSel && objcSel.paramHexTypes.length === 4);
});

// ---------------------------------------------------------------------------
// 8. SDK Fingerprinting & Deterministic Matching
// ---------------------------------------------------------------------------
await test('SDK fingerprinting & matching across iOS, Android NDK, Linux glibc, Unity IL2CPP', () => {
  const catalog = [
    {
      id: 'ios-sdk-18',
      version: '18.0.0',
      sdkVersion: '18.0',
      category: 'os',
      source: 'official',
      matchRules: { platforms: ['ios'], libc: 'libSystem', dylibs: ['UIKit', 'Foundation'], hints: ['uikit', 'objc'] },
      conflicts: ['ios-sdk-16'],
      requires: [],
    },
    {
      id: 'ios-sdk-16',
      version: '16.0.0',
      sdkVersion: '16.0',
      category: 'os',
      source: 'official',
      matchRules: { platforms: ['ios'], libc: 'libSystem', dylibs: ['UIKit', 'Foundation'], hints: ['uikit', 'objc'] },
      conflicts: ['ios-sdk-18'],
      requires: [],
    },
    {
      id: 'android-ndk-34',
      version: '34.0.0',
      sdkVersion: '34',
      category: 'os',
      source: 'official',
      matchRules: { platforms: ['android'], libc: 'bionic', dylibs: ['liblog.so', 'libandroid.so'], hints: ['android-ndk'] },
      conflicts: ['glibc-2.38'],
      requires: [],
    },
    {
      id: 'glibc-2.38',
      version: '2.38.0',
      sdkVersion: '2.38',
      category: 'os',
      source: 'official',
      matchRules: { platforms: ['linux'], libc: 'glibc', dylibs: ['libc.so.6'], hints: ['glibc'] },
      conflicts: ['android-ndk-34'],
      requires: [],
    },
    {
      id: 'unity-il2cpp',
      version: '29.0.0',
      sdkVersion: '29',
      category: 'engine',
      source: 'official',
      matchRules: { platforms: ['any'], dylibs: [], hints: ['unity-il2cpp'] },
      conflicts: [],
      requires: [],
    },
  ];

  const iosFp = fingerprintBinarySdk({
    format: 'macho',
    arch: 'arm64',
    loadCommands: [
      { cmd: 'LC_BUILD_VERSION', platform: 2, sdk: (18 << 16), minos: (15 << 16) },
      { cmd: 'LC_LOAD_DYLIB', name: '/System/Library/Frameworks/UIKit.framework/UIKit', currentVersion: (18 << 16) },
      { cmd: 'LC_LOAD_DYLIB', name: '/System/Library/Frameworks/Foundation.framework/Foundation' },
    ],
    symbols: ['objc_msgSend', 'il2cpp_init', 'il2cpp_domain_get'],
  });
  const iosMatch = matchSdkPacks(iosFp, catalog);
  assert.equal(iosMatch.slots.packA.id, 'ios-sdk-18');
  assert.equal(iosMatch.slots.packB.id, 'unity-il2cpp');
  assert.ok(!iosMatch.selected.some((s) => s.pack.id === 'ios-sdk-16'));

  const androidFp = fingerprintBinarySdk({
    format: 'elf',
    arch: 'arm64',
    ptInterp: '/system/bin/linker64',
    dtNeeded: ['liblog.so', 'libandroid.so', 'libc.so'],
    elfNotes: [{ name: 'Android', apiLevel: 34 }],
  });
  const androidMatch = matchSdkPacks(androidFp, catalog);
  assert.equal(androidMatch.slots.packA.id, 'android-ndk-34');
  assert.ok(!androidMatch.selected.some((s) => s.pack.id === 'glibc-2.38'));
});

// ---------------------------------------------------------------------------
// 9. TilPackManager: LRU eviction, reload refresh, TID exhaustion, Gzip/ZIP bomb abort, offline fallback
// ---------------------------------------------------------------------------
await test('TilPackManager: LRU eviction, same-pack reload, TID slot exhaustion, Gzip/ZIP pre-rejection & offline fallback', async () => {
  const resolver = new TilLiteResolver();
  const storage = new MemoryTilStorage({ maxBytes: 2 * 1024 * 1024, maxEntries: 32 });
  const pm = new TilPackManager({ resolver, storage, fflate });

  const makePack = (name, fnName, retPrim = TIL_PRIM.I32) =>
    compileTil1({
      packId: name,
      isCore: false,
      localTidRelative: true,
      types: [],
      functions: [
        {
          name: fnName,
          retHexType: makeHexTypeId({ baseTilId: retPrim }),
          paramHexTypes: [],
          flags: 0,
          fmtArgIdx: 0xFF,
          callConv: CALL_CONV.AAPCS64,
        },
      ],
    });

  const p1v1 = makePack('pack1', 'fn_one', TIL_PRIM.I32);
  const p1v2 = makePack('pack1', 'fn_one', TIL_PRIM.F64);
  const p2 = makePack('pack2', 'fn_two');
  const p3 = makePack('pack3', 'fn_three');

  // Mount pack1 gzip with SHA-256
  const p1Gz = fflate.gzipSync(p1v1, { level: 6, mtime: 0 });
  const p1GzSha = await sha256Hex(p1Gz);
  assert.equal((await verifySha256(p1Gz, p1GzSha)).ok, true);
  assert.equal(p1GzSha, sha256HexSync(p1Gz));

  const m1 = await pm.mountPack('pack1', p1Gz, { expectedSha256: p1GzSha });
  assert.equal(m1.slot, 'A');
  assert.equal(resolver.resolveSymbol('fn_one').retHexType & 0xFFFF, TIL_PRIM.I32);

  // Re-mounting same packId MUST refresh view & resolver with new contents
  const m1Reload = await pm.mountPack('pack1', p1v2);
  assert.equal(m1Reload.slot, 'A');
  assert.equal(m1Reload.reloaded, true);
  assert.equal(resolver.resolveSymbol('fn_one').retHexType & 0xFFFF, TIL_PRIM.F64);

  // Streaming Gunzip aborts immediately when maxBytes exceeded (Gzip Bomb defense)
  const bigZeros = new Uint8Array(256 * 1024); // compresses to ~300 bytes
  const gzipBomb = fflate.gzipSync(bigZeros, { level: 9, mtime: 0 });
  await assert.rejects(
    () => decompressTilPayload(gzipBomb, { fflate, maxBytes: 16 * 1024 }),
    /exceeds maxBytes/
  );

  // ZIP pre-filter rejects oversized entry & path traversal BEFORE inflation
  const oversizedZip = fflate.zipSync({ 'bomb.til1': bigZeros });
  await assert.rejects(
    () => decompressTilPayload(oversizedZip, { fflate, maxBytes: 16 * 1024 }),
    /exceeds maxBytes/
  );
  const traversalZip = fflate.zipSync({ '../escape.til1': p2 });
  await assert.rejects(
    () => decompressTilPayload(traversalZip, { fflate }),
    /Path traversal/
  );

  // Mount pack2 as valid ZIP, touch pack1, mount pack3 -> evicts pack2
  const p2Zip = fflate.zipSync({ 'pack2.til1': p2 });
  const m2 = await pm.mountPack('pack2', p2Zip);
  assert.equal(m2.slot, 'B');
  pm.touchPack('pack1');
  const m3 = await pm.mountPack('pack3', p3);
  assert.equal(m3.slot, 'B');
  assert.equal(m3.evictedPackId, 'pack2');
  assert.equal(resolver.resolveSymbol('fn_two'), null);

  // Exhaust all 8 logical TID slots -> 9th unique pack throws (NO % 8 collision!)
  for (let k = 4; k <= 8; k++) {
    await pm.mountPack(`pack${k}`, makePack(`pack${k}`, `fn_${k}`));
  }
  await assert.rejects(
    () => pm.mountPack('pack9', makePack('pack9', 'fn_9')),
    /No free logical TIL pack slot available/
  );
  // Explicitly release an evicted pack's TID base -> pack9 can now safely reuse it
  assert.equal(pm.releasePackTidBase('pack2'), true);
  const m9 = await pm.mountPack('pack9', makePack('pack9', 'fn_9'));
  assert.ok(m9.slot === 'A' || m9.slot === 'B');

  // Manifest MAX_MANIFEST_BYTES validation
  const hugeManifest = JSON.stringify({
    schema: 'til-hub-manifest/v1',
    packs: [{ id: 'x', padding: 'A'.repeat(PACK_LIMITS.MAX_MANIFEST_BYTES + 100) }],
  });
  assert.equal(validateManifestPayload(hugeManifest).ok, false);
  assert.equal(validateManifestPayload({ schema: 'til-hub-manifest/v1', packs: [{ id: 'ok' }] }).ok, true);

  // Offline / failed remote fetch -> degrades cleanly to cache -> Core TIL without throwing
  const offlinePm = new TilPackManager({
    resolver: new TilLiteResolver(),
    storage: new MemoryTilStorage(),
    fflate,
    fetcher: async () => { throw new Error('network offline'); },
  });
  // Cache miss + offline -> core-fallback (no throw)
  const fbCore = await offlinePm.loadPackWithFallback('missing-pack', { url: 'https://til.example.org/missing.til.gz' });
  assert.equal(fbCore.mounted, false);
  assert.equal(fbCore.source, 'core-fallback');
  assert.ok(offlinePm.resolver.resolveSymbol('malloc')); // Core TIL still works!

  // Pre-seed cache + offline -> cache-fallback mounts cleanly
  await offlinePm.storage.put('cached-pack', p2, { packId: 'cached-pack' });
  const fbCache = await offlinePm.loadPackWithFallback('cached-pack', { url: 'https://til.example.org/cached.til.gz' });
  assert.equal(fbCache.mounted, true);
  assert.equal(fbCache.source, 'cache-fallback');
  assert.ok(offlinePm.resolver.resolveSymbol('fn_two'));

  // Community mirror URL defense
  assert.equal(validateCommunityMirrorUrl('https://til.example.org/manifest.json').ok, true);
  assert.equal(validateCommunityMirrorUrl('http://til.example.org/manifest.json').ok, false);
  assert.equal(validateCommunityMirrorUrl('https://127.0.0.1/manifest.json').ok, false);
  assert.equal(validateCommunityMirrorUrl('https://192.168.1.5/manifest.json').ok, false);
});

// ---------------------------------------------------------------------------
// 10. IndexedDbTilStorage: _open() retry after error/blocked & maxBytes LRU eviction
// ---------------------------------------------------------------------------
await test('IndexedDbTilStorage: _open() resets on error/blocked & put() enforces maxBytes LRU eviction', async () => {
  const storeData = new Map();
  let openAttempts = 0;

  // Lightweight mock IndexedDB supporting error, blocked, get, put, delete, getAll
  const mockIdb = {
    open() {
      openAttempts++;
      const req = {};
      queueMicrotask(() => {
        if (openAttempts === 1) {
          req.error = new Error('transient open error');
          req.onerror?.();
        } else if (openAttempts === 2) {
          req.onblocked?.();
        } else {
          req.result = {
            objectStoreNames: { contains: () => true },
            transaction(_storeName, _mode) {
              const tx = {};
              const objStore = {
                get(key) {
                  const r = {};
                  queueMicrotask(() => { r.result = storeData.get(key); r.onsuccess?.(); });
                  return r;
                },
                getAll() {
                  const r = {};
                  queueMicrotask(() => { r.result = Array.from(storeData.values()); r.onsuccess?.(); });
                  return r;
                },
                put(rec) {
                  storeData.set(rec.key, rec);
                },
                delete(key) {
                  storeData.delete(key);
                },
              };
              tx.objectStore = () => objStore;
              // Complete transaction after getAll microtask runs
              setTimeout(() => tx.oncomplete?.(), 0);
              return tx;
            },
          };
          req.onsuccess?.();
        }
      });
      return req;
    },
  };

  const idbStorage = new IndexedDbTilStorage({ maxBytes: 100, indexedDBImpl: mockIdb });

  // Attempt 1 fails with onerror -> _dbPromise reset
  await assert.rejects(() => idbStorage.put('k1', new Uint8Array(40)), /transient open error/);
  // Attempt 2 fails with onblocked -> _dbPromise reset
  await assert.rejects(() => idbStorage.put('k1', new Uint8Array(40)), /blocked/);
  // Attempt 3 succeeds!
  await idbStorage.put('k1', new Uint8Array(40));
  await idbStorage.put('k2', new Uint8Array(40));
  // Touch k1 so k2 becomes the oldest LRU entry
  assert.ok(await idbStorage.get('k1'));
  // Putting k3 (40B) exceeds maxBytes (100B: 40+40+40=120 > 100) -> must evict k2!
  await idbStorage.put('k3', new Uint8Array(40));

  assert.ok(storeData.has('k1'), 'k1 was recently touched and must remain');
  assert.ok(storeData.has('k3'), 'k3 must be stored');
  assert.equal(storeData.has('k2'), false, 'k2 was LRU and must be evicted');
});

// ---------------------------------------------------------------------------
// 11. SDK Batch Compiler: Zip Bomb/symlink pre-rejection & Multi-Chunk TID Rebasing
// ---------------------------------------------------------------------------
await test('SDK batch compiler: pre-inflation Zip Bomb/symlink rejection & multi-chunk 0x1000 TID rebasing', async () => {
  assert.equal(validateSdkFilePath('../etc/passwd').ok, false);
  assert.equal(validateSdkFilePath('/abs/path.h').ok, false);
  assert.equal(validateSdkFilePath('C:\\Windows\\foo.h').ok, false);

  // Pre-inflation Zip Bomb / oversized file rejection
  const bombData = new Uint8Array(128 * 1024);
  const bombZip = fflate.zipSync({ 'huge.h': bombData });
  await assert.rejects(
    () => extractSdkZipFiles(bombZip, { fflate, maxSingleFileBytes: 16 * 1024 }),
    /exceeds max single file size/
  );

  // Pre-inflation path traversal rejection
  const badZip = fflate.zipSync({ '../evil.h': new TextEncoder().encode('int x;') });
  await assert.rejects(() => extractSdkZipFiles(badZip, { fflate }), /Path traversal/);

  // Pre-inflation ZIP symlink (S_IFLNK = 0xA000) rejection
  const symZip = new Uint8Array(fflate.zipSync({ 'link.h': new TextEncoder().encode('/etc/passwd') }));
  // Locate Central Directory entry (PK\x01\x02) and set Unix S_IFLNK mode in externalAttr (+38)
  const dv = new DataView(symZip.buffer);
  for (let i = 0; i <= symZip.length - 46; i++) {
    if (dv.getUint32(i, true) === 0x02014b50) {
      dv.setUint32(i + 38, (0xA1FF << 16) >>> 0, true);
      break;
    }
  }
  await assert.rejects(() => extractSdkZipFiles(symZip, { fflate }), /symlink \(S_IFLNK\) rejected/);

  // Multi-chunk splitting with 0x1000 TID rebasing & cross-chunk type dependency closure
  const multiHeader = `
    typedef struct TypeA { int32_t a; } TypeA;
    typedef struct TypeB { TypeA *refA; int32_t b; } TypeB;
    typedef struct TypeC { TypeB *refB; int32_t c; } TypeC;
    typedef struct TypeD { TypeC *refC; int32_t d; } TypeD;
    TypeA *make_a(void);
    TypeB *make_b(TypeA *a);
    TypeC *make_c(TypeB *b);
    TypeD *make_d(TypeC *c);
  `;
  const splitRes = await compileSdkBatch(
    [{ path: 'multi.h', content: multiHeader }],
    { packId: 'split-sdk', fflate, maxTypesPerPack: 2, maxEntriesPerPack: 2 }
  );
  assert.ok(splitRes.packs.length >= 2, `Expected >= 2 chunks, got ${splitRes.packs.length}`);

  // Every chunk must have local TIDs rebased starting at 0x1000 and valid under Til1View with tight tidCap!
  for (const p of splitRes.packs) {
    const parsedChunk = parseTil1Buffer(p.tilBytes, { tidBase: TIL_NS.PACK_MIN, tidCap: p.typeCount });
    assert.ok(parsedChunk.types.length > 0);
    const localTids = parsedChunk.types.map((t) => t.localTid).sort((a, b) => a - b);
    assert.equal(localTids[0], TIL_NS.PACK_MIN, `Chunk ${p.packId} must rebase local TIDs from 0x1000`);
    assert.equal(localTids[localTids.length - 1], TIL_NS.PACK_MIN + localTids.length - 1);

    // Every function's return & param local TID must resolve to a valid type inside the SAME chunk
    for (const fn of parsedChunk.functions) {
      const retTid = fn.retHexType & 0xFFFF;
      if (retTid >= TIL_NS.PACK_MIN && retTid <= TIL_NS.PACK_MAX) {
        assert.ok(parsedChunk.types.some((t) => t.tid === retTid), `Dangling retTid 0x${retTid.toString(16)} in ${p.packId}`);
      }
      for (const paramHex of fn.paramHexTypes) {
        const pTid = paramHex & 0xFFFF;
        if (pTid >= TIL_NS.PACK_MIN && pTid <= TIL_NS.PACK_MAX) {
          assert.ok(parsedChunk.types.some((t) => t.tid === pTid), `Dangling paramTid 0x${pTid.toString(16)} in ${p.packId}`);
        }
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 12. CLI Build Script (scripts/build-til-hub.mjs) determinism & output
// ---------------------------------------------------------------------------
await test('scripts/build-til-hub.mjs produces deterministic manifest.json & valid TIL1 packs', async () => {
  const tmp1 = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-til-hub-1-'));
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-til-hub-2-'));
  try {
    const m1 = await buildTilHub({ outDir: tmp1, quiet: true });
    const m2 = await buildTilHub({ outDir: tmp2, quiet: true });

    assert.equal(m1.schema, 'til-hub-manifest/v1');
    assert.ok(m1.totalPacks >= 7);
    assert.deepEqual(m1, m2, 'Build must be 100% deterministic across runs');
    assert.equal(validateManifestPayload(m1).ok, true);

    for (const p of m1.packs) {
      const tilPath = path.join(tmp1, p.file);
      const gzPath = path.join(tmp1, p.gzFile);
      assert.ok(fs.existsSync(tilPath), `Missing ${p.file}`);
      assert.ok(fs.existsSync(gzPath), `Missing ${p.gzFile}`);
      const bytes = new Uint8Array(fs.readFileSync(tilPath));
      assert.equal(sha256HexSync(bytes), p.sha256);
      assert.equal(validateTil1Buffer(bytes).ok, true);
    }
  } finally {
    fs.rmSync(tmp1, { recursive: true, force: true });
    fs.rmSync(tmp2, { recursive: true, force: true });
  }
});

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);

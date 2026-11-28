import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { lang, setLang } from '../js/i18n.js';
import {
  GLOSSARY_KEYS,
  EXTENDED_GLOSSARY_KEYS,
  EXTENDED_GLOSSARY_KEY_SET,
  ALL_GLOSSARY_KEYS,
  ALL_GLOSSARY_KEY_SET,
} from '../js/analysis/common/v6-auto-contracts.js';
import {
  getGlossaryEntry,
  listGlossaryEntries,
} from '../js/ui/beginner/glossary-translator.js';
import { scanVtables } from '../js/analysis/wasm-vtable-scanner.js';
import { resolveStrippedCxxRtti } from '../js/analysis/cxx/stripped-rtti-resolver.js';
import { resolveVtableRefOwners } from '../js/analysis/cxx/vtable-ref-resolver.js';
import { resolveStrippedObjcMethods } from '../js/analysis/apple/objc-method-resolver.js';
import { normalizeUnifiedMetadata } from '../js/analysis/apple/unified-metadata-normalizer.js';
import { buildVirtualFolderTree } from '../js/analysis/virtual-tree.js';
import { buildSemanticNames } from '../js/analysis/semantic-namer.js';
import { aggregateClassFields } from '../js/analysis/cxx/class-field-aggregator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const INITIAL_LANG = lang();

afterEach(() => {
  setLang(INITIAL_LANG);
});

const ASCII_DECODER = new TextDecoder('ascii');
const ASCII_ENCODER = new TextEncoder();

function writeCString(buf, offset, str) {
  const encoded = ASCII_ENCODER.encode(str);
  buf.set(encoded, offset);
  buf[offset + encoded.length] = 0;
  return offset + encoded.length + 1;
}

/**
 * Encode a 64-bit Mach-O DYLD_CHAINED_PTR_64_OFFSET rebase pointer.
 * bit 63 = 0, target = (va - imageBase) in low 36 bits.
 */
function encodeChainedOffsetRebase(va, imageBase) {
  const delta = va - imageBase;
  assert.ok(delta > 0n && delta < (1n << 36n), 'chained offset out of 36-bit range');
  return delta;
}

/**
 * Encode a 64-bit Mach-O DYLD_CHAINED_PTR_64_OFFSET bind pointer.
 * bit 63 = 1, ordinal in low 24 bits.
 */
function encodeChainedOffsetBind(ordinal) {
  return (1n << 63n) | BigInt(ordinal & 0xffffff);
}

/**
 * Build a synthetic stripped ARM64 Mach-O image with:
 * - __TEXT.__text (functions for Interface, Abstruct, Default, plus unclassified)
 * - __TEXT.__cstring (game coin strings)
 * - __TEXT.__const (_ZTS mangled names)
 * - __DATA_CONST.__const (chained_offset vtables + Itanium typeinfo records)
 */
function buildSyntheticStrippedMachO() {
  const imageBase = 0x100000000n;
  const textOff = 0x4000;
  const textSize = 0x2000;
  const textVa = imageBase + BigInt(textOff);
  const textLo = textVa;
  const textHi = textVa + BigInt(textSize);

  const cstringOff = 0x6000;
  const cstringSize = 0x1000;
  const cstringVa = imageBase + BigInt(cstringOff);

  const textConstOff = 0x7000;
  const textConstSize = 0x1000;
  const textConstVa = imageBase + BigInt(textConstOff);

  const dataConstOff = 0x8000;
  const dataConstSize = 0x2000;
  const dataConstVa = imageBase + BigInt(dataConstOff);

  const bytes = new Uint8Array(dataConstOff + dataConstSize);
  const dv = new DataView(bytes.buffer);

  // __TEXT.__cstring
  writeCString(bytes, cstringOff, 'Coin::addCoin');
  writeCString(bytes, cstringOff + 0x40, 'player_coin_balance');

  // __TEXT.__const: _ZTS typeinfo name strings
  const ztsInterfaceOff = textConstOff + 0x00;
  const ztsAbstructOff = textConstOff + 0x40;
  const ztsDefaultOff = textConstOff + 0x80;
  writeCString(bytes, ztsInterfaceOff, 'N4Game6System4Coin9InterfaceE');
  writeCString(bytes, ztsAbstructOff, 'N4Game6System4Coin8AbstructE');
  writeCString(bytes, ztsDefaultOff, 'N4Game6System4Coin7DefaultE');

  const ztsInterfaceVa = imageBase + BigInt(ztsInterfaceOff);
  const ztsAbstructVa = imageBase + BigInt(ztsAbstructOff);
  const ztsDefaultVa = imageBase + BigInt(ztsDefaultOff);

  // __DATA_CONST.__const: typeinfo records
  // Interface: __class_type_info (16B: vptr bind + _ZTS)
  const rttiInterfaceOff = dataConstOff + 0x000;
  const rttiInterfaceVa = imageBase + BigInt(rttiInterfaceOff);
  dv.setBigUint64(rttiInterfaceOff + 0, encodeChainedOffsetBind(1), true);
  dv.setBigUint64(rttiInterfaceOff + 8, encodeChainedOffsetRebase(ztsInterfaceVa, imageBase), true);

  // Abstruct: __si_class_type_info (24B: vptr bind + _ZTS + base_type -> Interface)
  const rttiAbstructOff = dataConstOff + 0x040;
  const rttiAbstructVa = imageBase + BigInt(rttiAbstructOff);
  dv.setBigUint64(rttiAbstructOff + 0, encodeChainedOffsetBind(2), true);
  dv.setBigUint64(rttiAbstructOff + 8, encodeChainedOffsetRebase(ztsAbstructVa, imageBase), true);
  dv.setBigUint64(rttiAbstructOff + 16, encodeChainedOffsetRebase(rttiInterfaceVa, imageBase), true);

  // Default: __si_class_type_info (24B: vptr bind + _ZTS + base_type -> Abstruct)
  const rttiDefaultOff = dataConstOff + 0x080;
  const rttiDefaultVa = imageBase + BigInt(rttiDefaultOff);
  dv.setBigUint64(rttiDefaultOff + 0, encodeChainedOffsetBind(2), true);
  dv.setBigUint64(rttiDefaultOff + 8, encodeChainedOffsetRebase(ztsDefaultVa, imageBase), true);
  dv.setBigUint64(rttiDefaultOff + 16, encodeChainedOffsetRebase(rttiAbstructVa, imageBase), true);

  // Function addresses in __TEXT.__text (4-byte aligned)
  const fnIfaceSlots = Array.from({ length: 10 }, (_, i) => textVa + BigInt(0x100 + i * 0x40));
  const fnAbstructSlot9 = textVa + 0x500n;
  const fnAbstructOwn = textVa + 0x540n;
  const fnDefaultOverride = textVa + 0x600n;
  const fnUnclassified = textVa + 0x900n;

  // Helper to write a chained_offset vtable (offsetToTop=0, rttiVa, slots[])
  const writeVtable = (fileOff, rttiVa, slotVas) => {
    dv.setBigInt64(fileOff + 0, 0n, true);
    dv.setBigUint64(fileOff + 8, encodeChainedOffsetRebase(rttiVa, imageBase), true);
    for (let i = 0; i < slotVas.length; i++) {
      dv.setBigUint64(fileOff + 16 + i * 8, encodeChainedOffsetRebase(slotVas[i], imageBase), true);
    }
    return fileOff + 16;
  };

  // Vtable for Interface (10 slots)
  writeVtable(dataConstOff + 0x200, rttiInterfaceVa, fnIfaceSlots);

  // Vtable for Abstruct (inherits slots 0..7, defines slot 8 & slot 9)
  const abstructSlots = [...fnIfaceSlots.slice(0, 8), fnAbstructOwn, fnAbstructSlot9];
  writeVtable(dataConstOff + 0x400, rttiAbstructVa, abstructSlots);

  // Vtable for Default (inherits slot 9 from Abstruct, overrides slot 8)
  const defaultSlots = [...fnIfaceSlots.slice(0, 8), fnDefaultOverride, fnAbstructSlot9];
  writeVtable(dataConstOff + 0x600, rttiDefaultVa, defaultSlots);

  const sections = [
    { name: '__text', segment: '__TEXT', address: textVa, size: textSize, fileOffset: textOff, fileSize: textSize },
    { name: '__cstring', segment: '__TEXT', address: cstringVa, size: cstringSize, fileOffset: cstringOff, fileSize: cstringSize },
    { name: '__const', segment: '__TEXT', address: textConstVa, size: textConstSize, fileOffset: textConstOff, fileSize: textConstSize },
    { name: '__const', segment: '__DATA_CONST', address: dataConstVa, size: dataConstSize, fileOffset: dataConstOff, fileSize: dataConstSize },
  ];

  const functions = [
    ...fnIfaceSlots.map((va) => ({ start: va, end: va + 0x40n })),
    { start: fnAbstructSlot9, end: fnAbstructSlot9 + 0x40n },
    { start: fnAbstructOwn, end: fnAbstructOwn + 0x40n },
    { start: fnDefaultOverride, end: fnDefaultOverride + 0x40n },
    { start: fnUnclassified, end: fnUnclassified + 0x40n },
  ].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));

  return {
    image: { bytes, sections, imageBase },
    imageBase,
    textVa,
    textLo,
    textHi,
    dataConstOff,
    dataConstSize,
    dataConstVa,
    functions,
    addrs: {
      fnAbstructSlot9,
      fnAbstructOwn,
      fnDefaultOverride,
      fnUnclassified,
    },
  };
}

function resolveBainaryTestPath() {
  const candidates = [];
  if (typeof process.env.HEX_BAINARY_TEST_PATH === 'string' && process.env.HEX_BAINARY_TEST_PATH.trim()) {
    candidates.push(path.resolve(process.env.HEX_BAINARY_TEST_PATH.trim()));
  }
  candidates.push(path.resolve(REPO_ROOT, '../bainary-test'));
  candidates.push(path.resolve(REPO_ROOT, 'tests/bainary-test'));

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Try next candidate path.
    }
  }
  return null;
}

function parseMachO64(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = dv.getUint32(0, true);
  assert.equal(magic, 0xfeedfacf, 'expected 64-bit little-endian Mach-O (MH_MAGIC_64)');

  const ncmds = dv.getUint32(16, true);
  let off = 32;
  const sections = [];
  let imageBase = 0n;
  let textLo = 0n;
  let textHi = 0n;
  let fnStartsOff = 0;
  let fnStartsSize = 0;

  for (let i = 0; i < ncmds; i++) {
    const cmd = dv.getUint32(off, true);
    const cmdsize = dv.getUint32(off + 4, true);
    if (cmd === 0x19) { // LC_SEGMENT_64
      const segname = ASCII_DECODER.decode(bytes.subarray(off + 8, off + 24)).replace(/\0+$/, '');
      const vmaddr = dv.getBigUint64(off + 24, true);
      const nsects = dv.getUint32(off + 64, true);
      if (segname === '__TEXT') imageBase = vmaddr;
      let soff = off + 72;
      for (let j = 0; j < nsects; j++) {
        const sectname = ASCII_DECODER.decode(bytes.subarray(soff, soff + 16)).replace(/\0+$/, '');
        const sseg = ASCII_DECODER.decode(bytes.subarray(soff + 16, soff + 32)).replace(/\0+$/, '');
        const addr = dv.getBigUint64(soff + 32, true);
        const size = dv.getBigUint64(soff + 40, true);
        const foff = dv.getUint32(soff + 48, true);
        const flags = dv.getUint32(soff + 64, true);
        const isZeroFill = (flags & 0xff) === 1; // S_ZEROFILL
        sections.push({
          name: sectname,
          segment: sseg,
          address: addr,
          size: Number(size),
          fileOffset: foff,
          fileSize: isZeroFill ? 0 : Number(size),
        });
        if (sseg === '__TEXT' && sectname === '__text') {
          textLo = addr;
          textHi = addr + size;
        }
        soff += 80;
      }
    } else if (cmd === 0x26) { // LC_FUNCTION_STARTS
      fnStartsOff = dv.getUint32(off + 8, true);
      fnStartsSize = dv.getUint32(off + 12, true);
    }
    off += cmdsize;
  }

  const functions = [];
  if (fnStartsOff > 0 && fnStartsSize > 0 && fnStartsOff + fnStartsSize <= bytes.length) {
    let cur = imageBase;
    let p = fnStartsOff;
    const end = fnStartsOff + fnStartsSize;
    while (p < end) {
      let delta = 0n;
      let shift = 0n;
      while (p < end) {
        const b = bytes[p++];
        delta |= BigInt(b & 0x7f) << shift;
        if ((b & 0x80) === 0) break;
        shift += 7n;
      }
      if (delta === 0n) break;
      cur += delta;
      functions.push(cur);
    }
  }

  return { imageBase, textLo, textHi, sections, functions };
}

describe('bainary-test RTTI / Virtual Tree / Semantic Namer E2E', () => {
  it('runs full synthetic Mach-O ARM64 pipeline end-to-end (CI-compatible)', () => {
    const fx = buildSyntheticStrippedMachO();
    const dataConstSlice = fx.image.bytes.subarray(fx.dataConstOff, fx.dataConstOff + fx.dataConstSize);

    // 1. Vtable scan + stripped RTTI resolution
    const vtRes = scanVtables(dataConstSlice, {
      textLo: fx.textLo,
      textHi: fx.textHi,
      imageBase: fx.imageBase,
      dataVa: fx.dataConstVa,
      ptrSize: 8,
      stripPac: true,
    });
    assert.equal(vtRes.vtables.length, 3, 'should detect all 3 synthetic chained_offset vtables');

    const vtablesWithVa = vtRes.vtables.map((v) => ({
      ...v,
      section: '__DATA_CONST.__const',
      va: fx.dataConstVa + BigInt(v.vtableOff),
    }));

    const cxxRtti = resolveStrippedCxxRtti({
      vtables: vtablesWithVa,
      image: fx.image,
      imageBase: fx.imageBase,
      textLo: fx.textLo,
      textHi: fx.textHi,
      ptrSize: 8,
    });

    assert.equal(cxxRtti.stats.uniqueClasses, 3);
    const slot9Link = cxxRtti.byFunction.get(fx.addrs.fnAbstructSlot9);
    assert.ok(slot9Link, 'slot 9 function should be linked');
    assert.equal(slot9Link.primaryOwner, 'Game::System::Coin::Abstruct');
    assert.equal(slot9Link.slotIndex, 9);
    assert.equal(slot9Link.isShared, false);

    const overrideLink = cxxRtti.byFunction.get(fx.addrs.fnDefaultOverride);
    assert.ok(overrideLink, 'overridden slot 8 function should be linked');
    assert.equal(overrideLink.primaryOwner, 'Game::System::Coin::Default');
    assert.equal(overrideLink.slotIndex, 8);

    // 2. Unified metadata normalization
    const unifiedMetadata = normalizeUnifiedMetadata({ cxxRtti });
    assert.equal(unifiedMetadata.stats.cppClasses, 3);
    assert.equal(
      unifiedMetadata.methodsByFn.get(fx.addrs.fnAbstructSlot9)?.className,
      'Game::System::Coin::Abstruct',
    );

    // 3. Virtual folder tree
    const stringsByFunc = new Map([
      [fx.addrs.fnAbstructSlot9, ['Coin::addCoin', 'player_coin_balance']],
    ]);
    const virtualTree = buildVirtualFolderTree({
      unifiedMetadata,
      cxxRtti,
      functions: fx.functions,
      stringsByFunc,
    });
    assert.equal(
      virtualTree.functionToFolderId.get(fx.addrs.fnAbstructSlot9),
      'Game/System/Coin/Abstruct',
    );
    assert.ok(virtualTree.nodes.has('Game/System/Coin/Abstruct'));
    assert.equal(
      virtualTree.functionToFolderId.get(fx.addrs.fnUnclassified),
      'Unclassified',
    );
    const coinChildren = virtualTree.getChildren('Game/System/Coin', { offset: 0, limit: 20 });
    assert.ok(coinChildren.folders.some((f) => f.label === 'Abstruct'));
    const searchRes = virtualTree.search('Abstruct', { limit: 10 });
    assert.ok(searchRes.matches.some((m) => m.fullPath === 'Game/System/Coin/Abstruct'));

    // 4. Semantic naming & evidence cards
    const rmw = {
      hits: [
        {
          loadOff: Number(fx.addrs.fnAbstructSlot9 - fx.textVa) + 8,
          storeOff: Number(fx.addrs.fnAbstructSlot9 - fx.textVa) + 16,
          arithOff: Number(fx.addrs.fnAbstructSlot9 - fx.textVa) + 12,
          disp: 0x18,
          baseReg: 0,
          opKind: 1,
          clamped: false,
          isFloat: false,
          width: 4,
          flags: 0,
        },
      ],
    };
    const semanticNames = buildSemanticNames({
      virtualTree,
      unifiedMetadata,
      cxxRtti,
      stringsByFunc,
      rmw,
      textVa: fx.textVa,
      functions: fx.functions,
    });
    const slot9Card = semanticNames.byFunction.get(fx.addrs.fnAbstructSlot9);
    assert.ok(slot9Card, 'evidence card should exist for slot 9');
    assert.equal(slot9Card.ownerClass, 'Game::System::Coin::Abstruct');
    assert.equal(slot9Card.naming.confidence, 'high');
    assert.ok(slot9Card.naming.labelJa.length > 0);
    assert.ok(typeof slot9Card.naming.nameEn === 'string' && slot9Card.naming.nameEn.length > 0);

    const unclassifiedCard = semanticNames.byFunction.get(fx.addrs.fnUnclassified);
    assert.ok(unclassifiedCard, 'evidence card should exist for unclassified function');
    assert.equal(unclassifiedCard.naming.confidence, 'low');
    assert.equal(unclassifiedCard.naming.nameEn, null);

    // 5. Class field layout aggregation
    const classFields = aggregateClassFields({
      cxxRtti,
      rmw,
      textVa: fx.textVa,
      functions: fx.functions,
    });
    const abstructLayout = classFields.layouts.get('Game::System::Coin::Abstruct');
    assert.ok(abstructLayout, 'field layout should be aggregated for Abstruct');
    assert.ok(
      abstructLayout.fields.some((f) => f.offset === 0x18 && f.width === 4),
      'expected field at offset 0x18 with width 4',
    );

    // 6. Extended glossary contract & bilingual entries
    assert.equal(GLOSSARY_KEYS.length, 24);
    assert.equal(EXTENDED_GLOSSARY_KEYS.length, 5);
    assert.equal(EXTENDED_GLOSSARY_KEY_SET.size, 5);
    assert.equal(ALL_GLOSSARY_KEYS.length, 29);
    assert.equal(ALL_GLOSSARY_KEY_SET.size, 29);
    assert.equal(listGlossaryEntries().length, 24);
    assert.equal(listGlossaryEntries(null, { includeExtended: true }).length, 29);

    for (const key of EXTENDED_GLOSSARY_KEYS) {
      setLang('ja');
      const jaEntry = getGlossaryEntry(key);
      assert.ok(jaEntry && jaEntry.key === key && jaEntry.explanation.length > 0);
      setLang('en');
      const enEntry = getGlossaryEntry(key);
      assert.ok(enEntry && enEntry.key === key && enEntry.explanation.length > 0);
      assert.notEqual(jaEntry.explanation, enEntry.explanation);
    }
  });

  it('recovers Game::System::Coin::Abstruct (slot 9) and 10k+ classes on real bainary-test within 500ms', (t) => {
    const binPath = resolveBainaryTestPath();
    if (!binPath) {
      t.skip('bainary-test binary not found (set HEX_BAINARY_TEST_PATH or fetch large fixtures)');
      return;
    }

    // Disk I/O + Mach-O header/vtable scan (excluded from compute budget)
    const bytes = new Uint8Array(fs.readFileSync(binPath));
    const parsed = parseMachO64(bytes);
    assert.ok(parsed.functions.length >= 45000, `expected >= 45000 functions, got ${parsed.functions.length}`);

    const aggVtables = [];
    for (const s of parsed.sections) {
      if (
        (s.segment === '__DATA_CONST' || s.segment === '__DATA' || s.segment === '__TEXT')
        && s.name === '__const'
        && s.fileSize >= 16
        && s.fileOffset + s.fileSize <= bytes.length
      ) {
        const slice = bytes.subarray(s.fileOffset, s.fileOffset + s.fileSize);
        const vt = scanVtables(slice, {
          textLo: parsed.textLo,
          textHi: parsed.textHi,
          imageBase: parsed.imageBase,
          dataVa: s.address,
          ptrSize: 8,
          stripPac: true,
        });
        for (let i = 0; i < vt.vtables.length; i++) {
          const v = vt.vtables[i];
          aggVtables.push({
            ...v,
            section: `${s.segment}.${s.name}`,
            va: s.address + BigInt(v.vtableOff),
          });
        }
      }
    }

    // Warm up V8 JIT (1 steady-state pass) so the compute budget measures steady-state algorithm time, not cold JIT startup.
    const warmRtti = resolveStrippedCxxRtti({
      vtables: aggVtables,
      image: { bytes, sections: parsed.sections, imageBase: parsed.imageBase },
      imageBase: parsed.imageBase,
      textLo: parsed.textLo,
      textHi: parsed.textHi,
      ptrSize: 8,
    });
    const warmTree = buildVirtualFolderTree({
      cxxRtti: warmRtti,
      functions: parsed.functions,
    });
    buildSemanticNames({
      virtualTree: warmTree,
      cxxRtti: warmRtti,
      functions: parsed.functions,
    });

    // Measure compute time: resolveStrippedCxxRtti + buildVirtualFolderTree + buildSemanticNames
    const t0 = performance.now();
    const cxxRtti = resolveStrippedCxxRtti({
      vtables: aggVtables,
      image: { bytes, sections: parsed.sections, imageBase: parsed.imageBase },
      imageBase: parsed.imageBase,
      textLo: parsed.textLo,
      textHi: parsed.textHi,
      ptrSize: 8,
    });
    const t1 = performance.now();
    const virtualTree = buildVirtualFolderTree({
      cxxRtti,
      functions: parsed.functions,
    });
    const t2 = performance.now();
    const semanticNames = buildSemanticNames({
      virtualTree,
      cxxRtti,
      functions: parsed.functions,
    });
    const t3 = performance.now();

    const rttiMs = t1 - t0;
    const treeMs = t2 - t1;
    const namerMs = t3 - t2;
    const totalComputeMs = t3 - t0;

    // 1. Target function verification: 0x1001A5384 -> Game::System::Coin::Abstruct (slot 9)
    const targetVa = 0x1001A5384n;
    const targetLink = cxxRtti.byFunction.get(targetVa);
    assert.ok(targetLink, '0x1001A5384n must be linked in cxxRtti.byFunction');
    assert.equal(targetLink.primaryOwner, 'Game::System::Coin::Abstruct');
    assert.equal(targetLink.slotIndex, 9);

    // 2. Scale verification
    assert.ok(
      cxxRtti.stats.uniqueClasses >= 10000,
      `expected >= 10000 unique classes, got ${cxxRtti.stats.uniqueClasses}`,
    );
    assert.ok(
      cxxRtti.stats.linkedFunctions >= 45000,
      `expected >= 45000 linked functions, got ${cxxRtti.stats.linkedFunctions}`,
    );

    // 3. Virtual tree hierarchy verification
    assert.ok(
      virtualTree.nodes.has('Game/System/Coin/Abstruct'),
      'virtualTree must contain Game/System/Coin/Abstruct folder node',
    );
    assert.equal(
      virtualTree.functionToFolderId.get(targetVa),
      'Game/System/Coin/Abstruct',
    );
    assert.equal(
      semanticNames.byFunction.get(targetVa)?.ownerClass,
      'Game::System::Coin::Abstruct',
    );

    // 4. Performance budget verification (<= 500ms)
    assert.ok(
      totalComputeMs <= 500,
      `compute budget exceeded: total=${totalComputeMs.toFixed(1)}ms (rtti=${rttiMs.toFixed(1)}ms, tree=${treeMs.toFixed(1)}ms, namer=${namerMs.toFixed(1)}ms) > 500ms`,
    );

    // 5. Additional authentic recovery: ObjC baseMethods/metaclasses/categories + C++ non-virtual ctors/dtors
    const objcRes = resolveStrippedObjcMethods({
      image: { bytes, sections: parsed.sections, imageBase: parsed.imageBase },
      imageBase: parsed.imageBase,
      textLo: parsed.textLo,
      textHi: parsed.textHi,
      ptrSize: 8,
    });
    assert.ok(objcRes.classes.length >= 3000, `expected >= 3000 ObjC classes, got ${objcRes.classes.length}`);
    assert.ok(objcRes.methodsByIMP.size >= 35000, `expected >= 35000 ObjC methods, got ${objcRes.methodsByIMP.size}`);

    const vtRefRes = resolveVtableRefOwners({
      cxxRtti,
      image: { bytes, sections: parsed.sections, imageBase: parsed.imageBase },
      functions: parsed.functions,
      arch: 'arm64',
    });
    assert.ok(vtRefRes.stats.resolvedUnique >= 3500, `expected >= 3500 unique C++ ctors/dtors, got ${vtRefRes.stats.resolvedUnique}`);
  });
});

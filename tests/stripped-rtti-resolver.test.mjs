import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveStrippedCxxRtti,
  decodeStrippedPointer,
  splitCppClassPath,
} from '../js/analysis/cxx/stripped-rtti-resolver.js';

function writeCString(buf, off, str) {
  for (let i = 0; i < str.length; i++) buf[off + i] = str.charCodeAt(i);
  buf[off + str.length] = 0;
}

function encodeChainedOffset64(va, imageBase) {
  return (va - imageBase) & 0xfffffffffn;
}

function encodeChainedBind64(ordinal) {
  return (1n << 63n) | (BigInt(ordinal) & 0xffffffn);
}

describe('stripped-rtti-resolver (Track T1)', () => {
  it('handles empty / null / invalid inputs safely (fail-closed)', () => {
    for (const input of [undefined, null, {}, { vtables: [] }]) {
      const res = resolveStrippedCxxRtti(input);
      assert.equal(res.classes.length, 0);
      assert.equal(res.byFunction.size, 0);
      assert.equal(res.byRttiVa.size, 0);
      assert.equal(res.completeness, 'complete');
      assert.equal(res.truncated, false);
    }
  });

  it('decodes Mach-O chained_offset (format 6), arm64e (format 1/7/12), relative32, and PAC pointers', () => {
    const imageBase = 0x100000000n;

    // Format 6 rebase & bind
    const f6Rebase = decodeStrippedPointer(encodeChainedOffset64(0x1001A5384n, imageBase), 0x100200000n, {
      encoding: 'chained_offset',
      pointerFormat: 6,
      imageBase,
    });
    assert.equal(f6Rebase.isBind, false);
    assert.equal(f6Rebase.va, 0x1001A5384n);

    const f6Bind = decodeStrippedPointer(encodeChainedBind64(42), 0x100200000n, {
      encoding: 'chained_offset',
      pointerFormat: 6,
      imageBase,
    });
    assert.equal(f6Bind.isBind, true);
    assert.equal(f6Bind.ordinal, 42);

    // arm64e format 12: auth rebase (bit63=1, bit62=0), unauth rebase (bit63=0, bit62=0), bind (bit62=1)
    const authRebase = decodeStrippedPointer((1n << 63n) | 0x12340n, 0x100200000n, {
      pointerFormat: 12,
      imageBase,
    });
    assert.equal(authRebase.isBind, false);
    assert.equal(authRebase.va, imageBase + 0x12340n);

    const unauthRebase = decodeStrippedPointer(0x55000n, 0x100200000n, {
      pointerFormat: 12,
      imageBase,
    });
    assert.equal(unauthRebase.isBind, false);
    assert.equal(unauthRebase.va, imageBase + 0x55000n);

    const arm64eBind = decodeStrippedPointer((1n << 62n) | 0x12345n, 0x100200000n, {
      pointerFormat: 12,
      imageBase,
    });
    assert.equal(arm64eBind.isBind, true);
    assert.equal(arm64eBind.ordinal, 0x12345);

    const arm64eBindFmt7 = decodeStrippedPointer((1n << 62n) | 0x12345n, 0x100200000n, {
      pointerFormat: 7,
      imageBase,
    });
    assert.equal(arm64eBindFmt7.isBind, true);
    assert.equal(arm64eBindFmt7.ordinal, 0x2345); // 16-bit mask for format 7

    // relative32
    const rel = decodeStrippedPointer(BigInt.asUintN(32, -0x100n), 0x100001000n, {
      encoding: 'relative32',
    });
    assert.equal(rel.isBind, false);
    assert.equal(rel.va, 0x100000f00n);

    // PAC strip on absolute
    const pac = decodeStrippedPointer(0xabcd0001001A5384n, 0x100200000n, {
      encoding: 'absolute',
      stripPac: true,
    });
    assert.equal(pac.va, 0x1001A5384n);
  });

  it('resolves stripped Mach-O chained_offset RTTI, single/VMI inheritance, pure virtual slots, primaryOwner, and ICF sharing', () => {
    const imageBase = 0x100000000n;
    const textLo = 0x100001000n;
    const textHi = 0x100010000n;
    const cstrVa = 0x100020000n;
    const constVa = 0x100030000n;

    const bytes = new Uint8Array(0x4000);
    const dv = new DataView(bytes.buffer);
    const cstrOff = 0x0000;
    const constOff = 0x1000;

    // _ZTS strings
    writeCString(bytes, cstrOff + 0x00, 'N4Game6System4Coin8AbstructE');
    writeCString(bytes, cstrOff + 0x40, 'N4Game6System4Coin7DerivedE');
    writeCString(bytes, cstrOff + 0x80, 'N4Game5Audio5MixerE');
    writeCString(bytes, cstrOff + 0xc0, 'N4Game5Multi3SubE');

    const tiBaseVa = constVa + 0x000n;
    const tiDerivedVa = constVa + 0x040n;
    const tiAudioVa = constVa + 0x080n;
    const tiVmiVa = constVa + 0x0c0n;

    // Base typeinfo (__class_type_info, vptr is chained bind ordinal 1)
    dv.setBigUint64(constOff + 0x000, encodeChainedBind64(1), true);
    dv.setBigUint64(constOff + 0x008, encodeChainedOffset64(cstrVa + 0x00n, imageBase), true);

    // Derived typeinfo (__si_class_type_info -> Base)
    dv.setBigUint64(constOff + 0x040, encodeChainedBind64(2), true);
    dv.setBigUint64(constOff + 0x048, encodeChainedOffset64(cstrVa + 0x40n, imageBase), true);
    dv.setBigUint64(constOff + 0x050, encodeChainedOffset64(tiBaseVa, imageBase), true);

    // Unrelated Audio::Mixer typeinfo (__class_type_info)
    dv.setBigUint64(constOff + 0x080, encodeChainedBind64(1), true);
    dv.setBigUint64(constOff + 0x088, encodeChainedOffset64(cstrVa + 0x80n, imageBase), true);

    // VMI multiple inheritance typeinfo: Multi::Sub inherits from Base + Audio::Mixer
    dv.setBigUint64(constOff + 0x0c0, encodeChainedBind64(3), true);
    dv.setBigUint64(constOff + 0x0c8, encodeChainedOffset64(cstrVa + 0xc0n, imageBase), true);
    dv.setUint32(constOff + 0x0d0, 0, true); // flags
    dv.setUint32(constOff + 0x0d4, 2, true); // base_count = 2
    dv.setBigUint64(constOff + 0x0d8, encodeChainedOffset64(tiBaseVa, imageBase), true);
    dv.setBigInt64(constOff + 0x0e0, 0x02n, true); // offset 0, public
    dv.setBigUint64(constOff + 0x0e8, encodeChainedOffset64(tiAudioVa, imageBase), true);
    dv.setBigInt64(constOff + 0x0f0, (0x10n << 8n) | 0x02n, true); // offset 0x10, public

    // Function VAs
    const fnInherited = 0x100002000n;
    const fnOverridden = 0x100002040n;
    const fnSharedIcf = 0x100002080n;
    const fnAfterPure = 0x1000020c0n;

    // Base vtable at constOff + 0x200: [fnInherited, pureVirtualBind, fnAfterPure]
    const vtBaseOff = 0x200;
    dv.setBigUint64(constOff + vtBaseOff + 0, encodeChainedOffset64(fnInherited, imageBase), true);
    dv.setBigUint64(constOff + vtBaseOff + 8, encodeChainedBind64(99), true); // pure virtual bind
    dv.setBigUint64(constOff + vtBaseOff + 16, encodeChainedOffset64(fnAfterPure, imageBase), true);

    // Derived vtable at constOff + 0x240: [fnInherited, fnOverridden, fnSharedIcf]
    const vtDerivedOff = 0x240;
    dv.setBigUint64(constOff + vtDerivedOff + 0, encodeChainedOffset64(fnInherited, imageBase), true);
    dv.setBigUint64(constOff + vtDerivedOff + 8, encodeChainedOffset64(fnOverridden, imageBase), true);
    dv.setBigUint64(constOff + vtDerivedOff + 16, encodeChainedOffset64(fnSharedIcf, imageBase), true);

    // Audio vtable at constOff + 0x280: [fnSharedIcf]
    const vtAudioOff = 0x280;
    dv.setBigUint64(constOff + vtAudioOff + 0, encodeChainedOffset64(fnSharedIcf, imageBase), true);

    // VMI vtable at constOff + 0x2c0: [fnInherited]
    const vtVmiOff = 0x2c0;
    dv.setBigUint64(constOff + vtVmiOff + 0, encodeChainedOffset64(fnInherited, imageBase), true);

    const image = {
      bytes,
      imageBase,
      sections: [
        { name: '__cstring', segname: '__TEXT', addr: cstrVa, size: 0x1000, offset: cstrOff, fileSize: 0x1000 },
        { name: '__const', segname: '__DATA_CONST', addr: constVa, size: 0x2000, offset: constOff, fileSize: 0x2000 },
      ],
    };

    const res = resolveStrippedCxxRtti({
      vtables: [
        { vtableOff: vtBaseOff, va: constVa + BigInt(vtBaseOff), entryCount: 3, offsetToTop: 0, hasRtti: true, rttiVa: tiBaseVa, encoding: 'chained_offset' },
        { vtableOff: vtDerivedOff, va: constVa + BigInt(vtDerivedOff), entryCount: 3, offsetToTop: 0, hasRtti: true, rttiVa: tiDerivedVa, encoding: 'chained_offset' },
        { vtableOff: vtAudioOff, va: constVa + BigInt(vtAudioOff), entryCount: 1, offsetToTop: 0, hasRtti: true, rttiVa: tiAudioVa, encoding: 'chained_offset' },
        { vtableOff: vtVmiOff, va: constVa + BigInt(vtVmiOff), entryCount: 1, offsetToTop: 0, hasRtti: true, rttiVa: tiVmiVa, encoding: 'chained_offset' },
      ],
      image,
      imageBase,
      textLo,
      textHi,
      pointerFormat: 6,
    });

    assert.equal(res.stats.uniqueClasses, 4);
    assert.equal(res.completeness, 'complete');

    // Inherited function across Base, Derived, VMI -> primaryOwner must be ancestor Base
    const inhLink = res.byFunction.get(fnInherited);
    assert.equal(inhLink.primaryOwner, 'Game::System::Coin::Abstruct');
    assert.equal(inhLink.isShared, false);
    assert.equal(inhLink.slotIndex, 0);

    // Pure virtual bind at slot 1 must not shift fnAfterPure from slot 2
    const afterPureLink = res.byFunction.get(fnAfterPure);
    assert.equal(afterPureLink.primaryOwner, 'Game::System::Coin::Abstruct');
    assert.equal(afterPureLink.slotIndex, 2);

    // Overridden method belongs to Derived
    const ovLink = res.byFunction.get(fnOverridden);
    assert.equal(ovLink.primaryOwner, 'Game::System::Coin::Derived');
    assert.equal(ovLink.slotIndex, 1);

    // Unrelated ICF sharing between Derived and Audio::Mixer -> primaryOwner null, isShared true
    const sharedLink = res.byFunction.get(fnSharedIcf);
    assert.equal(sharedLink.primaryOwner, null);
    assert.equal(sharedLink.isShared, true);
    assert.deepEqual(sharedLink.sharedOwners, ['Game::Audio::Mixer', 'Game::System::Coin::Derived']);

    // VMI class resolved both base classes
    const vmiCls = res.byRttiVa.get(tiVmiVa);
    assert.deepEqual(vmiCls.baseClassNames, ['Game::System::Coin::Abstruct', 'Game::Audio::Mixer']);
  });

  it('guards against cyclic inheritance (A -> B -> A) without infinite loops', () => {
    const cstrVa = 0x20000n;
    const constVa = 0x30000n;
    const bytes = new Uint8Array(0x2000);
    const dv = new DataView(bytes.buffer);
    writeCString(bytes, 0x00, '1A');
    writeCString(bytes, 0x10, '1B');

    // A -> B and B -> A cycle
    const tiA = constVa + 0x00n;
    const tiB = constVa + 0x40n;
    dv.setBigUint64(0x1000 + 0x08, cstrVa + 0x00n, true);
    dv.setBigUint64(0x1000 + 0x10, tiB, true);
    dv.setBigUint64(0x1000 + 0x48, cstrVa + 0x10n, true);
    dv.setBigUint64(0x1000 + 0x50, tiA, true);

    const fn = 0x10000n;
    dv.setBigUint64(0x1000 + 0x80, fn, true);
    dv.setBigUint64(0x1000 + 0x90, fn, true);

    const res = resolveStrippedCxxRtti({
      vtables: [
        { vtableOff: 0x80, va: constVa + 0x80n, entryCount: 1, offsetToTop: 0, hasRtti: true, rttiVa: tiA, encoding: 'absolute' },
        { vtableOff: 0x90, va: constVa + 0x90n, entryCount: 1, offsetToTop: 0, hasRtti: true, rttiVa: tiB, encoding: 'absolute' },
      ],
      image: {
        bytes,
        sections: [
          { name: '__cstring', va: cstrVa, fileOffset: 0, size: 0x1000 },
          { name: '__const', va: constVa, fileOffset: 0x1000, size: 0x1000 },
        ],
      },
      textLo: 0x10000n,
      textHi: 0x11000n,
    });

    assert.equal(res.stats.uniqueClasses, 2);
    assert.equal(res.byFunction.get(fn).isShared, true);
  });

  it('rejects zerofill sections, non-ASCII _ZTS, and splits template names safely', () => {
    assert.deepEqual(
      splitCppClassPath('std::vector<Game::Item>::iterator'),
      ['std', 'vector<Game::Item>', 'iterator'],
    );

    const bytes = new Uint8Array(0x100);
    const dv = new DataView(bytes.buffer);
    // Non-ASCII _ZTS
    bytes[0] = 0xff;
    bytes[1] = 0xfe;
    bytes[2] = 0;
    dv.setBigUint64(0x28, 0x10000n, true);

    const res = resolveStrippedCxxRtti({
      vtables: [
        { vtableOff: 0x40, va: 0x10040n, entryCount: 1, offsetToTop: 0, hasRtti: true, rttiVa: 0x10020n, encoding: 'absolute' },
        // Zerofill section reference (fileSize = 0)
        { vtableOff: 0x0, va: 0x90000n, entryCount: 1, offsetToTop: 0, hasRtti: true, rttiVa: 0x90020n, encoding: 'absolute' },
      ],
      image: {
        bytes,
        sections: [
          { name: '__const', va: 0x10000n, fileOffset: 0, size: 0x100, fileSize: 0x100 },
          { name: '__bss', va: 0x90000n, fileOffset: 0, size: 0x1000, fileSize: 0 },
        ],
      },
      textLo: 0x2000n,
      textHi: 0x3000n,
    });

    assert.equal(res.stats.uniqueClasses, 0);
  });

  it('merges mixed chained_offset + absolute duplicate fnVa and enforces LazyRttiFunctionMap & FastFuncLink contracts', () => {
    const imageBase = 0x100000000n;
    const textLo = 0x100001000n;
    const textHi = 0x100010000n;
    const cstrVa = 0x100020000n;
    const constVa = 0x100030000n;
    const bytes = new Uint8Array(0x4000);
    const dv = new DataView(bytes.buffer);
    const cstrOff = 0x0000;
    const constOff = 0x1000;

    writeCString(bytes, cstrOff + 0x00, 'N4Game5AlphaE');
    writeCString(bytes, cstrOff + 0x40, 'N4Game4BetaE');

    const tiAlpha = constVa + 0x000n;
    const tiBeta = constVa + 0x040n;
    dv.setBigUint64(constOff + 0x000, encodeChainedBind64(1), true);
    dv.setBigUint64(constOff + 0x008, encodeChainedOffset64(cstrVa + 0x00n, imageBase), true);
    dv.setBigUint64(constOff + 0x040, 0n, true);
    dv.setBigUint64(constOff + 0x048, cstrVa + 0x40n, true);

    const fnShared = 0x100002000n;
    const fnOnlyA = 0x100002040n;
    // Alpha vtable uses chained_offset
    dv.setBigUint64(constOff + 0x200, encodeChainedOffset64(fnShared, imageBase), true);
    dv.setBigUint64(constOff + 0x208, encodeChainedOffset64(fnOnlyA, imageBase), true);
    // Beta vtable uses absolute encoding for the same fnShared
    dv.setBigUint64(constOff + 0x240, fnShared, true);

    const res = resolveStrippedCxxRtti({
      vtables: [
        { vtableOff: 0x200, va: constVa + 0x200n, entryCount: 2, offsetToTop: 0, hasRtti: true, rttiVa: tiAlpha, encoding: 'chained_offset' },
        { vtableOff: 0x240, va: constVa + 0x240n, entryCount: 1, offsetToTop: 0, hasRtti: true, rttiVa: tiBeta, encoding: 'absolute' },
      ],
      image: {
        bytes,
        imageBase,
        sections: [
          { name: '__cstring', segname: '__TEXT', addr: cstrVa, size: 0x1000, offset: cstrOff, fileSize: 0x1000 },
          { name: '__const', segname: '__DATA_CONST', addr: constVa, size: 0x2000, offset: constOff, fileSize: 0x2000 },
        ],
      },
      imageBase,
      textLo,
      textHi,
      pointerFormat: 6,
    });

    // Mixed encoding duplicate fnShared must be merged as ICF-shared across Alpha and Beta
    assert.equal(res.byFunction.size, 2);
    const shared = res.byFunction.get(fnShared);
    assert.equal(shared.primaryOwner, null);
    assert.equal(shared.isShared, true);
    assert.deepEqual(shared.sharedOwners, ['Game::Alpha', 'Game::Beta']);

    // FastFuncLink must not leak internal state via Object.keys
    const onlyA = res.byFunction.get(fnOnlyA);
    assert.equal(onlyA.primaryOwner, 'Game::Alpha');
    assert.equal(Object.keys(onlyA).includes('_headPos'), false);
    assert.equal(Object.keys(onlyA).includes('_allOwnersCache'), false);

    // LazyRttiFunctionMap Map contract: delete / set / clear
    assert.equal(res.byFunction.delete(fnOnlyA), true);
    assert.equal(res.byFunction.has(fnOnlyA), false);
    assert.equal(res.byFunction.size, 1);
    res.byFunction.set(fnOnlyA, onlyA);
    assert.equal(res.byFunction.size, 2);
    res.byFunction.clear();
    assert.equal(res.byFunction.size, 0);
    assert.equal(res.byFunction.has(fnShared), false);
  });
});

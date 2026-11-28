import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolveStrippedObjcMethods } from '../js/analysis/apple/objc-method-resolver.js';

function writeCString(buf, off, str) {
  for (let i = 0; i < str.length; i++) buf[off + i] = str.charCodeAt(i);
  buf[off + str.length] = 0;
}

function encodeChainedOffset(va, imageBase) {
  return (va - imageBase) & 0xfffffffffn;
}

describe('objc-method-resolver', () => {
  it('fails closed on null, undefined, or empty inputs', () => {
    for (const input of [undefined, null, {}, { image: { bytes: new Uint8Array(8), sections: [] } }]) {
      const res = resolveStrippedObjcMethods(input);
      assert.equal(res.classes.length, 0);
      assert.equal(res.methodsByIMP.size, 0);
      assert.equal(res.completeness, 'complete');
      assert.equal(res.truncated, false);
    }
  });

  it('recovers ObjC classes, metaclasses (+), categories, relative method lists, and large method lists', () => {
    const imageBase = 0x100000000n;
    const textOff = 0x1000;
    const textVa = imageBase + BigInt(textOff);
    const cstrOff = 0x2000;
    const cstrVa = imageBase + BigInt(cstrOff);
    const dataOff = 0x3000;
    const dataVa = imageBase + BigInt(dataOff);

    const bytes = new Uint8Array(0x6000);
    const dv = new DataView(bytes.buffer);

    // Strings in __cstring
    writeCString(bytes, cstrOff + 0x00, 'CoinManager');
    writeCString(bytes, cstrOff + 0x20, 'NSObject');
    writeCString(bytes, cstrOff + 0x40, 'addCoins:');
    writeCString(bytes, cstrOff + 0x60, 'sharedManager');
    writeCString(bytes, cstrOff + 0x80, 'resetCoins');

    // Selref pointer at dataOff + 0x00 -> 'addCoins:'
    const selrefAddVa = dataVa + 0x00n;
    dv.setBigUint64(dataOff + 0x00, encodeChainedOffset(cstrVa + 0x40n, imageBase), true);

    // Function IMPs in __text
    const fnAddCoins = textVa + 0x100n;
    const fnSharedMgr = textVa + 0x200n;
    const fnResetCoins = textVa + 0x300n;
    const fnOutOfRange = textVa + 0x9000n; // outside __text

    // Relative small method_list_t for CoinManager instance methods at dataOff + 0x100
    // entsize = 12 | 0x80000000, count = 2 (second is OOB and must be skipped)
    const instListOff = dataOff + 0x100;
    const instListVa = dataVa + 0x100n;
    dv.setUint32(instListOff + 0, 0x80000000 | 12, true);
    dv.setUint32(instListOff + 4, 2, true);
    // Entry 0: name_rel -> selrefAddVa, types_rel = 0, imp_rel -> fnAddCoins
    const entry0Va = instListVa + 8n;
    dv.setInt32(instListOff + 8, Number(selrefAddVa - entry0Va), true);
    dv.setInt32(instListOff + 12, 0, true);
    dv.setInt32(instListOff + 16, Number(fnAddCoins - (entry0Va + 8n)), true);
    // Entry 1: out of __text -> must be rejected
    const entry1Va = instListVa + 20n;
    dv.setInt32(instListOff + 20, Number(selrefAddVa - entry1Va), true);
    dv.setInt32(instListOff + 24, 0, true);
    dv.setInt32(instListOff + 28, Number(fnOutOfRange - (entry1Va + 8n)), true);

    // Large 64-bit method_list_t for MetaClass (+sharedManager) at dataOff + 0x180
    const metaListOff = dataOff + 0x180;
    const metaListVa = dataVa + 0x180n;
    dv.setUint32(metaListOff + 0, 24, true);
    dv.setUint32(metaListOff + 4, 1, true);
    dv.setBigUint64(metaListOff + 8, encodeChainedOffset(cstrVa + 0x60n, imageBase), true);
    dv.setBigUint64(metaListOff + 16, 0n, true);
    dv.setBigUint64(metaListOff + 24, encodeChainedOffset(fnSharedMgr, imageBase), true);

    // Category relative method_list_t (+resetCoins) at dataOff + 0x200
    const catListMOff = dataOff + 0x200;
    const catListMVa = dataVa + 0x200n;
    dv.setUint32(catListMOff + 0, 0x80000000 | 12, true);
    dv.setUint32(catListMOff + 4, 1, true);
    const catEntryVa = catListMVa + 8n;
    dv.setInt32(catListMOff + 8, Number((cstrVa + 0x80n) - catEntryVa), true); // direct cstring
    dv.setInt32(catListMOff + 16, Number(fnResetCoins - (catEntryVa + 8n)), true);

    // class_ro_t for CoinManager at dataOff + 0x300
    const roOff = dataOff + 0x300;
    const roVa = dataVa + 0x300n;
    dv.setBigUint64(roOff + 24, encodeChainedOffset(cstrVa + 0x00n, imageBase), true);
    dv.setBigUint64(roOff + 32, encodeChainedOffset(instListVa, imageBase), true);

    // class_ro_t for MetaClass at dataOff + 0x380
    const metaRoOff = dataOff + 0x380;
    const metaRoVa = dataVa + 0x380n;
    dv.setBigUint64(metaRoOff + 24, encodeChainedOffset(cstrVa + 0x00n, imageBase), true);
    dv.setBigUint64(metaRoOff + 32, encodeChainedOffset(metaListVa, imageBase), true);

    // SuperClass NSObject + its ro at dataOff + 0x400 / 0x440
    const superRoOff = dataOff + 0x400;
    const superRoVa = dataVa + 0x400n;
    dv.setBigUint64(superRoOff + 24, encodeChainedOffset(cstrVa + 0x20n, imageBase), true);
    const superClsOff = dataOff + 0x440;
    const superClsVa = dataVa + 0x440n;
    dv.setBigUint64(superClsOff + 32, encodeChainedOffset(superRoVa, imageBase), true);

    // MetaClass class_t at dataOff + 0x480
    const metaClsOff = dataOff + 0x480;
    const metaClsVa = dataVa + 0x480n;
    dv.setBigUint64(metaClsOff + 32, encodeChainedOffset(metaRoVa, imageBase), true);

    // CoinManager class_t at dataOff + 0x500
    const clsOff = dataOff + 0x500;
    const clsVa = dataVa + 0x500n;
    dv.setBigUint64(clsOff + 0, encodeChainedOffset(metaClsVa, imageBase), true);
    dv.setBigUint64(clsOff + 8, encodeChainedOffset(superClsVa, imageBase), true);
    dv.setBigUint64(clsOff + 32, encodeChainedOffset(roVa, imageBase) | 1n, true); // swift/tagged low bit

    // category_t at dataOff + 0x580
    const catOff = dataOff + 0x580;
    const catVa = dataVa + 0x580n;
    dv.setBigUint64(catOff + 8, encodeChainedOffset(clsVa, imageBase), true);
    dv.setBigUint64(catOff + 16, encodeChainedOffset(catListMVa, imageBase), true);

    // __objc_classlist at dataOff + 0x600 (1 entry)
    const classListOff = dataOff + 0x600;
    const classListVa = dataVa + 0x600n;
    dv.setBigUint64(classListOff, encodeChainedOffset(clsVa, imageBase), true);

    // __objc_catlist at dataOff + 0x620 (1 entry)
    const catListOff = dataOff + 0x620;
    const catListVa = dataVa + 0x620n;
    dv.setBigUint64(catListOff, encodeChainedOffset(catVa, imageBase), true);

    const sections = [
      { name: '__text', segment: '__TEXT', address: textVa, size: 0x1000, fileOffset: textOff, fileSize: 0x1000 },
      { name: '__cstring', segment: '__TEXT', address: cstrVa, size: 0x1000, fileOffset: cstrOff, fileSize: 0x1000 },
      { name: '__const', segment: '__DATA_CONST', address: dataVa, size: 0x600, fileOffset: dataOff, fileSize: 0x600 },
      { name: '__objc_classlist', segment: '__DATA_CONST', address: classListVa, size: 8, fileOffset: classListOff, fileSize: 8 },
      { name: '__objc_catlist', segment: '__DATA_CONST', address: catListVa, size: 8, fileOffset: catListOff, fileSize: 8 },
    ];

    const res = resolveStrippedObjcMethods({
      image: { bytes, sections, imageBase },
      imageBase,
      textLo: textVa,
      textHi: textVa + 0x1000n,
      ptrSize: 8,
    });

    assert.equal(res.completeness, 'complete');
    assert.equal(res.classes.length, 1);
    const cls = res.classes[0];
    assert.equal(cls.className, 'CoinManager');
    assert.equal(cls.superClass, 'NSObject');
    assert.equal(cls.methods.length, 2);
    assert.equal(cls.classMethods.length, 1);

    assert.equal(res.methodsByIMP.get(fnAddCoins)?.selector, 'addCoins:');
    assert.equal(res.methodsByIMP.get(fnAddCoins)?.classMethod, false);
    assert.equal(res.methodsByIMP.get(fnSharedMgr)?.selector, 'sharedManager');
    assert.equal(res.methodsByIMP.get(fnSharedMgr)?.classMethod, true);
    assert.equal(res.methodsByIMP.get(fnResetCoins)?.selector, 'resetCoins');
    assert.equal(res.methodsByIMP.has(fnOutOfRange), false);
  });

  it('rejects prototype-polluting class names safely', () => {
    const imageBase = 0x100000000n;
    const bytes = new Uint8Array(0x4000);
    const dv = new DataView(bytes.buffer);
    writeCString(bytes, 0x2000, '__proto__');
    dv.setBigUint64(0x3000 + 24, encodeChainedOffset(imageBase + 0x2000n, imageBase), true);
    dv.setBigUint64(0x3100 + 32, encodeChainedOffset(imageBase + 0x3000n, imageBase), true);
    dv.setBigUint64(0x3200, encodeChainedOffset(imageBase + 0x3100n, imageBase), true);

    const res = resolveStrippedObjcMethods({
      image: {
        bytes,
        imageBase,
        sections: [
          { name: '__text', segment: '__TEXT', address: imageBase + 0x1000n, size: 0x1000, fileOffset: 0x1000, fileSize: 0x1000 },
          { name: '__cstring', segment: '__TEXT', address: imageBase + 0x2000n, size: 0x1000, fileOffset: 0x2000, fileSize: 0x1000 },
          { name: '__const', segment: '__DATA', address: imageBase + 0x3000n, size: 0x200, fileOffset: 0x3000, fileSize: 0x200 },
          { name: '__objc_classlist', segment: '__DATA', address: imageBase + 0x3200n, size: 8, fileOffset: 0x3200, fileSize: 8 },
        ],
      },
      imageBase,
      textLo: imageBase + 0x1000n,
      textHi: imageBase + 0x2000n,
    });

    assert.equal(res.classes.length, 0);
    assert.equal(({}).polluted, undefined);
  });
});

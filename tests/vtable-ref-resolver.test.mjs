import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolveVtableRefOwners } from '../js/analysis/cxx/vtable-ref-resolver.js';

function encodeAdrp(rd, pcVa, targetVa) {
  const pcPage = pcVa & ~0xfffn;
  const targetPage = targetVa & ~0xfffn;
  const deltaPages = Number((targetPage - pcPage) >> 12n);
  const immlo = deltaPages & 0x3;
  const immhi = (deltaPages >>> 2) & 0x7ffff;
  return (0x90000000 | (immlo << 29) | (immhi << 5) | (rd & 31)) >>> 0;
}

function encodeAddImm12(rd, rn, imm12) {
  return (0x91000000 | ((imm12 & 0xfff) << 10) | ((rn & 31) << 5) | (rd & 31)) >>> 0;
}

describe('vtable-ref-resolver', () => {
  it('fails closed on null, empty, or non-ARM64 inputs', () => {
    for (const input of [undefined, null, {}, { arch: 'x86_64', cxxRtti: { classes: [{ className: 'A', vtableVas: [{ va: 0x2000n }] }] } }]) {
      const res = resolveVtableRefOwners(input);
      assert.equal(res.addedByFunction.size, 0);
      assert.equal(res.stats.resolvedUnique, 0);
    }
  });

  it('resolves unique constructors, most-derived inheritance-chain constructors, unrelated factories as shared, and preserves existing RTTI slots', () => {
    const textVa = 0x100004000n;
    const vtBaseVa = 0x100020100n;
    const vtDerivedVa = 0x100020200n;
    const vtOtherVa = 0x100020300n;

    const codeBytes = new Uint8Array(0x400);
    const dv = new DataView(codeBytes.buffer);

    const fnExisting = textVa + 0x00n;
    const fnSingleCtor = textVa + 0x40n;
    const fnDerivedCtor = textVa + 0x80n;
    const fnFactory = textVa + 0xc0n;

    // 1. Existing RTTI function (must NOT be overwritten)
    dv.setUint32(0x00, encodeAdrp(8, fnExisting, vtDerivedVa), true);
    dv.setUint32(0x04, encodeAddImm12(8, 8, Number(vtDerivedVa & 0xfffn)), true);

    // 2. Single-class constructor -> Base
    dv.setUint32(0x40, encodeAdrp(8, fnSingleCtor, vtBaseVa), true);
    dv.setUint32(0x44, encodeAddImm12(8, 8, Number(vtBaseVa & 0xfffn)), true);

    // 3. Derived constructor references Base vtable first, then Derived vtable -> resolves to Derived
    dv.setUint32(0x80, encodeAdrp(8, fnDerivedCtor, vtBaseVa), true);
    dv.setUint32(0x84, encodeAddImm12(8, 8, Number(vtBaseVa & 0xfffn)), true);
    dv.setUint32(0x88, encodeAdrp(9, fnDerivedCtor + 8n, vtDerivedVa), true);
    dv.setUint32(0x8c, encodeAddImm12(9, 9, Number(vtDerivedVa & 0xfffn)), true);

    // 4. Factory references unrelated Base + Other -> primaryOwner: null, isShared: true
    dv.setUint32(0xc0, encodeAdrp(8, fnFactory, vtBaseVa), true);
    dv.setUint32(0xc4, encodeAddImm12(8, 8, Number(vtBaseVa & 0xfffn)), true);
    dv.setUint32(0xc8, encodeAdrp(9, fnFactory + 8n, vtOtherVa), true);
    dv.setUint32(0xcc, encodeAddImm12(9, 9, Number(vtOtherVa & 0xfffn)), true);

    const cxxRtti = {
      classes: [
        { className: 'Game::Base', rttiVa: 0x100030000n, vtableVas: [{ va: vtBaseVa }], baseClassNames: [] },
        { className: 'Game::Derived', rttiVa: 0x100030100n, vtableVas: [{ va: vtDerivedVa }], baseClassNames: ['Game::Base'] },
        { className: 'Game::Other', rttiVa: 0x100030200n, vtableVas: [{ va: vtOtherVa }], baseClassNames: [] },
      ],
      byFunction: new Map([
        [fnExisting, { fnVa: fnExisting, primaryOwner: 'Game::Base', slotIndex: 0 }],
      ]),
    };

    const res = resolveVtableRefOwners({
      cxxRtti,
      codeBytes,
      textVa,
      functions: [
        { start: fnExisting, end: fnSingleCtor },
        { start: fnSingleCtor, end: fnDerivedCtor },
        { start: fnDerivedCtor, end: fnFactory },
        { start: fnFactory, end: textVa + 0x100n },
      ],
      arch: 'arm64',
    });

    assert.equal(res.addedByFunction.has(fnExisting), false);

    const single = res.addedByFunction.get(fnSingleCtor);
    assert.equal(single.primaryOwner, 'Game::Base');
    assert.equal(single.isShared, false);
    assert.equal(single.isVtableRef, true);

    const derived = res.addedByFunction.get(fnDerivedCtor);
    assert.equal(derived.primaryOwner, 'Game::Derived');
    assert.equal(derived.isShared, false);

    const factory = res.addedByFunction.get(fnFactory);
    assert.equal(factory.primaryOwner, null);
    assert.equal(factory.isShared, true);
    assert.deepEqual(factory.sharedOwners, ['Game::Base', 'Game::Other']);

    assert.equal(res.stats.resolvedUnique, 2);
    assert.equal(res.stats.resolvedShared, 1);
  });
});

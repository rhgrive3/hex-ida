import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { aggregateClassFields } from '../js/analysis/cxx/class-field-aggregator.js';

describe('class-field-aggregator (Track T8)', () => {
  it('returns empty fail-closed result on null, undefined, or empty inputs', () => {
    for (const input of [undefined, null, {}, { cxxRtti: null }, { cxxRtti: { classes: [] } }]) {
      const res = aggregateClassFields(input);
      assert.equal(res.layouts instanceof Map, true);
      assert.equal(res.layouts.size, 0);
      assert.equal(res.completeness, 'complete');
      assert.equal(res.truncated, false);
      assert.deepEqual(res.stats, {
        classesProcessed: 0,
        classesWithFields: 0,
        totalFields: 0,
      });
    }
  });

  it('aggregates accessesByFunc across Map<bigint>, Map<string>, and hex Record with confidence tiers', () => {
    const fnA = 0x1001a5000n;
    const fnB = 0x1001a5100n;
    const fnC = 0x1001a5200n;

    const cxxRtti = {
      classes: [
        {
          className: 'Game::System::Coin',
          methods: [
            { fnVa: fnA, slotIndex: 0 },
            { fnVa: fnB, slotIndex: 1 },
            { fnVa: fnC, slotIndex: 2 },
          ],
        },
      ],
    };

    // Map<bigint>
    const mapBig = new Map([
      [fnA, [
        { offset: 0x18, width: 4, kind: 'read', typeHint: 'int32' },
        { offset: 0x20, width: 8, kind: 'write', typeHint: 'ptr' },
        { offset: 0x20, width: 8, kind: 'read', typeHint: 'ptr' },
        { offset: 0x30, width: 4, kind: 'read' },
      ]],
      [fnB, [
        { offset: 0x18, width: 4, kind: 'write', typeHint: 'int32' },
        { offset: 0x18, width: 8, kind: 'read', typeHint: 'int64' },
      ]],
    ]);

    const res1 = aggregateClassFields({ cxxRtti, accessesByFunc: mapBig });
    assert.equal(res1.stats.classesProcessed, 1);
    assert.equal(res1.stats.classesWithFields, 1);
    assert.equal(res1.stats.totalFields, 3);

    const layout = res1.layouts.get('Game::System::Coin');
    assert.ok(layout);
    assert.equal(layout.className, 'Game::System::Coin');
    assert.equal(layout.methodCount, 3);
    assert.deepEqual(layout.fields.map((f) => f.offset), [0x18, 0x20, 0x30]);

    // 0x18: accessed by fnA and fnB -> high confidence, width 4 appears 2x vs 8 1x
    const f18 = layout.fields[0];
    assert.equal(f18.reads, 2);
    assert.equal(f18.writes, 1);
    assert.equal(f18.width, 4);
    assert.equal(f18.typeHint, 'int32');
    assert.equal(f18.confidence, 'high');
    assert.deepEqual(f18.sampleFunctions, [fnA, fnB]);

    // 0x20: accessed 2x by fnA only -> medium confidence
    const f20 = layout.fields[1];
    assert.equal(f20.reads, 1);
    assert.equal(f20.writes, 1);
    assert.equal(f20.width, 8);
    assert.equal(f20.typeHint, 'ptr');
    assert.equal(f20.confidence, 'medium');
    assert.deepEqual(f20.sampleFunctions, [fnA]);

    // 0x30: single access by fnA -> low confidence
    const f30 = layout.fields[2];
    assert.equal(f30.reads, 1);
    assert.equal(f30.writes, 0);
    assert.equal(f30.width, 4);
    assert.equal(f30.typeHint, null);
    assert.equal(f30.confidence, 'low');
    assert.deepEqual(f30.sampleFunctions, [fnA]);

    // Map<string> and hex Record equivalence
    const mapStr = new Map([
      ['0x1001a5000', mapBig.get(fnA)],
      ['0x1001A5100', mapBig.get(fnB)],
    ]);
    const recHex = {
      '0x1001a5000': mapBig.get(fnA),
      '0x1001a5100': mapBig.get(fnB),
    };
    const resStr = aggregateClassFields({ cxxRtti, accessesByFunc: mapStr });
    const resRec = aggregateClassFields({ cxxRtti, accessesByFunc: recHex });
    assert.deepEqual(resStr.layouts.get('Game::System::Coin'), layout);
    assert.deepEqual(resRec.layouts.get('Game::System::Coin'), layout);
  });

  it('resolves rmw and x86Rmw hits via binary search over normalized functions and BigInt textVa', () => {
    // Use > MAX_SAFE_INTEGER VA to verify BigInt precision
    const textVa = 0x1000000000000000n;
    const fn1 = textVa + 0x100n;
    const fn2 = textVa + 0x200n;
    const fn3 = textVa + 0x300n;

    const cxxRtti = {
      byFunction: new Map([
        [fn1, { fnVa: fn1, primaryOwner: 'Player::Stats' }],
        [fn2, { fnVa: fn2, primaryOwner: 'Player::Stats' }],
      ]),
    };

    const functions = [
      { start: fn1, end: fn1 + 0x80n },
      { start: fn2, end: fn2 + 0x80n },
      { start: fn3, end: fn3 + 0x40n },
    ];

    const rmw = {
      hits: [
        // Inside fn1 -> offset 0x44, float, width 4
        { loadOff: 0x110, storeOff: 0x118, arithOff: 0x114, disp: 0x44, baseReg: 0, opKind: 1, clamped: false, isFloat: true, width: 4, flags: 2 },
        // Outside fn1 (in gap [0x180, 0x200)) -> must be ignored
        { loadOff: 0x190, storeOff: 0x198, arithOff: 0x194, disp: 0x44, baseReg: 0, opKind: 1, clamped: false, isFloat: true, width: 4, flags: 2 },
      ],
    };

    const x86Rmw = {
      hits: [
        // Inside fn2 -> same offset 0x44, float, width 4 -> boosts confidence to high
        { loadOff: 0x220, storeOff: 0x228, arithOff: 0x224, disp: 0x44, baseReg: 7, opKind: 2, clamped: false, isFloat: true, width: 4, flags: 2 },
        // Inside fn3 (unowned) -> ignored
        { loadOff: 0x310, storeOff: 0x314, arithOff: 0x310, disp: 0x10, baseReg: 7, opKind: 1, clamped: false, isFloat: false, width: 8, flags: 0 },
      ],
    };

    const res = aggregateClassFields({
      cxxRtti,
      rmw,
      x86Rmw,
      textVa,
      functions,
    });

    assert.equal(res.stats.classesProcessed, 1);
    assert.equal(res.stats.classesWithFields, 1);
    assert.equal(res.stats.totalFields, 1);

    const layout = res.layouts.get('Player::Stats');
    assert.ok(layout);
    assert.equal(layout.fields.length, 1);
    const f = layout.fields[0];
    assert.equal(f.offset, 0x44);
    assert.equal(f.width, 4);
    assert.equal(f.reads, 2);
    assert.equal(f.writes, 2);
    assert.equal(f.typeHint, 'float');
    assert.equal(f.confidence, 'high');
    assert.deepEqual(f.sampleFunctions, [fn1, fn2]);
  });

  it('filters invalid offsets/widths, prevents prototype pollution, caps sampleFunctions at 8, and enforces maxClasses', () => {
    const methods = [];
    const accessesByFunc = new Map();
    for (let i = 0; i < 12; i++) {
      const va = 0x10000n + BigInt(i * 0x100);
      methods.push({ fnVa: va, slotIndex: i });
      accessesByFunc.set(va, [
        { offset: 0x10, width: 8, kind: 'read' },
        { offset: -8, width: 4, kind: 'read' },
        { offset: Number.NaN, width: 4, kind: 'write' },
        { offset: 1.5, width: 4, kind: 'read' },
        { offset: 0x20000000, width: 4, kind: 'read' },
        { offset: 0x10, width: -4, kind: 'write' },
      ]);
    }

    const cxxRtti = {
      classes: [
        { className: '__proto__', methods },
        { className: 'constructor', methods: [{ fnVa: 0x10000n }] },
        { className: 'OverflowedClass', methods: [{ fnVa: 0x10000n }] },
      ],
    };

    const res = aggregateClassFields({
      cxxRtti,
      accessesByFunc,
      maxClasses: 2,
    });

    // Prototype untouched
    assert.equal(({}).className, undefined);
    assert.equal(res.truncated, true);
    assert.equal(res.completeness, 'partial');
    assert.equal(res.stats.classesProcessed, 2);
    assert.equal(res.layouts.has('__proto__'), true);
    assert.equal(res.layouts.has('constructor'), true);
    assert.equal(res.layouts.has('OverflowedClass'), false);

    const protoLayout = res.layouts.get('__proto__');
    assert.equal(protoLayout.fields.length, 1);
    assert.equal(protoLayout.fields[0].offset, 0x10);
    assert.equal(protoLayout.fields[0].width, 8);
    assert.equal(protoLayout.fields[0].reads, 12);
    assert.equal(protoLayout.fields[0].writes, 12);
    assert.equal(protoLayout.fields[0].sampleFunctions.length, 8);
    assert.deepEqual(protoLayout.fields[0].sampleFunctions, [
      0x10000n, 0x10100n, 0x10200n, 0x10300n,
      0x10400n, 0x10500n, 0x10600n, 0x10700n,
    ]);
  });

  it('breaks width ties by selecting the larger aligned width and propagates partial completeness from cxxRtti', () => {
    const fn1 = 0x4000n;
    const cxxRtti = {
      completeness: 'partial',
      truncated: true,
      classes: [{ className: 'TieClass', methods: [{ fnVa: fn1 }] }],
    };
    const accessesByFunc = new Map([
      [fn1, [
        { offset: 0x8, width: 4, kind: 'read' },
        { offset: 0x8, width: 8, kind: 'write' },
      ]],
    ]);

    const res = aggregateClassFields({ cxxRtti, accessesByFunc });
    assert.equal(res.completeness, 'partial');
    assert.equal(res.truncated, false);
    const f = res.layouts.get('TieClass').fields[0];
    assert.equal(f.width, 8);
    assert.equal(f.confidence, 'medium');
  });
});

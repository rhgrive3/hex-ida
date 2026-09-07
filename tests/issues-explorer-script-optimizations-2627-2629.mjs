import assert from 'node:assert/strict';
import { createApi } from '../js/script.js';
import { classItems, externalItems } from '../js/ui/product.js';

// ── #2627: hex.findStrings(query, limit) early termination and parity ──
{
  let accessed = 0;
  const strings = Array.from({ length: 60_000 }, (_, i) => ({
    addr: BigInt(0x1000 + i * 16),
    get text() {
      accessed++;
      return `str_${i}_needle_${i % 100}`;
    },
  }));

  const fakeApp = {
    stringIndex: strings,
  };

  const out = { log() {}, warn() {}, error() {} };
  const { api: hex } = createApi(fakeApp, out);

  // Common match with small limit should break early
  accessed = 0;
  const res1 = hex.findStrings('needle', 10);
  assert.equal(res1.length, 10);
  assert.equal(accessed, 10, `expected 10 string accesses with early break, got ${accessed}`);

  // Empty query with limit
  accessed = 0;
  const res2 = hex.findStrings('', 5);
  assert.equal(res2.length, 5);
  assert.equal(accessed, 5, `expected 5 string accesses with early break, got ${accessed}`);

  // Case insensitive match
  accessed = 0;
  const res3 = hex.findStrings('STR_0_NEEDLE', 1);
  assert.equal(res3.length, 1);
  assert.equal(res3[0].addr, 0x1000n);
}

// ── #2628: Product Explorer Classes caching and filtering ──
{
  const classesMap = new Map();
  for (let i = 0; i < 500; i++) {
    classesMap.set(`Class_${i}`, {
      methods: ['init', 'run'],
      ivars: ['_count'],
      superName: 'NSObject',
    });
  }

  const app = {
    fields: { classes: classesMap },
  };

  const all = classItems(app, '');
  assert.equal(all.length, 500);
  assert.equal(all[0].name, 'Class_0');

  const filtered = classItems(app, 'class_10');
  assert.ok(filtered.some((c) => c.name === 'Class_10'));

  // Object-based classes
  const appObj = {
    objcModel: {
      classes: [
        { name: 'MyController', superclass: 'UIViewController', methods: ['viewDidLoad'], ivars: [] },
      ],
    },
  };
  const objcAll = classItems(appObj, 'mycontroller');
  assert.equal(objcAll.length, 1);
  assert.equal(objcAll[0].name, 'MyController');
}

// ── #2629: Product Explorer External caching and deduplication ──
{
  const fileInfo = { format: 'Mach-O' };
  const app = {
    store: {
      get: (k) => k === 'fileInfo' ? fileInfo : null,
    },
    currentSlice: () => ({
      info: {
        dylibs: ['/usr/lib/libSystem.B.dylib', '/System/Library/Frameworks/Foundation.framework/Foundation'],
      },
    }),
    symbols: {
      imports: [
        { name: '_malloc', addr: 0x2000n },
        { name: '_free', addr: 0x2008n },
      ],
    },
  };

  const all = externalItems(app, '');
  assert.equal(all.length, 4);

  const filtered = externalItems(app, 'malloc');
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].name, '_malloc');
  assert.equal(filtered[0].kind, 'import');

  const dylibFiltered = externalItems(app, 'foundation');
  assert.equal(dylibFiltered.length, 1);
  assert.equal(dylibFiltered[0].kind, 'dylib');
}

console.log('Issue #2627, #2628, #2629 regression tests PASS!');

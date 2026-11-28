import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeUnifiedMetadata } from '../js/analysis/apple/unified-metadata-normalizer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = path.resolve(__dirname, '../js/analysis/apple/unified-metadata-normalizer.js');

describe('unified-metadata-normalizer', () => {
  it('has zero external static imports', () => {
    const src = fs.readFileSync(MODULE_PATH, 'utf8');
    assert.equal(/\bimport\s+/.test(src), false, 'unified-metadata-normalizer.js must be self-contained');
    assert.equal(/\brequire\s*\(/.test(src), false);
  });

  it('returns empty complete structure for null/undefined/empty inputs', () => {
    for (const input of [undefined, null, {}, { cxxRtti: null, objcSwift: null, symbols: null }]) {
      const res = normalizeUnifiedMetadata(input);
      assert.deepEqual(res.classes, []);
      assert.equal(res.methodsByFn instanceof Map, true);
      assert.equal(res.methodsByFn.size, 0);
      assert.equal(res.completeness, 'complete');
      assert.deepEqual(res.partialReasons, []);
      assert.deepEqual(res.stats, {
        totalClasses: 0,
        cppClasses: 0,
        objcClasses: 0,
        swiftClasses: 0,
        totalMethods: 0,
      });
    }
  });

  it('normalizes C++ RTTI classes, template namespaces, inheritance, and shared methods with BigInt keys', () => {
    const fnCoin = 0x1001A5384n;
    const fnShared = 0x100200000n;
    const fnHigh64 = 0x0001_0000_0000_1234n; // exceeds Number.MAX_SAFE_INTEGER

    const cxxRtti = {
      classes: [
        {
          className: 'Game::System::Coin::Abstruct',
          namespacePath: ['Game', 'System', 'Coin'],
          shortClassName: 'Abstruct',
          rttiVa: 0x102000000n,
          baseClassNames: ['Game::System::Base'],
          methods: [
            { fnVa: fnCoin, slotIndex: 9, vtableVa: 0x102100000n, isPrimaryOwner: true },
            { fnVa: fnShared, slotIndex: 1, vtableVa: 0x102100000n, isPrimaryOwner: true },
          ],
        },
        {
          className: 'std::vector<Game::Item>::Impl',
          rttiVa: 0x102000100n,
          baseClassNames: [],
          methods: [
            { fnVa: fnHigh64, slotIndex: 0, vtableVa: 0x102100100n, isPrimaryOwner: true },
          ],
        },
      ],
      byFunction: new Map([
        [fnCoin, {
          fnVa: fnCoin,
          primaryOwner: 'Game::System::Coin::Abstruct',
          primaryRttiVa: 0x102000000n,
          slotIndex: 9,
          isShared: false,
          sharedOwners: [],
          allOwners: [],
        }],
        [fnShared, {
          fnVa: fnShared,
          primaryOwner: null,
          primaryRttiVa: null,
          slotIndex: 1,
          isShared: true,
          sharedOwners: ['Game::System::Coin::Abstruct', 'Game::System::Gem::Abstruct'],
          allOwners: [],
        }],
      ]),
      completeness: 'complete',
      truncated: false,
    };

    const res = normalizeUnifiedMetadata({ cxxRtti });
    assert.equal(res.completeness, 'complete');
    assert.deepEqual(res.partialReasons, []);
    assert.equal(res.stats.totalClasses, 2);
    assert.equal(res.stats.cppClasses, 2);
    assert.equal(res.stats.totalMethods, 3);

    const coinRef = res.methodsByFn.get(fnCoin);
    assert.ok(coinRef);
    assert.equal(coinRef.className, 'Game::System::Coin::Abstruct');
    assert.equal(coinRef.language, 'cpp');
    assert.equal(coinRef.slotIndex, 9);
    assert.equal(coinRef.isShared, false);

    const sharedRef = res.methodsByFn.get(fnShared);
    assert.ok(sharedRef);
    assert.equal(sharedRef.isShared, true);
    assert.deepEqual(sharedRef.sharedOwners, ['Game::System::Coin::Abstruct', 'Game::System::Gem::Abstruct']);

    const highRef = res.methodsByFn.get(fnHigh64);
    assert.ok(highRef);
    assert.equal(highRef.fnVa, fnHigh64);

    const tplClass = res.classes.find((c) => c.className === 'std::vector<Game::Item>::Impl');
    assert.ok(tplClass);
    assert.deepEqual(tplClass.namespacePath, ['std', 'vector<Game::Item>']);
    assert.equal(tplClass.shortName, 'Impl');
  });

  it('normalizes resolved objcModel and swiftModel and reports complete when not truncated', () => {
    const objcModel = {
      classes: new Map([
        ['PlayerController', {
          name: 'PlayerController',
          superName: 'UIViewController',
          methods: [{ selector: 'addCoins:', imp: 0x100300000n }],
          classMethods: [{ selector: 'sharedInstance', imp: 0x100300100n }],
        }],
      ]),
      truncated: false,
    };
    const swiftModel = {
      types: [
        {
          fullName: 'MyGame.Wallet.CoinManager',
          superclassName: 'MyGame.BaseManager',
          methods: [{ name: 'spend', address: 0x100400000n, slot: 3 }],
        },
      ],
      truncated: false,
    };

    const res = normalizeUnifiedMetadata({ objcModel, swiftModel });
    assert.equal(res.completeness, 'complete');
    assert.equal(res.stats.objcClasses, 1);
    assert.equal(res.stats.swiftClasses, 1);
    assert.equal(res.stats.totalMethods, 3);

    const m1 = res.methodsByFn.get(0x100300000n);
    assert.equal(m1.language, 'objc');
    assert.equal(m1.methodName, '-addCoins:');
    const m2 = res.methodsByFn.get(0x100300100n);
    assert.equal(m2.methodName, '+sharedInstance');

    const m3 = res.methodsByFn.get(0x100400000n);
    assert.equal(m3.language, 'swift');
    assert.equal(m3.methodName, 'spend');
    assert.equal(m3.slotIndex, 3);

    const swiftRec = res.classes.find((c) => c.language === 'swift');
    assert.deepEqual(swiftRec.namespacePath, ['MyGame', 'Wallet']);
    assert.equal(swiftRec.shortName, 'CoinManager');
  });

  it('marks completeness partial with explicit reasons when raw objcSwift pointers are unresolved or truncated', () => {
    const objcSwift = {
      engine: 'wasm',
      truncated: true,
      sectionsScanned: ['__objc_classlist', '__swift5_types'],
      objc: {
        classList: [{ targetVa: 0x103000000n }, { targetVa: 0x103000040n }],
        catList: [],
        protoList: [],
        selRefs: [],
      },
      swift5: {
        types: [{ targetVa: 0x104000000n }],
        proto: [],
        protos: [],
        fieldMd: [],
      },
      counts: { objcClassList: 2, swift5Types: 1, total: 3 },
    };

    const res = normalizeUnifiedMetadata({ objcSwift });
    assert.equal(res.completeness, 'partial');
    assert.ok(res.partialReasons.includes('objc_swift_truncated'));
    assert.ok(res.partialReasons.includes('objc_raw_pointers_unresolved'));
    assert.ok(res.partialReasons.includes('swift_raw_descriptors_unresolved'));
    assert.equal(res.stats.objcClasses, 2);
    assert.equal(res.stats.swiftClasses, 1);
    assert.equal(res.classes.every((c) => c.confidence === 'medium'), true);
  });

  it('handles SymbolIndex fallback without overriding higher-priority C++ RTTI', () => {
    const cxxRtti = {
      classes: [{
        className: 'Game::Wallet',
        methods: [{ fnVa: 0x100500000n, slotIndex: 2, isPrimaryOwner: true }],
      }],
      byFunction: new Map(),
      completeness: 'complete',
    };
    const symbols = [
      { addr: 0x100500000n, name: 'Game::Wallet::add(int)' },
      { addr: 0x100500100n, name: '-[ShopScene buyItem:]' },
      { addr: 0x100500200n, name: 'sub_100500200' },
    ];

    const res = normalizeUnifiedMetadata({ cxxRtti, symbols });
    const walletMethod = res.methodsByFn.get(0x100500000n);
    assert.equal(walletMethod.language, 'cpp');
    assert.equal(walletMethod.className, 'Game::Wallet');
    assert.equal(walletMethod.methodName, 'add');

    const objcMethod = res.methodsByFn.get(0x100500100n);
    assert.equal(objcMethod.language, 'objc');
    assert.equal(objcMethod.className, 'ShopScene');
    assert.equal(objcMethod.methodName, '-buyItem:');

    assert.equal(res.methodsByFn.has(0x100500200n), false);
  });

  it('is immune to prototype-polluting class names (__proto__, constructor, prototype)', () => {
    const cxxRtti = {
      classes: [
        { className: '__proto__', methods: [{ fnVa: 0x100600000n, slotIndex: 0, isPrimaryOwner: true }] },
        { className: 'constructor', methods: [{ fnVa: 0x100600010n, slotIndex: 1, isPrimaryOwner: true }] },
        { className: 'prototype', methods: [{ fnVa: 0x100600020n, slotIndex: 2, isPrimaryOwner: true }] },
      ],
      byFunction: {
        '0x100600000': { fnVa: 0x100600000n, primaryOwner: '__proto__', slotIndex: 0, isShared: false, sharedOwners: [] },
      },
      completeness: 'complete',
    };

    const res = normalizeUnifiedMetadata({ cxxRtti });
    assert.equal(res.stats.cppClasses, 3);
    assert.equal(res.methodsByFn.get(0x100600000n)?.className, '__proto__');
    assert.equal(res.methodsByFn.get(0x100600010n)?.className, 'constructor');
    assert.equal(res.methodsByFn.get(0x100600020n)?.className, 'prototype');
    assert.equal(({}).polluted, undefined);
  });
});

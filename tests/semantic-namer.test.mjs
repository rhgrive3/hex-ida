import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSemanticNames } from '../js/analysis/semantic-namer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NAMER_PATH = path.resolve(__dirname, '../js/analysis/semantic-namer.js');

describe('semantic-namer (Track T4)', () => {
  it('has zero static imports (Wave 1 independence)', () => {
    const src = fs.readFileSync(NAMER_PATH, 'utf8');
    assert.equal(/\bimport\s+/.test(src), false, 'semantic-namer.js must not statically import other modules');
    assert.equal(/\brequire\s*\(/.test(src), false, 'semantic-namer.js must not use require()');
  });

  it('handles empty, null, and undefined inputs safely (fail-closed)', () => {
    for (const input of [undefined, null, {}, { functions: null, cxxRtti: null, virtualTree: null }]) {
      const res = buildSemanticNames(input);
      assert.equal(res.byFunction instanceof Map, true);
      assert.equal(res.byFunction.size, 0);
      assert.equal(res.stats.totalScored, 0);
      assert.equal(res.stats.highCount, 0);
      assert.equal(res.stats.mediumCount, 0);
      assert.equal(res.stats.lowCount, 0);
      assert.equal(typeof res.stats.elapsedMs, 'number');
    }
  });

  it('generates high-confidence target+purpose Japanese label and English name for Game::System::Coin::Abstruct', () => {
    const fnCoinVerifySave = 0x1001A5384n;
    const fnCoinSibling = 0x1001A5400n;
    const fnCaller = 0x100200000n;

    const cxxRtti = {
      byFunction: new Map([
        [fnCoinVerifySave, {
          fnVa: fnCoinVerifySave,
          primaryOwner: 'Game::System::Coin::Abstruct',
          primaryRttiVa: 0x101000000n,
          slotIndex: 9,
          isShared: false,
          sharedOwners: [],
          allOwners: [],
        }],
        [fnCoinSibling, {
          fnVa: fnCoinSibling,
          primaryOwner: 'Game::System::Coin::Abstruct',
          primaryRttiVa: 0x101000000n,
          slotIndex: 10,
          isShared: false,
          sharedOwners: [],
          allOwners: [],
        }],
        [fnCaller, {
          fnVa: fnCaller,
          primaryOwner: 'Game::UI::ShopDialog',
          primaryRttiVa: 0x101000100n,
          slotIndex: 2,
          isShared: false,
          sharedOwners: [],
          allOwners: [],
        }],
      ]),
    };

    const virtualTree = {
      nodes: new Map([
        ['folder:coin', {
          id: 'folder:coin',
          kind: 'class',
          label: 'Abstruct',
          fullPath: 'Game/System/Coin/Abstruct',
          source: 'cxx-rtti',
          confidence: 'high',
        }],
      ]),
      functionToFolderId: new Map([
        [fnCoinVerifySave, 'folder:coin'],
        [fnCoinSibling, 'folder:coin'],
      ]),
    };

    // Test mixed BigInt and hex-string keys in stringsByFunc & cryptoHints.
    const stringsByFunc = {
      '0x1001a5384': ['iv1,', 'cd1,', 'ne'],
      '0x1001a5400': ['coin_balance_log', 'Crypto::Value<int>'],
    };

    const functions = [
      { start: fnCoinVerifySave, end: 0x1001A53F0n },
      { start: fnCoinSibling, end: 0x1001A5480n },
      { start: fnCaller, end: 0x100200100n },
    ];

    // Real wasm-rmw-scanner hit structure resolved via textVa + BigInt(loadOff).
    const rmw = {
      hits: [
        {
          loadOff: 0x1A5394,
          storeOff: 0x1A539C,
          arithOff: 0x1A5398,
          disp: 0x18,
          baseReg: 0,
          opKind: 1,
          clamped: true,
          isFloat: false,
          width: 4,
          flags: 0,
        },
      ],
    };

    const callgraph = {
      nodes: [fnCaller, fnCoinVerifySave, fnCoinSibling],
      edgeSrc: new Uint32Array([0]),
      edgeDst: new Uint32Array([1]),
    };

    const res = buildSemanticNames({
      virtualTree,
      cxxRtti,
      stringsByFunc,
      callgraph,
      rmw,
      textVa: 0x100000000n,
      cryptoHints: { '0x1001a5384': ['Crypto::Value'] },
      functions,
    });

    assert.equal(res.stats.totalScored, 3);
    const card = res.byFunction.get(fnCoinVerifySave);
    assert.ok(card);
    assert.equal(card.addr, fnCoinVerifySave);
    assert.equal(card.ownerClass, 'Game::System::Coin::Abstruct');
    assert.equal(card.folderPath, 'Game/System/Coin/Abstruct');
    assert.equal(card.slotIndex, 9);

    assert.deepEqual(card.evidence.ownStrings, ['iv1,', 'cd1,', 'ne']);
    assert.equal(card.evidence.siblingStrings.includes('coin_balance_log'), true);
    assert.equal(card.evidence.cryptoTypes.includes('Crypto::Value'), true);
    assert.equal(card.evidence.writesGlobalSingleton, true);
    assert.deepEqual(card.evidence.callerOwners, ['Game::UI::ShopDialog']);

    assert.equal(card.naming.confidence, 'high');
    assert.equal(card.naming.labelJa, 'コインの検証と保存');
    assert.equal(card.naming.nameEn, 'verifyAndSaveCoin');
    assert.ok(card.naming.reasons.length >= 3);

    // Sibling method has ownStrings so also high; caller has only Tier 1 owner so medium.
    const callerCard = res.byFunction.get(fnCaller);
    assert.equal(callerCard.naming.confidence, 'medium');
    assert.ok(callerCard.naming.labelJa.includes('課金・ショップ'));
    assert.ok(callerCard.naming.nameEn);
  });

  it('calibrates medium confidence for Tier 1 owner without direct evidence and Tier 2 role folder', () => {
    const fnTier1Only = 0x10001000n;
    const fnTier1WithSibling = 0x10001100n;
    const fnTier2Role = 0x10002000n;

    const unifiedMetadata = {
      methodsByFn: new Map([
        [fnTier1Only, {
          fnVa: fnTier1Only,
          classId: 'cpp:Game::Audio::Mixer',
          className: 'Game::Audio::Mixer',
          language: 'cpp',
          methodName: null,
          slotIndex: 0,
          isShared: false,
          sharedOwners: [],
        }],
        [fnTier1WithSibling, {
          fnVa: fnTier1WithSibling,
          classId: 'cpp:Game::Audio::Mixer',
          className: 'Game::Audio::Mixer',
          language: 'cpp',
          methodName: null,
          slotIndex: 1,
          isShared: false,
          sharedOwners: [],
        }],
      ]),
    };

    const virtualTree = {
      nodes: new Map([
        ['role:net', {
          id: 'role:net',
          kind: 'role',
          label: 'Network',
          fullPath: 'Roles/Network',
          source: 'api-role',
          confidence: 'medium',
        }],
      ]),
      functionToFolderId: new Map([
        [fnTier2Role, 'role:net'],
      ]),
    };

    const res = buildSemanticNames({
      unifiedMetadata,
      virtualTree,
      stringsByFunc: new Map([
        [fnTier1WithSibling, ['playbgm_main']],
      ]),
      functions: [fnTier1Only, fnTier1WithSibling, fnTier2Role],
    });

    const c1 = res.byFunction.get(fnTier1Only);
    assert.equal(c1.naming.confidence, 'medium');
    assert.deepEqual(c1.evidence.siblingStrings, ['playbgm_main']);
    assert.ok(c1.naming.labelJa.includes('音声'));

    const c2 = res.byFunction.get(fnTier2Role);
    assert.equal(c2.naming.confidence, 'medium');
    assert.equal(c2.ownerClass, null);
    assert.equal(c2.folderPath, 'Roles/Network');
    assert.ok(c2.naming.labelJa.includes('通信データ'));
    assert.ok(c2.naming.nameEn);
  });

  it('never fabricates names for low-confidence functions lacking evidence', () => {
    const fnUnknown = 0x10005000n;
    const virtualTree = {
      nodes: new Map([
        ['unclassified', {
          id: 'unclassified',
          kind: 'unclassified',
          label: 'Unclassified',
          fullPath: 'Unclassified',
          source: 'unclassified',
          confidence: 'low',
        }],
      ]),
      functionToFolderId: new Map([
        [fnUnknown, 'unclassified'],
      ]),
    };

    const res = buildSemanticNames({
      virtualTree,
      functions: [{ start: fnUnknown, end: 0x10005040n }],
    });

    assert.equal(res.stats.lowCount, 1);
    const card = res.byFunction.get(fnUnknown);
    assert.ok(card);
    assert.equal(card.naming.confidence, 'low');
    assert.equal(card.naming.labelJa, '役割未確定の処理');
    assert.equal(card.naming.nameEn, null);
    assert.ok(card.naming.reasons.length >= 1);
  });

  it('preserves 64-bit BigInt precision above MAX_SAFE_INTEGER and resists prototype pollution', () => {
    const highVa = 0xFFFF_FFFF_8000_1234n;
    const protoClass = '__proto__::constructor::toString';

    const res = buildSemanticNames({
      cxxRtti: {
        byFunction: new Map([
          [highVa, {
            fnVa: highVa,
            primaryOwner: protoClass,
            slotIndex: 0,
            isShared: false,
            sharedOwners: [],
          }],
        ]),
      },
      stringsByFunc: new Map([
        [highVa, ['verify_token']],
      ]),
      apisByFunc: {
        '0xffffffff80001234': ['SecItemUpdate'],
      },
    });

    assert.equal(res.byFunction.has(highVa), true);
    const card = res.byFunction.get(highVa);
    assert.equal(card.addr, highVa);
    assert.equal(card.ownerClass, protoClass);
    assert.equal(card.naming.confidence, 'high');
    assert.equal(card.evidence.writesGlobalSingleton, true);
    assert.equal(({}).polluted, undefined);
  });

  it('resolves x86Rmw hits via interval binary search and skips out-of-range hits safely', () => {
    const fnA = 0x401000n;
    const fnB = 0x402000n;

    const res = buildSemanticNames({
      cxxRtti: {
        byFunction: new Map([
          [fnA, { fnVa: fnA, primaryOwner: 'Player::Stamina', slotIndex: 1 }],
          [fnB, { fnVa: fnB, primaryOwner: 'Player::Stamina', slotIndex: 2 }],
        ]),
      },
      functions: [
        { start: fnA, end: 0x401100n },
        { start: fnB, end: 0x402100n },
      ],
      textVa: 0x400000n,
      x86Rmw: {
        hits: [
          { loadOff: 0x1020, storeOff: 0x1028, disp: 0x10, clamped: true, isFloat: false, width: 4 },
          { loadOff: 0x999999, storeOff: 0x99999F, disp: 0x10, clamped: false, isFloat: false, width: 4 }, // out of range
        ],
      },
    });

    const cardA = res.byFunction.get(fnA);
    const cardB = res.byFunction.get(fnB);
    assert.equal(cardA.evidence.writesGlobalSingleton, true);
    assert.equal(cardA.naming.confidence, 'high');
    assert.equal(cardB.evidence.writesGlobalSingleton, false);
    assert.equal(cardB.naming.confidence, 'medium');
  });

  it('handles cyclic callgraph without infinite loops and enforces BigInt-only unsafe number rejection', () => {
    const fnA = 0x1000n;
    const fnB = 0x2000n;
    const res = buildSemanticNames({
      cxxRtti: {
        byFunction: new Map([
          [fnA, { fnVa: fnA, primaryOwner: 'Game::Quest::Manager', slotIndex: 0 }],
          [fnB, { fnVa: fnB, primaryOwner: 'Game::Battle::Engine', slotIndex: 0 }],
        ]),
      },
      callgraph: {
        nodes: [fnA, fnB],
        edgeSrc: new Uint32Array([0, 1, 0]),
        edgeDst: new Uint32Array([1, 0, 0]), // cycle + self-loop
      },
      stringsByFunc: new Map([
        [Number.MAX_SAFE_INTEGER + 10, ['unsafe_ignored']],
        [-1n, ['negative_ignored']],
      ]),
    });

    assert.equal(res.stats.totalScored, 2);
    assert.deepEqual(res.byFunction.get(fnA).evidence.callerOwners, ['Game::Battle::Engine']);
    assert.deepEqual(res.byFunction.get(fnB).evidence.callerOwners, ['Game::Quest::Manager']);
  });

  it('enforces LazySemanticNameMap contract, custom folderPath resolution, and partial-tree o.functions retention', () => {
    const fnRtti = 0x100100000n;
    const fnExtra = 0x100100040n;

    // Pure RTTI fast path (no strings/apis/callgraph/rmw) with custom folderId
    const customTree = {
      nodes: new Map([
        ['custom:coin', { id: 'custom:coin', kind: 'class', label: 'Coin', fullPath: 'Game/System/Coin', source: 'cxx-rtti', confidence: 'high', functionAddrs: [fnRtti] }],
      ]),
      functionToFolderId: new Map([[fnRtti, 'custom:coin']]),
      truncated: false,
      completeness: 'complete',
    };

    const res = buildSemanticNames({
      cxxRtti: {
        byFunction: new Map([[fnRtti, { fnVa: fnRtti, primaryOwner: 'Game::System::Coin', slotIndex: 3 }]]),
      },
      virtualTree: customTree,
      // Even though customTree has only fnRtti, passing functions with fnExtra must not drop fnExtra
      functions: [fnRtti, fnExtra],
    });

    assert.equal(res.byFunction.size, 2);
    const rttiCard = res.byFunction.get(fnRtti);
    assert.equal(rttiCard.folderPath, 'Game/System/Coin');
    assert.equal(rttiCard.naming.confidence, 'medium');

    const extraCard = res.byFunction.get(fnExtra);
    assert.equal(extraCard.naming.confidence, 'low');
    assert.equal(extraCard.naming.nameEn, null);

    // Map mutation contract: delete / set / clear
    assert.equal(res.byFunction.delete(fnExtra), true);
    assert.equal(res.byFunction.has(fnExtra), false);
    assert.equal(res.byFunction.size, 1);
    res.byFunction.set(fnExtra, extraCard);
    assert.equal(res.byFunction.size, 2);
    res.byFunction.clear();
    assert.equal(res.byFunction.size, 0);
    assert.equal(res.byFunction.has(fnRtti), false);
  });

  it('prevents double-decrement on delete() of eager crypto/shared RTTI keys and deduplicates overlapping/unsorted unclassifiedAddrs', () => {
    const fnCrypto = 0x100200000n;
    const fnNormal = 0x100200040n;
    const fnUnclassA = 0x100200080n;
    const fnUnclassB = 0x1002000c0n;

    // Crypto class triggers eager super.set() in classifyPrimary while remaining in _rttiByFunc
    const rttiMap = new Map([
      [fnCrypto, { fnVa: fnCrypto, primaryOwner: 'Crypto::Aes256Cipher', slotIndex: 0 }],
      [fnNormal, { fnVa: fnNormal, primaryOwner: 'Game::System::Coin', slotIndex: 1 }],
    ]);
    const tree = {
      nodes: new Map([
        ['Crypto/Aes256Cipher', { id: 'Crypto/Aes256Cipher', kind: 'class', label: 'Aes256Cipher', fullPath: 'Crypto/Aes256Cipher', source: 'cxx-rtti', confidence: 'high', functionAddrs: [fnCrypto] }],
        ['Game/System/Coin', { id: 'Game/System/Coin', kind: 'class', label: 'Coin', fullPath: 'Game/System/Coin', source: 'cxx-rtti', confidence: 'high', functionAddrs: [fnNormal] }],
        // Deliberately sorted ascending AND overlapping with fnNormal in _rttiByFunc (tests fast-path overlap check)
        ['Unclassified', { id: 'Unclassified', kind: 'unclassified', label: 'Unclassified', fullPath: 'Unclassified', source: 'unclassified', confidence: 'low', functionAddrs: [fnNormal, fnUnclassA, fnUnclassB] }],
      ]),
      functionToFolderId: new Map([
        [fnCrypto, 'Crypto/Aes256Cipher'],
        [fnNormal, 'Game/System/Coin'],
        [fnUnclassA, 'Unclassified'],
        [fnUnclassB, 'Unclassified'],
      ]),
      truncated: false,
      completeness: 'complete',
    };

    const res = buildSemanticNames({
      cxxRtti: { byFunction: rttiMap },
      virtualTree: tree,
    });

    // Overlapping fnNormal in Unclassified must NOT be double-counted or duplicated
    assert.equal(res.byFunction.size, 4);
    assert.equal([...res.byFunction.entries()].length, 4);
    assert.equal([...res.byFunction.keys()].length, 4);

    // Deleting eager crypto RTTI key must decrement size by exactly 1 (never double-decrement)
    const cryptoCard = res.byFunction.get(fnCrypto);
    assert.equal(res.byFunction.delete(fnCrypto), true);
    assert.equal(res.byFunction.has(fnCrypto), false);
    assert.equal(res.byFunction.get(fnCrypto), undefined);
    assert.equal(res.byFunction.size, 3);
    assert.equal([...res.byFunction.entries()].length, 3);
    // Repeated delete returns false and keeps size unchanged
    assert.equal(res.byFunction.delete(fnCrypto), false);
    assert.equal(res.byFunction.size, 3);

    // Re-setting deleted eager key restores size to 4 cleanly
    res.byFunction.set(fnCrypto, cryptoCard);
    assert.equal(res.byFunction.size, 4);
    assert.equal([...res.byFunction.entries()].length, 4);

    // Also verify unsorted unclassifiedAddrs with duplicates
    const unsortedTree = {
      nodes: new Map([
        ['Unclassified', { id: 'Unclassified', kind: 'unclassified', label: 'Unclassified', fullPath: 'Unclassified', source: 'unclassified', confidence: 'low', functionAddrs: [fnUnclassB, fnUnclassA, fnUnclassB, fnNormal] }],
      ]),
      functionToFolderId: new Map([
        [fnNormal, 'Game/System/Coin'],
        [fnUnclassA, 'Unclassified'],
        [fnUnclassB, 'Unclassified'],
      ]),
      truncated: false,
      completeness: 'complete',
    };
    const res2 = buildSemanticNames({
      cxxRtti: { byFunction: new Map([[fnNormal, { fnVa: fnNormal, primaryOwner: 'Game::System::Coin', slotIndex: 1 }]]) },
      virtualTree: unsortedTree,
    });
    assert.equal(res2.byFunction.size, 3);
    assert.equal([...res2.byFunction.entries()].length, 3);
  });
});

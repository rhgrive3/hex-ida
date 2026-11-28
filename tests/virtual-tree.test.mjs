import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildVirtualFolderTree,
  splitCppSegments,
  splitSwiftSegments,
} from '../js/analysis/virtual-tree.js';

describe('virtual-tree (Track T3)', () => {
  it('handles empty / null / undefined inputs safely (fail-closed)', () => {
    for (const input of [undefined, null, {}]) {
      const tree = buildVirtualFolderTree(input);
      assert.equal(tree.rootId, 'root');
      assert.equal(tree.nodes.size, 1);
      assert.equal(tree.functionToFolderId.size, 0);
      assert.equal(tree.completeness, 'complete');
      assert.equal(tree.truncated, false);
      assert.equal(tree.stats.totalFolders, 0);
      assert.equal(tree.stats.totalFunctions, 0);
      assert.deepEqual(tree.getChildren('root'), {
        folders: [],
        functions: [],
        totalFolders: 0,
        totalFunctions: 0,
        hasMore: false,
      });
      assert.deepEqual(tree.search('anything'), { matches: [] });
    }
  });

  it('splits C++ template names without breaking on nested :: and respects maxDepth', () => {
    assert.deepEqual(
      splitCppSegments('std::vector<Game::Item>::push_back'),
      ['std', 'vector<Game::Item>', 'push_back'],
    );
    assert.deepEqual(
      splitCppSegments('Game::Map<std::pair<A::B, C::D>>::operator->'),
      ['Game', 'Map<std::pair<A::B, C::D>>', 'operator->'],
    );
    assert.deepEqual(
      splitCppSegments('A::B::C::D::E', 3),
      ['A', 'B', 'C::D::E'],
    );
    assert.deepEqual(
      splitSwiftSegments('MyApp.Core.Box<Foundation.Data>.Item', 3),
      ['MyApp', 'Core', 'Box<Foundation.Data>.Item'],
    );
  });

  it('prioritizes unifiedMetadata over cxxRtti/objcSwift without double-registering', () => {
    const fnCpp = 0x1001A5384n;
    const fnObjc = 0x100200000n;
    const fnSwift = 0x100300000n;

    const unifiedMetadata = {
      classes: [
        {
          id: 'cpp:Game::System::Coin::Abstruct',
          language: 'cpp',
          className: 'Game::System::Coin::Abstruct',
          methods: [{ fnVa: fnCpp, methodName: 'addCoin' }],
        },
        {
          id: 'objc:AppDelegate',
          language: 'objc',
          className: 'AppDelegate',
          methods: [{ fnVa: fnObjc, methodName: 'applicationDidFinishLaunching:' }],
        },
        {
          id: 'swift:MyApp.Wallet.Manager',
          language: 'swift',
          className: 'MyApp.Wallet.Manager',
          methods: [{ fnVa: fnSwift, methodName: 'refresh' }],
        },
      ],
      methodsByFn: new Map([
        [fnCpp, { fnVa: fnCpp, className: 'Game::System::Coin::Abstruct', language: 'cpp', methodName: 'addCoin' }],
        [fnObjc, { fnVa: fnObjc, className: 'AppDelegate', language: 'objc', methodName: 'applicationDidFinishLaunching:' }],
        [fnSwift, { fnVa: fnSwift, className: 'MyApp.Wallet.Manager', language: 'swift', methodName: 'refresh' }],
      ]),
      completeness: 'complete',
    };

    // Pass conflicting cxxRtti that should be ignored because unifiedMetadata is present.
    const cxxRtti = {
      byFunction: new Map([
        [fnCpp, { fnVa: fnCpp, primaryOwner: 'Ignored::Fallback::Class' }],
        [0x100400000n, { fnVa: 0x100400000n, primaryOwner: 'Ignored::Extra' }],
      ]),
    };

    const tree = buildVirtualFolderTree({
      unifiedMetadata,
      cxxRtti,
      functions: [fnCpp, fnObjc, fnSwift],
    });

    assert.equal(tree.stats.tier1Count, 3);
    assert.equal(tree.stats.totalFunctions, 3);
    assert.equal(tree.functionToFolderId.get(fnCpp), 'Game/System/Coin/Abstruct');
    assert.equal(tree.functionToFolderId.get(fnObjc), 'ObjC/AppDelegate');
    assert.equal(tree.functionToFolderId.get(fnSwift), 'MyApp/Wallet/Manager');
    assert.equal(tree.nodes.has('Ignored'), false);
    assert.equal(tree.nodes.get('Game').functionCount, 1);
    assert.equal(tree.nodes.get('Game/System/Coin/Abstruct').kind, 'class');
  });

  it('falls back to cxxRtti when unifiedMetadata is absent and handles shared ICF owners', () => {
    const fnA = 0x100100000n;
    const fnShared = 0x100100040n;
    const tree = buildVirtualFolderTree({
      cxxRtti: {
        byFunction: new Map([
          [fnA, { fnVa: fnA, primaryOwner: 'Game::Player::Controller', isShared: false, sharedOwners: [] }],
          [fnShared, { fnVa: fnShared, primaryOwner: null, isShared: true, sharedOwners: ['Game::UI::Button', 'Game::UI::Label'] }],
        ]),
        completeness: 'partial',
      },
    });

    assert.equal(tree.functionToFolderId.get(fnA), 'Game/Player/Controller');
    assert.equal(tree.functionToFolderId.get(fnShared), 'Game/UI/Shared');
    assert.equal(tree.completeness, 'partial');
    assert.equal(tree.stats.tier1Count, 2);
  });

  it('classifies Tier 2 roles from Map<bigint>, Map<string>, and Record<hex> inputs', () => {
    const fNet = 0x100500000n;
    const fCrypto = 0x100500040n;
    const fStorage = 0x100500080n;
    const fAudio = 0x1005000c0n;
    const fUi = 0x100500100n;
    const fGame = 0x100500140n;
    const fUnk = 0x100500180n;

    const tree = buildVirtualFolderTree({
      functions: [fNet, fCrypto, fStorage, fAudio, fUi, fGame, fUnk],
      stringsByFunc: {
        '0x100500000': ['https://api.example.com/v1/login', 'NSURLSession'],
        '0x100500040': ['AES-256-GCM', 'SHA256 digest'],
        '0x100500080': ['sqlite3_open', 'savefile.db'],
      },
      apisByFunc: new Map([
        ['0x1005000c0', ['AVAudioPlayer', 'AudioUnitInitialize']],
        [fUi, ['UIViewController', 'CALayer']],
        [fGame, ['PlayerInventory', 'gacha_roll']],
      ]),
    });

    assert.equal(tree.functionToFolderId.get(fNet), 'Roles/Network');
    assert.equal(tree.functionToFolderId.get(fCrypto), 'Roles/Crypto');
    assert.equal(tree.functionToFolderId.get(fStorage), 'Roles/Storage');
    assert.equal(tree.functionToFolderId.get(fAudio), 'Roles/Audio');
    assert.equal(tree.functionToFolderId.get(fUi), 'Roles/UI');
    assert.equal(tree.functionToFolderId.get(fGame), 'Roles/Game');
    assert.equal(tree.functionToFolderId.get(fUnk), 'Unclassified');
    assert.equal(tree.stats.tier2Count, 6);
    assert.equal(tree.stats.tier4Count, 1);
    assert.equal(tree.nodes.get('Roles/Crypto').confidence, 'medium');
    assert.equal(tree.nodes.get('Unclassified').confidence, 'low');
  });

  it('propagates Tier 3 via callgraph (<=2 hops, >=80% consensus, hub>16 excluded, cycles safe)', () => {
    const fOwner = 0x100600000n;
    const fHop1 = 0x100600040n;
    const fHop2 = 0x100600080n;
    const fHop3 = 0x1006000c0n; // should NOT be absorbed (> 2 hops)
    const fCycleA = 0x100600100n;
    const fCycleB = 0x100600140n;
    const fHub = 0x100600180n;

    const hubCallers = [];
    const hubByFn = new Map([[fOwner, { fnVa: fOwner, primaryOwner: 'Game::Coin' }]]);
    for (let i = 0; i < 17; i++) {
      const va = 0x100700000n + BigInt(i * 4);
      hubCallers.push(va);
      hubByFn.set(va, { fnVa: va, primaryOwner: 'Game::Coin' });
    }

    const nodes = [fOwner, fHop1, fHop2, fHop3, fCycleA, fCycleB, fHub, ...hubCallers];
    const edgeSrc = [];
    const edgeDst = [];
    const addEdge = (u, v) => { edgeSrc.push(u); edgeDst.push(v); };

    // Chain: fOwner(0) -> fHop1(1) -> fHop2(2) -> fHop3(3)
    addEdge(0, 1);
    addEdge(1, 2);
    addEdge(2, 3);
    // Cycle with no resolved entry: fCycleA(4) <-> fCycleB(5)
    addEdge(4, 5);
    addEdge(5, 4);
    // Utility hub: 17 callers -> fHub(6)
    for (let i = 0; i < hubCallers.length; i++) {
      addEdge(7 + i, 6);
    }

    const tree = buildVirtualFolderTree({
      cxxRtti: { byFunction: hubByFn },
      functions: nodes,
      callgraph: {
        nodes,
        edgeSrc: Uint32Array.from(edgeSrc),
        edgeDst: Uint32Array.from(edgeDst),
      },
    });

    assert.equal(tree.functionToFolderId.get(fHop1), 'Game/Coin/helpers');
    assert.equal(tree.functionToFolderId.get(fHop2), 'Game/Coin/helpers');
    assert.equal(tree.functionToFolderId.get(fHop3), 'Unclassified');
    assert.equal(tree.functionToFolderId.get(fCycleA), 'Unclassified');
    assert.equal(tree.functionToFolderId.get(fCycleB), 'Unclassified');
    assert.equal(tree.functionToFolderId.get(fHub), 'Unclassified');
    assert.equal(tree.stats.tier3Count, 2);
  });

  it('rejects Tier 3 propagation when caller consensus is below 80% (e.g., 3/4 = 75%)', () => {
    const callersA = [0x100800000n, 0x100800004n, 0x100800008n];
    const callerB = 0x10080000cn;
    const target75 = 0x100800100n;
    const target80 = 0x100800104n;
    const callerA4 = 0x100800010n;

    const byFn = new Map([
      ...callersA.map((va) => [va, { fnVa: va, primaryOwner: 'Alpha::Svc' }]),
      [callerA4, { fnVa: callerA4, primaryOwner: 'Alpha::Svc' }],
      [callerB, { fnVa: callerB, primaryOwner: 'Beta::Svc' }],
    ]);

    // Map<bigint, bigint[]> callgraph format
    const cg = new Map([
      [callersA[0], [target75, target80]],
      [callersA[1], [target75, target80]],
      [callersA[2], [target75, target80]],
      [callerA4, [target80]],
      [callerB, [target75, target80]],
    ]);

    const tree = buildVirtualFolderTree({
      cxxRtti: { byFunction: byFn },
      functions: [...callersA, callerA4, callerB, target75, target80],
      callgraph: cg,
    });

    // 3/4 = 75% -> Unclassified
    assert.equal(tree.functionToFolderId.get(target75), 'Unclassified');
    // 4/5 = 80% -> Alpha/Svc/helpers
    assert.equal(tree.functionToFolderId.get(target80), 'Alpha/Svc/helpers');
  });

  it('prevents prototype pollution from hostile class names and preserves BigInt precision', () => {
    const highVa = 0x1ffffffffff00004n; // > Number.MAX_SAFE_INTEGER
    const tree = buildVirtualFolderTree({
      cxxRtti: {
        byFunction: new Map([
          [highVa, { fnVa: highVa, primaryOwner: '__proto__::constructor::toString' }],
        ]),
      },
    });

    assert.equal(Object.prototype.polluted, undefined);
    assert.equal(tree.functionToFolderId.get(highVa), '__proto__/constructor/toString');
    assert.equal(tree.nodes.get('__proto__/constructor/toString').functionAddrs[0], highVa);
  });

  it('enforces maxNodes cap with truncated=true and completeness=partial', () => {
    const byFunction = new Map();
    for (let i = 0; i < 20; i++) {
      byFunction.set(0x100900000n + BigInt(i * 4), {
        fnVa: 0x100900000n + BigInt(i * 4),
        primaryOwner: `Ns${i}::Cls${i}`,
      });
    }
    const tree = buildVirtualFolderTree({ cxxRtti: { byFunction }, maxNodes: 6 });
    assert.equal(tree.truncated, true);
    assert.equal(tree.completeness, 'partial');
    assert.ok(tree.nodes.size <= 6);
  });

  it('supports getChildren pagination and search across folders and functions', () => {
    const fns = [];
    const byFunction = new Map();
    for (let i = 0; i < 15; i++) {
      const va = 0x100a00000n + BigInt(i * 4);
      fns.push(va);
      byFunction.set(va, { fnVa: va, primaryOwner: 'Game::System::Coin' });
    }
    const tree = buildVirtualFolderTree({
      cxxRtti: { byFunction },
      functions: fns,
      symbols: new Map([[0x100a00000n, 'Game::System::Coin::grantBonus']]),
    });

    const page1 = tree.getChildren('Game/System/Coin', { offset: 0, limit: 10 });
    assert.equal(page1.functions.length, 10);
    assert.equal(page1.totalFunctions, 15);
    assert.equal(page1.hasMore, true);

    const page2 = tree.getChildren('Game/System/Coin', { offset: 10, limit: 10 });
    assert.equal(page2.functions.length, 5);
    assert.equal(page2.hasMore, false);

    const folderHits = tree.search('coin');
    assert.ok(folderHits.matches.some((m) => m.kind === 'folder' && m.nodeId === 'Game/System/Coin'));

    const fnHits = tree.search('grantBonus');
    assert.ok(fnHits.matches.some((m) => m.kind === 'function' && m.addr === 0x100a00000n));

    const hexHits = tree.search('0x100a00004');
    assert.ok(hexHits.matches.some((m) => m.kind === 'function' && m.addr === 0x100a00004n));
  });

  it('enforces LazyFolderMap full Map contract, maxNodes consistency, and mixed-type functions arrays', () => {
    const f1 = 0x100b00000n;
    const f2 = 0x100b00004n;
    const f3 = 0x100b00008n;
    const tree = buildVirtualFolderTree({
      cxxRtti: {
        byFunction: new Map([
          [f1, { fnVa: f1, primaryOwner: 'Game::Coin::A' }],
        ]),
      },
      // Mixed bigint + object + hex string entries must all be ingested without dropping
      functions: [f1, { start: f2, end: f2 + 4n }, `0x${f3.toString(16)}`],
    });

    assert.equal(tree.functionToFolderId.size, 3);
    assert.equal(tree.functionToFolderId.has(f1), true);
    assert.equal(tree.functionToFolderId.has(f2), true);
    assert.equal(tree.functionToFolderId.has(f3), true);
    assert.equal(tree.functionToFolderId.get(f1), 'Game/Coin/A');
    assert.equal(tree.functionToFolderId.get(f2), 'Unclassified');
    assert.equal(tree.functionToFolderId.get(f3), 'Unclassified');

    // Keys / entries / size / delete / set / clear must stay consistent
    assert.equal([...tree.functionToFolderId.keys()].length, 3);
    assert.equal([...tree.functionToFolderId.entries()].length, 3);
    assert.equal(tree.functionToFolderId.delete(f2), true);
    assert.equal(tree.functionToFolderId.has(f2), false);
    assert.equal(tree.functionToFolderId.size, 2);
    tree.functionToFolderId.set(f2, 'Custom/Folder');
    assert.equal(tree.functionToFolderId.get(f2), 'Custom/Folder');
    tree.functionToFolderId.clear();
    assert.equal(tree.functionToFolderId.size, 0);
    assert.equal(tree.functionToFolderId.has(f1), false);

    // Under maxNodes cap, has() and get() must agree for every function
    const many = new Map();
    for (let i = 0; i < 15; i++) {
      const va = 0x100c00000n + BigInt(i * 4);
      many.set(va, { fnVa: va, primaryOwner: `N${i}::C${i}` });
    }
    const capped = buildVirtualFolderTree({ cxxRtti: { byFunction: many }, maxNodes: 5 });
    for (const [va, fid] of capped.functionToFolderId.entries()) {
      assert.equal(capped.functionToFolderId.has(va), true);
      assert.equal(capped.functionToFolderId.get(va), fid);
    }
    assert.equal([...capped.functionToFolderId.keys()].length, capped.functionToFolderId.size);
  });
});

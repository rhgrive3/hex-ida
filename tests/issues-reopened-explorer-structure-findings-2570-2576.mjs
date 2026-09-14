import assert from 'node:assert/strict';
import { classItems, externalItems, dataItems, findingIdentifier } from '../js/ui/product.js';
import { showStructure } from '../js/ui/panels/file.js';

// Setup mock DOM and environment for testing
const previousWindow = globalThis.window;
const previousDocument = globalThis.document;
const previousRAF = globalThis.requestAnimationFrame;
const previousCAF = globalThis.cancelAnimationFrame;

try {
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

  globalThis.window = {
    innerWidth: 1024,
    innerHeight: 768,
    visualViewport: null,
    addEventListener() {},
    removeEventListener() {},
  };

  // ── #2576: findingIdentifier is stable, deterministic, and never uses raw index ──
  {
    const findingA = {
      title: 'Potential Hardcoded Secret',
      address: 0x10004000n,
      kind: 'secret_leak',
      evidenceId: 'ev-99',
    };
    const findingB = {
      title: 'Root Detection Bypass',
      address: null,
      kind: 'security_control',
    };
    const findingWithExplicitId = {
      id: 'explicit-finding-123',
      title: 'Explicit ID Finding',
    };

    const idA1 = findingIdentifier(findingA, 0);
    const idA2 = findingIdentifier(findingA, 99);
    assert.equal(idA1, idA2, 'finding ID must be stable regardless of array index');
    assert.ok(idA1.startsWith('f-'), 'computed finding ID must start with f- prefix');
    assert.notEqual(idA1, '0', 'must not fallback to array index');

    const idB = findingIdentifier(findingB, 1);
    assert.ok(idB.startsWith('f-'));
    assert.notEqual(idA1, idB, 'different findings must have distinct IDs');

    const idExplicit = findingIdentifier(findingWithExplicitId, 5);
    assert.equal(idExplicit, 'explicit-finding-123');
  }

  // ── #2571: classItems aggregates ObjC, Swift, C++, IL2CPP ──
  {
    const fakeApp = {
      fields: {
        classes: new Map([
          ['NSViewController', { methods: ['loadView', 'viewDidLoad'], ivars: ['_view'], superName: 'NSResponder' }],
        ]),
      },
      swiftModel: {
        types: [
          { name: 'UserProfile', kind: 'struct', fields: ['id', 'name'], addr: 0x2000n },
        ],
      },
      symbols: {
        names: ['_ZTV13AudioRenderer', '_ZTI13AudioRenderer'],
        addrs: [0x3000n, 0x3100n],
      },
      il2cppModel: {
        types: [
          { name: 'PlayerController', namespace: 'Game.Player', addr: 0x4000n },
        ],
      },
    };

    const all = classItems(fakeApp, '');
    assert.equal(all.length, 4, 'must aggregate all 4 class sources');
    assert.ok(all.some((c) => c.kind === 'objc' && c.name === 'NSViewController'));
    assert.ok(all.some((c) => c.kind === 'swift' && c.name === 'UserProfile'));
    assert.ok(all.some((c) => c.kind === 'cxx' && c.name.includes('AudioRenderer')));
    assert.ok(all.some((c) => c.kind === 'il2cpp' && c.name === 'PlayerController'));

    const filtered = classItems(fakeApp, 'audio');
    assert.equal(filtered.length, 1);
    assert.ok(filtered[0].name.includes('AudioRenderer'));
  }

  // ── #2573: externalItems aggregates dependencies and imported APIs ──
  {
    const fakeApp = {
      store: { get: (k) => k === 'fileInfo' ? { name: 'test.dylib' } : null },
      currentSlice: () => ({
        info: {
          formatId: 'macho',
          dependencies: ['/usr/lib/libSystem.B.dylib', '/System/Library/Frameworks/Security.framework/Security'],
        },
      }),
      symbols: {
        symbolCount: 2,
        symbolList: ({ kind }) => kind === 2 /* SYM_STUB */ ? [
          { name: '_SecItemAdd', addr: 0x5000n },
          { name: '_sqlite3_open', addr: 0x5020n },
        ] : [],
      },
      program: null,
    };

    const all = externalItems(fakeApp, '');
    assert.ok(all.some((e) => e.kind === 'dylib' && e.name.includes('Security')));
    assert.ok(all.some((e) => e.kind === 'import' && e.name.includes('SecItemAdd')));
    assert.ok(all.some((e) => e.kind === 'import' && e.name.includes('sqlite3_open')));

    const secHits = externalItems(fakeApp, 'SecItem');
    assert.ok(secHits.length >= 1);
    assert.ok(secHits.some((e) => e.name.includes('SecItemAdd')));
  }

  // ── #2574: dataItems aggregates globals, structs, recovered schemas, and data regions ──
  {
    const fakeApp = {
      store: {
        get: (k) => {
          if (k === 'regions') return [
            { name: '__DATA_CONST', section: '__const', vmAddr: 0x6000n, size: 0x200n, read: true, write: false, exec: false },
          ];
          if (k === 'schemas') return [
            { loader: 0x7000n, files: ['GameConfig.json'], best: { columns: 4 } },
          ];
          return null;
        },
      },
      symbols: {
        symbolCount: 1,
        symbolList: () => [{ name: '_gAppState', addr: 0x6010n }],
      },
      program: {
        refCountOf: () => 3,
        refSitesTo: () => [{ site: 0x1000n }],
      },
      structs: [
        { name: 'PlayerSaveData', size: 128, fields: ['level', 'gold'] },
      ],
      schemas: [
        { loader: 0x7000n, files: ['GameConfig.json'], best: { columns: 4 } },
      ],
    };

    const all = dataItems(fakeApp, '');
    assert.ok(all.some((d) => d.kind === 'global' && d.name.includes('gAppState')));
    assert.ok(all.some((d) => d.kind === 'struct' && d.name === 'PlayerSaveData'));
    assert.ok(all.some((d) => d.kind === 'table' && d.name.includes('GameConfig.json')));
    assert.ok(all.some((d) => d.kind === 'region' && d.name === '__const'));

    const searchHits = dataItems(fakeApp, 'save');
    assert.equal(searchHits.length, 1);
    assert.equal(searchHits[0].name, 'PlayerSaveData');
  }

  // ── #2570: showStructure uses productDescriptor and provides format-unsupported note on non-Mach-O ──
  {
    let appendedNotes = [];

    const overlayElem = {
      append() {},
    };

    // Mock Sheet class
    globalThis.document = {
      getElementById: (id) => id === 'overlays' ? overlayElem : null,
      createElement: (tag) => {
        const elem = {
          tagName: tag.toUpperCase(),
          classList: { add() {}, remove() {}, toggle() {} },
          setAttribute() {},
          style: {},
          dataset: {},
          textContent: '',
          childNodes: [],
          addEventListener() {},
          removeEventListener() {},
          replaceChildren() {},
          append(...children) {
            for (const c of children) {
              if (typeof c === 'string') appendedNotes.push(c);
              else if (c?.textContent) appendedNotes.push(c.textContent);
            }
          },
        };
        return elem;
      },
      body: { append() {} },
    };

    const elfApp = {
      store: { get: (k) => k === 'fileInfo' ? { name: 'sample.elf', format: 'ELF 64-bit LSB executable' } : null },
      currentSlice: () => ({
        offset: 0n,
        info: { formatId: 'elf', cpu: 'x86_64' },
      }),
    };

    showStructure(elfApp);
    assert.ok(appendedNotes.length > 0, 'must show note on non-Mach-O format');
    assert.ok(appendedNotes.some((n) => n.includes('Mach-O') || n.includes('ELF') || n.includes('ファイル構造')), 'note must explain format support');
  }

  console.log('Issues #2570, #2571, #2573, #2574, #2576 regression tests PASS!');
} finally {
  if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
  if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
  if (previousRAF === undefined) delete globalThis.requestAnimationFrame; else globalThis.requestAnimationFrame = previousRAF;
  if (previousCAF === undefined) delete globalThis.cancelAnimationFrame; else globalThis.cancelAnimationFrame = previousCAF;
}

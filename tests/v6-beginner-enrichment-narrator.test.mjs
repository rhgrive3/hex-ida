import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { lang, setLang } from '../js/i18n.js';
import { GLOSSARY_KEY_SET } from '../js/analysis/common/v6-auto-contracts.js';
import { narrateV6Enrichment } from '../js/ui/beginner/enrichment-narrator.js';
import { V6Workbench } from '../js/ui/v6-workbench-bridge.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NARRATOR_PATH = path.resolve(__dirname, '../js/ui/beginner/enrichment-narrator.js');
const INITIAL_LANG = lang();
const VALID_TONES = new Set(['info', 'ok', 'warn']);

function assertValidNarration(result) {
  assert.equal(typeof result, 'object');
  assert.notEqual(result, null);
  assert.ok(result.displayName === null || typeof result.displayName === 'string');
  assert.ok(Array.isArray(result.badges));
  assert.ok(Array.isArray(result.summaryLines));
  assert.ok(Array.isArray(result.highlights));
  assert.ok(Array.isArray(result.glossaryKeys));

  const seenBadgeIds = new Set();
  for (const badge of result.badges) {
    assert.equal(typeof badge.id, 'string');
    assert.ok(badge.id.length > 0);
    assert.equal(seenBadgeIds.has(badge.id), false, `duplicate badge id: ${badge.id}`);
    seenBadgeIds.add(badge.id);
    assert.equal(typeof badge.label, 'string');
    assert.ok(badge.label.length > 0);
    assert.ok(VALID_TONES.has(badge.tone), `invalid badge tone: ${badge.tone}`);
  }

  for (const line of result.summaryLines) {
    assert.equal(typeof line, 'string');
    assert.ok(line.trim().length > 0);
  }
  for (const h of result.highlights) {
    assert.equal(typeof h, 'string');
    assert.ok(h.trim().length > 0);
  }

  const seenKeys = new Set();
  for (const key of result.glossaryKeys) {
    assert.equal(typeof key, 'string');
    assert.equal(GLOSSARY_KEY_SET.has(key), true, `glossary key outside 24-word contract: ${key}`);
    assert.equal(seenKeys.has(key), false, `duplicate glossary key: ${key}`);
    seenKeys.add(key);
  }
}

afterEach(() => {
  setLang(INITIAL_LANG);
});

describe('v6-beginner-enrichment-narrator (Track 5)', () => {
  it('obeys module boundary rules (no js/targets/architecture or js/semantics imports)', () => {
    const src = fs.readFileSync(NARRATOR_PATH, 'utf8');
    assert.equal(/targets\/architecture/.test(src), false, 'must not import js/targets/architecture/');
    assert.equal(/['"][^'"]*\/semantics\//.test(src), false, 'must not import js/semantics/');
  });

  it('handles null, undefined, primitives, and empty objects safely', () => {
    for (const input of [null, undefined, 0, 'foo', true, {}]) {
      const res = narrateV6Enrichment(input);
      assertValidNarration(res);
      assert.equal(res.displayName, null);
      assert.deepEqual(res.badges, []);
      assert.deepEqual(res.summaryLines, []);
      assert.deepEqual(res.highlights, []);
      assert.deepEqual(res.glossaryKeys, []);
    }
  });

  it('does not misfire on a plain C function from real V6Workbench.getFunctionEnrichment', () => {
    setLang('ja');
    const wb = new V6Workbench({});
    const enrichment = wb.getFunctionEnrichment(0x100004000n, { rawName: 'main' });
    assert.equal(enrichment.rawName, 'main');
    assert.equal(enrichment.demangledName, 'main');
    assert.equal(enrichment.displayName, 'main');

    const res = narrateV6Enrichment(enrichment);
    assertValidNarration(res);
    assert.equal(res.displayName, 'main');
    assert.deepEqual(res.badges, []);
    assert.deepEqual(res.summaryLines, []);
    assert.deepEqual(res.highlights, []);
    assert.deepEqual(res.glossaryKeys, []);
  });

  it('respects opts.rawName guard when v6Enrichment.rawName is omitted', () => {
    setLang('en');
    const plain = narrateV6Enrichment({ demangledName: 'printf', displayName: 'printf' }, { rawName: 'printf' });
    assertValidNarration(plain);
    assert.equal(plain.badges.some((b) => b.id === 'demangled'), false);
    assert.equal(plain.glossaryKeys.includes('demangle'), false);

    const mangled = narrateV6Enrichment(
      { demangledName: 'Game::Player::heal(int)', displayName: 'Game::Player::heal(int)' },
      { rawName: '_ZN4Game6Player4healEi' },
    );
    assertValidNarration(mangled);
    assert.equal(mangled.badges.some((b) => b.id === 'demangled' && b.tone === 'info'), true);
    assert.equal(mangled.glossaryKeys.includes('demangle'), true);
  });

  it('narrates all signals from a real V6Workbench.getFunctionEnrichment output', () => {
    setLang('ja');
    const wb = new V6Workbench({});
    const funcVa = '0x100004200';

    // Populate real WASM hints using V6Workbench.ingestWasmAnalysis schema
    wb.ingestWasmAnalysis({
      textVa: '0x100004000',
      xrefLinks: {
        byFunction: {
          [funcVa]: {
            start: funcVa,
            end: '0x100004300',
            name: '_ZN4Game6Player4healEi',
            tags: ['crypto', 'entrypoint'],
            vtableRefs: [{ va: '0x100008000' }],
            constTableRefs: [{ va: '0x100009000' }],
          },
        },
      },
      rmw: [
        { funcVa, va: '0x100004220' },
        { funcVa, va: '0x100004240' },
      ],
      jumpTables: [{ funcVa, va: '0x100004260', entries: 4 }],
      callgraph: {
        nodes: [{ va: funcVa }],
        role: [3],
        score: [0.92],
      },
    });

    // Populate real STL recognition (>= 2 evidence items required by StlPatternRecognizer)
    wb.recognizeStlPattern({
      funcVa,
      symbols: ['std::vector<int>::push_back'],
      fields: [
        { offset: 0, size: 8 },
        { offset: 8, size: 8 },
        { offset: 16, size: 8 },
      ],
      structSize: 24,
      ptrSize: 8,
    });

    // Populate real deobfuscation overlay summary (MBA simplification)
    wb.runDeobfuscationPass({
      funcVa,
      mbaNodes: [
        {
          va: '0x100004210',
          dag: {
            op: 'add',
            left: { op: 'xor', left: { op: 'var', name: 'x' }, right: { op: 'var', name: 'y' } },
            right: {
              op: 'mul',
              left: { op: 'const', value: 2 },
              right: { op: 'and', left: { op: 'var', name: 'x' }, right: { op: 'var', name: 'y' } },
            },
          },
        },
      ],
    });

    const realEnrichment = wb.getFunctionEnrichment(funcVa);
    assert.equal(realEnrichment.rawName, '_ZN4Game6Player4healEi');
    assert.notEqual(realEnrichment.demangledName, realEnrichment.rawName);
    assert.equal(realEnrichment.stl?.recognized, true);

    // Attach HexSig match and TIL signature as Phase 2b enrichment does
    const fullEnrichment = {
      ...realEnrichment,
      hexsigMatch: {
        vaHex: funcVa,
        oldName: 'sub_100004200',
        newName: 'AES_encrypt',
        libId: 1,
        libName: 'libcrypto',
        score: 96,
        margin: 35,
        engine: 'wasm',
        verdict: 1,
      },
      tilSignature: {
        matchedName: 'AES_encrypt',
        arity: 3,
        retTypeStr: 'void',
        packId: 'openssl-core',
        callConv: 'aapcs64',
      },
    };

    const res = narrateV6Enrichment(fullEnrichment);
    assertValidNarration(res);

    assert.equal(res.displayName, realEnrichment.displayName);
    const badgeIds = new Set(res.badges.map((b) => b.id));
    assert.equal(badgeIds.has('demangled'), true);
    assert.equal(badgeIds.has('hexsig'), true);
    assert.equal(badgeIds.has('til'), true);
    assert.equal(badgeIds.has('stl'), true);
    assert.equal(badgeIds.has('wasm-crypto'), true);
    assert.equal(badgeIds.has('wasm-entry'), true);
    assert.equal(badgeIds.has('vtable'), true);
    assert.equal(badgeIds.has('rmw'), true);
    assert.equal(badgeIds.has('jump-table'), true);
    assert.equal(badgeIds.has('cg-role'), true);

    assert.ok(res.summaryLines.length >= 9);
    assert.ok(res.highlights.length >= 8);

    const keySet = new Set(res.glossaryKeys);
    for (const expectedKey of [
      'demangle',
      'hexsig',
      'stripped',
      'til',
      'calling_convention',
      'stl_container',
      'entrypoint',
      'vtable',
      'pointer',
      'patch',
      'branch',
      'cfg',
      'xref',
    ]) {
      assert.equal(keySet.has(expectedKey), true, `expected glossary key: ${expectedKey}`);
    }
  });

  it('narrates CFF + MBA deobfuscation overlay and generic annotation overlay', () => {
    setLang('ja');
    const cffAndMba = narrateV6Enrichment({
      displayName: 'sub_1000',
      deobfOverlay: {
        hasOverlay: true,
        annotation: { text: 'CFF recovered + MBA simplified' },
        summary: {
          cffRecovered: true,
          mba: { total: 4, simplifiedCount: 3, nodesEliminated: 12 },
          overlayCount: 4,
        },
      },
    });
    assertValidNarration(cffAndMba);
    assert.equal(cffAndMba.badges.some((b) => b.id === 'deobf' && b.tone === 'warn'), true);
    assert.equal(cffAndMba.glossaryKeys.includes('cff'), true);
    assert.equal(cffAndMba.glossaryKeys.includes('cfg'), true);
    assert.equal(cffAndMba.glossaryKeys.includes('mba'), true);

    const genericOverlay = narrateV6Enrichment({
      displayName: 'sub_2000',
      deobfOverlay: {
        hasOverlay: true,
        annotation: { text: 'custom pass' },
        summary: null,
      },
    });
    assertValidNarration(genericOverlay);
    assert.equal(genericOverlay.badges.some((b) => b.id === 'deobf'), true);
    assert.equal(genericOverlay.glossaryKeys.includes('decompile'), true);

    const inactiveOverlay = narrateV6Enrichment({
      displayName: 'sub_3000',
      deobfOverlay: { hasOverlay: false, annotation: null, summary: null },
    });
    assertValidNarration(inactiveOverlay);
    assert.deepEqual(inactiveOverlay.badges, []);
  });

  it('handles partial objects and all callgraph roles cleanly', () => {
    setLang('en');

    // wasmHints.available === false should produce nothing even if sub-fields exist
    const unavailable = narrateV6Enrichment({
      wasmHints: { available: false, tags: ['crypto'], rmwHitCount: 5 },
    });
    assertValidNarration(unavailable);
    assert.deepEqual(unavailable.badges, []);

    // Normal callgraph role (0) should not emit a badge
    const normalCg = narrateV6Enrichment({
      wasmHints: { available: true, callgraph: { role: 0, roleName: 'normal' } },
    });
    assertValidNarration(normalCg);
    assert.deepEqual(normalCg.badges, []);

    // Dispatcher, recursive_scc, leaf_compute, utility_hub
    for (const [role, expectedTone] of [
      [{ role: 1 }, 'info'],
      [{ role: 2 }, 'info'],
      [{ role: 3 }, 'warn'],
      [{ role: 4 }, 'warn'],
    ]) {
      const r = narrateV6Enrichment({
        wasmHints: { available: true, callgraph: role },
      });
      assertValidNarration(r);
      assert.equal(r.badges.some((b) => b.id === 'cg-role' && b.tone === expectedTone), true);
    }

    // Partial string tilSignature and non-recognized stl
    const partial = narrateV6Enrichment({
      tilSignature: 'int foo(int a)',
      stl: { recognized: false, primary: null, matches: [] },
      hexsigMatch: { newName: 'memcpy' },
    });
    assertValidNarration(partial);
    assert.equal(partial.badges.some((b) => b.id === 'til'), true);
    assert.equal(partial.badges.some((b) => b.id === 'hexsig'), true);
    assert.equal(partial.badges.some((b) => b.id === 'stl'), false);
    assert.equal(partial.glossaryKeys.includes('stripped'), false);
  });

  it('switches output cleanly between Japanese (ja) and English (en)', () => {
    const sample = {
      rawName: '_ZN3App4initEv',
      demangledName: 'App::init()',
      displayName: 'App::init()',
      hexsigMatch: {
        oldName: 'sub_401000',
        newName: 'SSL_connect',
        libName: 'libssl',
      },
      tilSignature: {
        matchedName: 'SSL_connect',
        arity: 1,
        retTypeStr: 'int',
        packId: 'openssl-core',
      },
      deobfOverlay: {
        hasOverlay: true,
        summary: { cffRecovered: true, mba: { simplifiedCount: 1 } },
      },
      stl: {
        recognized: true,
        primary: { kind: 'std::shared_ptr', abiFamily: 'libc++' },
      },
      wasmHints: {
        available: true,
        tags: ['crypto', 'syscall'],
        vtableRefs: [{ va: '0x5000' }],
        constTableRefs: [{ va: '0x6000' }],
        rmwHitCount: 1,
        jumpTableCount: 2,
        callgraph: { role: 3, roleName: 'utility_hub' },
      },
    };

    setLang('ja');
    const jaRes = narrateV6Enrichment(sample);
    assertValidNarration(jaRes);

    setLang('en');
    const enRes = narrateV6Enrichment(sample);
    assertValidNarration(enRes);

    // Same structural ids & glossary keys across languages
    assert.deepEqual(
      jaRes.badges.map((b) => ({ id: b.id, tone: b.tone })),
      enRes.badges.map((b) => ({ id: b.id, tone: b.tone })),
    );
    assert.deepEqual(jaRes.glossaryKeys, enRes.glossaryKeys);

    // Localized Japanese vs English text
    assert.match(jaRes.summaryLines.join('\n'), /[ぁ-んァ-ヶ一-龯]/);
    assert.equal(/[ぁ-んァ-ヶ一-龯]/.test(enRes.summaryLines.join('\n')), false);
    assert.equal(/[ぁ-んァ-ヶ一-龯]/.test(enRes.highlights.join('\n')), false);
    assert.equal(/[ぁ-んァ-ヶ一-龯]/.test(enRes.badges.map((b) => b.label).join('\n')), false);
  });
});

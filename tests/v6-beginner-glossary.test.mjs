import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { lang, setLang } from '../js/i18n.js';
import {
  GLOSSARY_KEYS as CONTRACT_GLOSSARY_KEYS,
  GLOSSARY_KEY_SET as CONTRACT_GLOSSARY_KEY_SET,
} from '../js/analysis/common/v6-auto-contracts.js';
import {
  GLOSSARY_KEYS,
  GLOSSARY_KEY_SET,
  GLOSSARY_ALIASES,
  getGlossaryEntry,
  listGlossaryEntries,
  annotateGlossaryTerms,
  describeMangleKindForBeginner,
} from '../js/ui/beginner/glossary-translator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRANSLATOR_PATH = path.resolve(__dirname, '../js/ui/beginner/glossary-translator.js');
const INITIAL_LANG = lang();

afterEach(() => {
  setLang(INITIAL_LANG);
});

describe('v6-beginner-glossary (Track 7)', () => {
  it('re-exports canonical 24 GLOSSARY_KEYS and adheres to INV-005 module boundary', () => {
    assert.strictEqual(GLOSSARY_KEYS, CONTRACT_GLOSSARY_KEYS);
    assert.strictEqual(GLOSSARY_KEY_SET, CONTRACT_GLOSSARY_KEY_SET);
    assert.equal(GLOSSARY_KEYS.length, 24);
    assert.equal(Object.isFrozen(GLOSSARY_ALIASES), true);

    for (const key of GLOSSARY_KEYS) {
      assert.equal(Array.isArray(GLOSSARY_ALIASES[key]), true, `missing alias list for ${key}`);
      assert.ok(GLOSSARY_ALIASES[key].length > 0, `empty alias list for ${key}`);
      assert.equal(Object.isFrozen(GLOSSARY_ALIASES[key]), true, `alias list not frozen for ${key}`);
    }

    const src = fs.readFileSync(TRANSLATOR_PATH, 'utf8');
    assert.equal(src.includes('targets/architecture'), false, 'must not import js/targets/architecture/');
    assert.equal(src.includes('/semantics/'), false, 'must not import js/semantics/');
    assert.equal(src.includes('glossary.js'), false, 'must not depend on legacy js/glossary.js');
  });

  it('returns complete bilingual entries for all 24 fixed keys in both ja and en', () => {
    for (const key of GLOSSARY_KEYS) {
      setLang('ja');
      const jaEntry = getGlossaryEntry(key);
      assert.ok(jaEntry, `missing ja entry for ${key}`);
      assert.equal(jaEntry.key, key);
      for (const field of ['term', 'shortLabel', 'explanation', 'tip']) {
        assert.equal(typeof jaEntry[field], 'string', `ja.${field} must be string for ${key}`);
        assert.ok(jaEntry[field].trim().length > 0, `ja.${field} must be non-empty for ${key}`);
      }

      setLang('en');
      const enEntry = getGlossaryEntry(key);
      assert.ok(enEntry, `missing en entry for ${key}`);
      assert.equal(enEntry.key, key);
      for (const field of ['term', 'shortLabel', 'explanation', 'tip']) {
        assert.equal(typeof enEntry[field], 'string', `en.${field} must be string for ${key}`);
        assert.ok(enEntry[field].trim().length > 0, `en.${field} must be non-empty for ${key}`);
      }

      assert.notEqual(jaEntry.explanation, enEntry.explanation, `ja/en explanation should differ for ${key}`);
      assert.notEqual(jaEntry.shortLabel, enEntry.shortLabel, `ja/en shortLabel should differ for ${key}`);
    }

    assert.equal(getGlossaryEntry('nonexistent_key'), null);
    assert.equal(getGlossaryEntry(''), null);
    assert.equal(getGlossaryEntry(null), null);
    assert.equal(getGlossaryEntry(undefined), null);
    assert.equal(getGlossaryEntry(123), null);
    assert.equal(getGlossaryEntry('  PAC  ')?.key, 'pac');
  });

  it('listGlossaryEntries returns all 24 entries by default and deduplicates filtered lists', () => {
    const all = listGlossaryEntries();
    assert.equal(all.length, 24);
    assert.deepEqual(all.map((e) => e.key), [...GLOSSARY_KEYS]);

    const filtered = listGlossaryEntries(['pac', 'cfg', 'unknown', 'pac', 'til', null]);
    assert.deepEqual(filtered.map((e) => e.key), ['pac', 'cfg', 'til']);

    const fromSet = listGlossaryEntries(new Set(['xref', 'vtable']));
    assert.deepEqual(fromSet.map((e) => e.key), ['xref', 'vtable']);

    assert.deepEqual(listGlossaryEntries('pac'), []);
    assert.deepEqual(listGlossaryEntries(42), []);
  });

  it('prevents ASCII substring false positives (unpacked, until, config, message, forgot)', () => {
    const safeSentence = 'Wait until unpacked config message forgot mycfg cfg1 pac2 til_x ssa9.';
    const res = annotateGlossaryTerms(safeSentence);
    assert.deepEqual(res.matchedKeys, []);
    assert.deepEqual(res.segments, [{ text: safeSentence, glossaryKey: null }]);
  });

  it('escapes regex metacharacters and matches C++, PLT/GOT, std::unordered_map, and Japanese-adjacent terms', () => {
    const text = 'C++の関数がPLT/GOT経由でstd::unordered_mapとPAC署名およびCFG解析を使う。';
    const res = annotateGlossaryTerms(text);

    assert.equal(res.segments.map((s) => s.text).join(''), text);
    assert.deepEqual(res.matchedKeys, ['demangle', 'plt_got', 'stl_container', 'pac', 'cfg']);

    const annotated = res.segments.filter((s) => s.glossaryKey !== null);
    assert.deepEqual(annotated, [
      { text: 'C++', glossaryKey: 'demangle' },
      { text: 'PLT/GOT', glossaryKey: 'plt_got' },
      { text: 'std::unordered_map', glossaryKey: 'stl_container' },
      { text: 'PAC', glossaryKey: 'pac' },
      { text: 'CFG', glossaryKey: 'cfg' },
    ]);

    // Ensure "AC++" does not false-match "C++" due to leading ASCII word boundary
    const boundaryCheck = annotateGlossaryTerms('AC++ is not C++');
    assert.deepEqual(boundaryCheck.segments, [
      { text: 'AC++ is not ', glossaryKey: null },
      { text: 'C++', glossaryKey: 'demangle' },
    ]);
  });

  it('prefers longest match first (C++ STL over C++, PLT/GOT over PLT, control flow flattening over CFF)', () => {
    const text = 'Uses C++ STL with PLT/GOT and Control Flow Flattening.';
    const res = annotateGlossaryTerms(text);

    assert.equal(res.segments.map((s) => s.text).join(''), text);
    assert.deepEqual(res.matchedKeys, ['stl_container', 'plt_got', 'cff']);

    const matched = res.segments.filter((s) => s.glossaryKey !== null);
    assert.deepEqual(matched, [
      { text: 'C++ STL', glossaryKey: 'stl_container' },
      { text: 'PLT/GOT', glossaryKey: 'plt_got' },
      { text: 'Control Flow Flattening', glossaryKey: 'cff' },
    ]);
  });

  it('preserves first-seen order and deduplicates matchedKeys, maintaining segments invariants', () => {
    const text = 'TIL helps CFG, then PAC checks CFG and TIL again.';
    const res = annotateGlossaryTerms(text);

    assert.deepEqual(res.matchedKeys, ['til', 'cfg', 'pac']);
    assert.equal(res.segments.map((s) => s.text).join(''), text);
    for (let i = 0; i < res.segments.length; i++) {
      assert.ok(res.segments[i].text.length > 0, 'no empty segments allowed');
      if (i > 0 && res.segments[i].glossaryKey === null) {
        assert.notEqual(res.segments[i - 1].glossaryKey, null, 'no adjacent null segments');
      }
      if (res.segments[i].glossaryKey !== null) {
        assert.equal(GLOSSARY_KEY_SET.has(res.segments[i].glossaryKey), true);
      }
    }

    assert.deepEqual(annotateGlossaryTerms(''), { segments: [], matchedKeys: [] });
    assert.deepEqual(annotateGlossaryTerms(null), { segments: [], matchedKeys: [] });
    assert.deepEqual(annotateGlossaryTerms(undefined), { segments: [], matchedKeys: [] });
  });

  it('enforces maxInputLength guard while protecting UTF-16 surrogate pairs', () => {
    // 'PAC ' (4) + '😀' (2 code units at indices 4..5) + ' CFG' (4)
    const text = 'PAC 😀 CFG';
    // Cutting at 5 would fall between high surrogate (4) and low surrogate (5)
    const res = annotateGlossaryTerms(text, { maxInputLength: 5 });

    assert.equal(res.segments.map((s) => s.text).join(''), text);
    assert.deepEqual(res.matchedKeys, ['pac']);
    // Verify no segment contains an unpaired surrogate
    for (const seg of res.segments) {
      for (let i = 0; i < seg.text.length; i++) {
        const cu = seg.text.charCodeAt(i);
        if (cu >= 0xD800 && cu <= 0xDBFF) {
          const next = seg.text.charCodeAt(i + 1);
          assert.ok(next >= 0xDC00 && next <= 0xDFFF, 'high surrogate must stay paired with low surrogate');
          i++;
        } else {
          assert.equal(cu >= 0xDC00 && cu <= 0xDFFF, false, 'no orphan low surrogate allowed');
        }
      }
    }

    // maxInputLength: 0 skips regex scanning completely while preserving text
    const zeroLimit = annotateGlossaryTerms('PAC CFG TIL', { maxInputLength: 0 });
    assert.deepEqual(zeroLimit, {
      segments: [{ text: 'PAC CFG TIL', glossaryKey: null }],
      matchedKeys: [],
    });

    // Surrogate pair at index 0..1 with maxInputLength: 1 must back off to 0
    const leadSurrogate = annotateGlossaryTerms('😀PAC', { maxInputLength: 1 });
    assert.deepEqual(leadSurrogate, {
      segments: [{ text: '😀PAC', glossaryKey: null }],
      matchedKeys: [],
    });
  });

  it('preserves XSS payloads verbatim as pure data without generating HTML strings', () => {
    const payload = '<script>alert("PAC & CFG")</script><img src=x onerror="alert(1)">';
    const res = annotateGlossaryTerms(payload);

    assert.equal(res.segments.map((s) => s.text).join(''), payload);
    assert.deepEqual(res.matchedKeys, ['pac', 'cfg']);
    // Must not inject any wrapper HTML tags like <span> or <mark>
    for (const seg of res.segments) {
      assert.equal(seg.text.includes('<span'), false);
      assert.equal(seg.text.includes('<mark'), false);
    }
    assert.equal(res.segments[0].text, '<script>alert("');
    assert.equal(res.segments[0].glossaryKey, null);
    assert.equal(res.segments[1].text, 'PAC');
    assert.equal(res.segments[1].glossaryKey, 'pac');
  });

  it('describeMangleKindForBeginner covers all DEMANGLE_KIND values and string forms in ja/en', () => {
    const kinds = [0, 1, 2, 3, 4, 5, 'none', 'itanium_cpp', 'rust_v0', 'rust_legacy', 'swift', 'msvc_cpp', 'objc', 'unknown', null];
    for (const k of kinds) {
      setLang('ja');
      const jaDesc = describeMangleKindForBeginner(k);
      setLang('en');
      const enDesc = describeMangleKindForBeginner(k);

      assert.equal(typeof jaDesc, 'string');
      assert.ok(jaDesc.length > 0, `empty ja description for ${String(k)}`);
      assert.equal(typeof enDesc, 'string');
      assert.ok(enDesc.length > 0, `empty en description for ${String(k)}`);
      assert.notEqual(jaDesc, enDesc, `ja/en description should differ for ${String(k)}`);
    }

    setLang('en');
    assert.equal(describeMangleKindForBeginner(1), describeMangleKindForBeginner('itanium_cpp'));
    assert.equal(describeMangleKindForBeginner(2), describeMangleKindForBeginner('rust_v0'));
    assert.equal(describeMangleKindForBeginner(3), describeMangleKindForBeginner('rust_legacy'));
    assert.equal(describeMangleKindForBeginner(4), describeMangleKindForBeginner('swift'));
    assert.equal(describeMangleKindForBeginner(5), describeMangleKindForBeginner('msvc_cpp'));
  });
});

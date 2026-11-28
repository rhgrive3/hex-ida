import test from 'node:test';
import assert from 'node:assert/strict';

/* Minimal DOM shim so UI helpers and renderers can be exercised directly in Node. */
class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.attributes = new Map();
    this.dataset = {};
    this.style = { setProperty() {} };
    this._text = '';
    this.className = '';
    this.listeners = new Map();
    this.hidden = false;
    this.disabled = false;
    this.type = '';
    this.title = '';
    this.id = '';
    this.lang = '';
  }

  get childNodes() { return this.children; }

  get classList() {
    const self = this;
    const tokens = () => self.className.split(/\s+/).filter(Boolean);
    return {
      add(...cls) {
        const set = new Set(tokens());
        for (const c of cls) if (c) set.add(c);
        self.className = [...set].join(' ');
      },
      remove(...cls) {
        const set = new Set(tokens());
        for (const c of cls) set.delete(c);
        self.className = [...set].join(' ');
      },
      contains(c) { return tokens().includes(c); },
      toggle(c, force) {
        const has = this.contains(c);
        const next = force !== undefined ? !!force : !has;
        if (next) this.add(c); else this.remove(c);
        return next;
      },
    };
  }

  get textContent() {
    if (!this.children.length) return this._text;
    return this._text + this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
  }

  set textContent(val) {
    this._text = String(val ?? '');
    this.children = [];
  }

  setAttribute(k, v) { this.attributes.set(k, String(v)); }
  getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }

  append(...nodes) {
    for (const n of nodes) {
      if (n == null || n === false) continue;
      if (typeof n === 'string') {
        this._text += n;
      } else {
        n.parentElement = this;
        this.children.push(n);
      }
    }
  }

  replaceChildren(...nodes) {
    this._text = '';
    this.children = [];
    this.append(...nodes);
  }

  remove() {
    if (!this.parentElement) return;
    const idx = this.parentElement.children.indexOf(this);
    if (idx >= 0) this.parentElement.children.splice(idx, 1);
    this.parentElement = null;
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }

  removeEventListener(type, fn) {
    const list = this.listeners.get(type);
    if (!list) return;
    const idx = list.indexOf(fn);
    if (idx >= 0) list.splice(idx, 1);
  }

  click() {
    for (const fn of this.listeners.get('click') || []) {
      fn({ currentTarget: this, target: this, preventDefault() {}, stopPropagation() {} });
    }
  }

  _matches(selector) {
    const sel = selector.trim();
    if (sel.startsWith('.')) return this.classList.contains(sel.slice(1));
    if (sel.startsWith('#')) return this.id === sel.slice(1);
    return this.tagName === sel.toUpperCase();
  }

  querySelectorAll(selector) {
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (typeof child === 'string') continue;
        if (child._matches(selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

const fakeDocEl = new FakeElement('html');
fakeDocEl.lang = 'ja';
globalThis.document = {
  documentElement: fakeDocEl,
  createElement: (tag) => new FakeElement(tag),
  createDocumentFragment: () => new FakeElement('fragment'),
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
  title: '',
};
globalThis.window = globalThis;

import { setLang } from '../js/i18n.js';
import {
  reasonText, statusCodeDetails, statusNotice, emptyState, errorState,
} from '../js/ui/primitives.js';
import {
  formatCandidateReason, formatCandidateReasons, describeStrongestAnswer, appendCompleteness,
} from '../js/ui/panels/investigation.js';
import {
  formatBlockCount, isBinaryUnboundError, renderBinaryUnboundCard, buildInitialLandingCard,
} from '../js/ui/product-base.js';
import { formatAnalysisStatus } from '../js/ui/product-hardened.js';

function withLang(lang, fn) {
  const prevDoc = fakeDocEl.lang;
  fakeDocEl.lang = lang;
  setLang(lang);
  try { return fn(); }
  finally {
    fakeDocEl.lang = prevDoc;
    setLang(prevDoc);
  }
}

/* ── Item 5.3: Concrete Candidate Reasons & Strongest Answer ─── */

test('5.3 formatCandidateReason includes concrete details for string-ref, caller/callee, crypto-const, store, name-match', () => {
  withLang('ja', () => {
    assert.equal(
      formatCandidateReason({ code: 'string-ref', detail: { text: 'hp_max' } }),
      '"hp_max" を参照',
    );
    assert.equal(
      formatCandidateReason({ code: 'called-by-match', detail: { fromName: '-[Player damage:]' } }),
      '-[Player damage:] から呼ばれる',
    );
    assert.equal(
      formatCandidateReason({ code: 'caller-name', detail: { name: '-[BattleManager tick]' } }),
      '-[BattleManager tick] から呼ばれる',
    );
    assert.equal(
      formatCandidateReason({ code: 'callee-name', detail: { name: '-[Player setHp:]' } }),
      '-[Player setHp:] を呼ぶ',
    );
    assert.equal(
      formatCandidateReason({ code: 'crypto-const', detail: { name: 'AES S-box', algo: 'aes' } }),
      '暗号定数 (AES S-box) を参照',
    );
    assert.equal(
      formatCandidateReason({ code: 'store', detail: { field: 'Player.hp' } }),
      'Player.hp へ書き込む',
    );
    assert.equal(
      formatCandidateReason({ code: 'name-match', detail: { name: '-[Player takeDamage:]', term: 'damage' } }),
      '関数名 "-[Player takeDamage:]" が一致',
    );
  });

  withLang('en', () => {
    assert.equal(
      formatCandidateReason({ code: 'string-ref', detail: { text: 'hp_max' } }),
      'Refers to "hp_max"',
    );
    assert.equal(
      formatCandidateReason({ code: 'called-by-match', detail: { fromName: '-[Player damage:]' } }),
      'Called by -[Player damage:]',
    );
    assert.equal(
      formatCandidateReason({ code: 'crypto-const', detail: { name: 'SHA-256 K', algo: 'sha256' } }),
      'References crypto constant (SHA-256 K)',
    );
  });
});

test('5.3 formatCandidateReasons deduplicates generic/identical reasons and prioritizes distinct kinds', () => {
  withLang('ja', () => {
    // Duplicate vague string-ref reasons without details must collapse to 1
    const dupGeneric = formatCandidateReasons([
      { code: 'string-ref', points: 20 },
      { code: 'string-ref', points: 12 },
    ], 2);
    assert.deepEqual(dupGeneric, ['文字列を参照']);

    // Duplicate identical concrete reasons must collapse to 1
    const dupConcrete = formatCandidateReasons([
      { code: 'string-ref', points: 20, detail: { text: 'hp_max' } },
      { code: 'string-ref', points: 12, detail: { text: 'hp_max' } },
    ], 2);
    assert.deepEqual(dupConcrete, ['"hp_max" を参照']);

    // Distinct reason kinds are prioritized over a second string-ref
    const mixed = formatCandidateReasons([
      { code: 'string-ref', points: 20, detail: { text: 'hp_max' } },
      { code: 'string-ref', points: 12, detail: { text: 'hp_cur' } },
      { code: 'called-by-match', points: 8, detail: { fromName: '-[Player damage:]' } },
    ], 2);
    assert.deepEqual(mixed, ['"hp_max" を参照', '-[Player damage:] から呼ばれる']);
  });
});

test('5.3 describeStrongestAnswer includes #1 candidate name, address, and strongest concrete reason', () => {
  withLang('ja', () => {
    const app = { symbols: { nameAt: (a) => (BigInt(a) === 0x10004000n ? '-[Player takeDamage:]' : null) } };
    const goal = { id: 'hp', ja: 'HP・体力', en: 'HP' };
    const pin = { verdict: 'likely', top: { addr: 0x10004000n } };
    const ranked = [
      {
        addr: 0x10004000n,
        name: '-[Player takeDamage:]',
        reasons: [
          { code: 'string-ref', points: 20, detail: { text: 'hp_max' } },
          { code: 'called-by-match', points: 8, detail: { fromName: '-[Battle resolve]' } },
        ],
      },
    ];
    const desc = describeStrongestAnswer(app, goal, pin, ranked);
    assert.equal(desc.title, '-[Player takeDamage:]');
    assert.equal(desc.addrText, '0x10004000');
    assert.equal(desc.strongestReason, '"hp_max" を参照');
    assert.notEqual(desc.title, 'HP・体力');
  });
});

/* ── Item 5.6: Human-Friendly Status & Error Codes ──────────── */

test('5.6 reasonText maps all required internal codes in JA and EN and rejects prototype keys', () => {
  const codes = [
    'result-limit',
    'function-discovery-incomplete',
    'function-scan-budget',
    'function-filter-page-bounded',
    'evidence-store-unavailable',
    'analysis-query-binary-unbound',
    'per-function-budget-exceeded',
  ];
  withLang('ja', () => {
    for (const code of codes) {
      const msg = reasonText(code);
      assert.ok(msg && msg.length > 5, `JA reasonText missing for ${code}`);
      assert.ok(!msg.includes(code), `JA reasonText must not echo raw code ${code}`);
    }
    assert.equal(
      reasonText('function-discovery-incomplete'),
      '関数をまだ全部は見つけていません。引き続き探索できます。',
    );
    assert.equal(
      reasonText('region0:function-discovery-incomplete'),
      '関数をまだ全部は見つけていません。引き続き探索できます。',
    );
    assert.equal(reasonText('constructor'), null);
    assert.equal(reasonText('toString'), null);
  });

  withLang('en', () => {
    for (const code of codes) {
      const msg = reasonText(code);
      assert.ok(msg && msg.length > 5, `EN reasonText missing for ${code}`);
      assert.ok(!msg.includes(code), `EN reasonText must not echo raw code ${code}`);
    }
  });
});

test('5.6 statusNotice, errorState, and appendCompleteness place raw codes inside <details> and offer continuation action', () => {
  withLang('ja', () => {
    let continued = false;
    const host = new FakeElement('div');
    const notice = appendCompleteness(host, {
      completeness: { complete: false, reasons: ['function-discovery-incomplete'] },
    }, { onContinue: () => { continued = true; } });

    assert.ok(notice);
    const msgEl = notice.querySelector('.ui-status-message');
    assert.ok(msgEl);
    assert.ok(msgEl.textContent.includes('関数をまだ全部は見つけていません。引き続き探索できます。'));
    assert.ok(!msgEl.textContent.includes('function-discovery-incomplete'), 'Main message must not dump raw hyphenated code');

    const details = notice.querySelector('details');
    assert.ok(details, 'Raw code must be wrapped in <details>');
    assert.equal(details.querySelector('summary')?.textContent, 'くわしい情報');
    assert.equal(details.querySelector('code')?.textContent, 'function-discovery-incomplete');

    const actionBtn = notice.querySelector('.ui-status-action');
    assert.ok(actionBtn, 'Should render continuation button');
    assert.equal(actionBtn.textContent, '続きを調べる');
    actionBtn.click();
    assert.equal(continued, true);

    // errorState / emptyState also tuck raw code inside <details>
    const errNode = errorState('エラー', 'per-function-budget-exceeded');
    const errText = errNode.querySelector('.ui-state-text');
    assert.ok(errText.textContent.includes('計算上限'));
    assert.ok(!errText.textContent.includes('per-function-budget-exceeded'));
    const errDetails = errNode.querySelector('details');
    assert.ok(errDetails);
    assert.equal(errDetails.querySelector('summary')?.textContent, 'くわしい情報');
    assert.equal(errDetails.querySelector('code')?.textContent, 'per-function-budget-exceeded');

    // statusCodeDetails directly
    const det = statusCodeDetails(['result-limit', 'function-scan-budget']);
    assert.equal(det.tagName, 'DETAILS');
    assert.equal(det.querySelector('code')?.textContent, 'result-limit, function-scan-budget');

    // statusNotice with EN
    const enNotice = withLang('en', () => statusNotice('result-limit'));
    assert.equal(enNotice.querySelector('summary')?.textContent, 'Details');
    assert.equal(enNotice.querySelector('code')?.textContent, 'result-limit');

    // emptyState with plain text does not create <details>
    const plainEmpty = emptyState('タイトル', '通常のメッセージ');
    assert.equal(plainEmpty.querySelector('details'), null);
    assert.equal(plainEmpty.querySelector('.ui-state-code'), null);
  });
});

/* ── Item 5.7: Small UX Polish ──────────────────────────────── */

test('5.7 formatBlockCount displays 計算中 / Computing... when blocks === 0 for non-empty functions', () => {
  withLang('ja', () => {
    assert.equal(formatBlockCount(0, { instructions: 12 }), '計算中');
    assert.equal(formatBlockCount(0, { size: 48 }), '計算中');
    assert.equal(formatBlockCount(null, { instructions: 8 }), '計算中');
    assert.equal(formatBlockCount(0, { instructions: 0, size: 0 }), '0');
    assert.equal(formatBlockCount(5, { instructions: 20 }), '5');
    assert.equal(formatBlockCount(null, { instructions: 0 }), '—');
  });
  withLang('en', () => {
    assert.equal(formatBlockCount(0, { instructions: 12 }), 'Computing...');
    assert.equal(formatBlockCount(0, { size: 64 }), 'Computing...');
    assert.equal(formatBlockCount(3, { instructions: 12 }), '3');
  });
});

test('5.7 formatAnalysisStatus consolidates partial status into a single non-contradictory badge', () => {
  withLang('ja', () => {
    const partial = formatAnalysisStatus('partial');
    assert.equal(partial.key, 'likely');
    assert.equal(partial.label, '一部のみ確認（可能性が高い）');
    assert.equal(partial.badge.textContent, '一部のみ確認（可能性が高い）');
    assert.equal(partial.badge.dataset.evidence, 'likely');

    const complete = formatAnalysisStatus('complete');
    assert.equal(complete.key, 'confirmed');
    assert.equal(complete.label, '確認済み');

    const unsupported = formatAnalysisStatus('unsupported');
    assert.equal(unsupported.key, 'unverified');
    assert.equal(unsupported.label, '未対応');
  });
  withLang('en', () => {
    const partial = formatAnalysisStatus('partial');
    assert.equal(partial.label, 'Partially verified (likely)');
    const complete = formatAnalysisStatus('complete');
    assert.equal(complete.label, 'Confirmed');
  });
});

test('5.7 reload without binary renders friendly 前回のファイルを開く guidance card and restores saved file', async () => {
  assert.equal(isBinaryUnboundError(new Error('analysis-query-binary-unbound')), true);
  assert.equal(isBinaryUnboundError(new Error('other-error')), false);

  await withLang('ja', async () => {
    let openedFile = null;
    let openedOpts = null;
    const fakeFile = { name: 'game.dylib' };
    const app = {
      analysisResume: { loadLastFile: async () => ({ file: fakeFile }) },
      openFile: async (f, opts) => { openedFile = f; openedOpts = opts; },
      openSample: () => {},
    };
    const cardNode = renderBinaryUnboundCard(app);
    assert.ok(cardNode.classList.contains('ui-binary-unbound-card'));
    assert.ok(!cardNode.classList.contains('ui-error-state'), 'Must not be a raw error banner');
    assert.ok(!cardNode.textContent.includes('analysis-query-binary-unbound'));

    const prevBtn = cardNode.querySelector('.ui-open-previous-btn');
    assert.ok(prevBtn);
    assert.equal(prevBtn.textContent, '前回のファイルを開く');
    prevBtn.click();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(openedFile, fakeFile);
    assert.deepEqual(openedOpts, { restored: true });
  });
});

test('5.7 buildInitialLandingCard provides quick-start goals, top classes, frequently called functions, and dismiss', () => {
  withLang('ja', () => {
    const navigated = [];
    let dismissed = false;
    const router = { navigate: (path) => navigated.push(path) };
    const app = {
      store: {
        get: (k) => (k === 'fileInfo' ? { name: 'BattleCats' } : k === 'regions' ? [] : null),
      },
      appMap: {
        classes: [
          { name: 'PlayerController', count: 14 },
          { name: 'BattleManager', count: 9 },
        ],
        hotFunctions: [
          { addr: 0x10002000n, name: '-[PlayerController takeDamage:]', callCount: 18 },
          { addr: 0x10003000n, name: '-[BattleManager update:]', callCount: 12 },
        ],
      },
      symbols: { functionCount: 1234, nameAt: () => null },
      openOverview: () => navigated.push('overview'),
    };

    const cardNode = buildInitialLandingCard(app, router, { onDismiss: () => { dismissed = true; } });
    assert.ok(cardNode.classList.contains('ui-quickstart-card'));
    assert.ok(cardNode.textContent.includes('BattleCats'));
    assert.ok(cardNode.querySelector('.ui-quickstart-goals'));
    assert.ok(cardNode.querySelector('.ui-quickstart-classes'));
    assert.ok(cardNode.querySelector('.ui-quickstart-functions'));
    assert.ok(cardNode.textContent.includes('PlayerController'));
    assert.ok(cardNode.textContent.includes('-[PlayerController takeDamage:]'));
    assert.ok(cardNode.textContent.includes('18回呼ばれる'));

    // Clicking a class navigates to Explorer types
    const classRows = cardNode.querySelector('.ui-quickstart-classes').querySelectorAll('.ui-list-row');
    assert.equal(classRows.length, 2);
    classRows[0].click();
    assert.equal(navigated.at(-1), '/explorer/classes?q=PlayerController');

    // Clicking a hot function navigates to its pseudocode view
    const fnRows = cardNode.querySelector('.ui-quickstart-functions').querySelectorAll('.ui-list-row');
    assert.equal(fnRows.length, 2);
    fnRows[0].click();
    assert.equal(navigated.at(-1), '/function/268443648/pseudocode');

    // Clicking dismiss triggers onDismiss
    const dismissBtn = cardNode.querySelector('.ui-quickstart-dismiss');
    assert.ok(dismissBtn);
    dismissBtn.click();
    assert.equal(dismissed, true);
  });
});

test('5.3 formatCandidateReason falls back to hex address when caller/callee symbol name is absent', () => {
  withLang('ja', () => {
    assert.equal(
      formatCandidateReason({ code: 'called-by-match', detail: { from: 0x1000n } }),
      '0x00001000 から呼ばれる',
    );
    assert.equal(
      formatCandidateReason({ code: 'calls-match', detail: { to: 0x2000n } }),
      '0x00002000 を呼ぶ',
    );
    assert.equal(
      formatCandidateReason({ code: 'caller-name', detail: { from: 0x3000n } }),
      '0x00003000 から呼ばれる',
    );
    assert.equal(
      formatCandidateReason({ code: 'callee-name', detail: { to: 0x4000n } }),
      '0x00004000 を呼ぶ',
    );
  });

  withLang('en', () => {
    assert.equal(
      formatCandidateReason({ code: 'called-by-match', detail: { from: 0x1000n } }),
      'Called by 0x00001000',
    );
    assert.equal(
      formatCandidateReason({ code: 'calls-match', detail: { to: 0x2000n } }),
      'Calls 0x00002000',
    );
  });
});

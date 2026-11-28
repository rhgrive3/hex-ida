import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setLang } from '../js/i18n.js';
import {
  pinpointMatchesAddress,
  buildGoalCandidateSummary,
  findGoalHighlightLines,
} from '../js/ui/function-analysis-presentation.js';
import {
  describeStrongestAnswer,
  appendCompleteness,
  showOverview,
} from '../js/ui/panels/investigation.js';
import { defaultHubUrls } from '../js/ui/v6-workbench-bridge.js';
import { explain } from '../js/arm64.js';

function installMinimalDom({ devRootScript = false } = {}) {
  const listeners = new Map();
  class FakeElement {
    constructor(tag = 'div') {
      this.tagName = String(tag).toUpperCase();
      this.className = '';
      this.children = [];
      this.parentNode = null;
      this.attributes = new Map();
      this.style = {};
      this.dataset = {};
      this._textContent = '';
      this._listeners = new Map();
      this.classList = {
        add: (...cls) => {
          const set = new Set(this.className.split(/\s+/).filter(Boolean));
          for (const c of cls) if (c) set.add(c);
          this.className = [...set].join(' ');
        },
        remove: (...cls) => {
          const set = new Set(this.className.split(/\s+/).filter(Boolean));
          for (const c of cls) set.delete(c);
          this.className = [...set].join(' ');
        },
        toggle: (c, force) => {
          const set = new Set(this.className.split(/\s+/).filter(Boolean));
          const has = set.has(c);
          const next = force === undefined ? !has : Boolean(force);
          if (next) set.add(c); else set.delete(c);
          this.className = [...set].join(' ');
          return next;
        },
        contains: (c) => this.className.split(/\s+/).filter(Boolean).includes(c),
      };
    }
    get isConnected() {
      let cur = this;
      while (cur) {
        if (cur === doc.body || cur === doc.documentElement) return true;
        cur = cur.parentNode;
      }
      return false;
    }
    get childNodes() { return this.children; }
    get textContent() {
      if (this.children.length) {
        return this._textContent + this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
      }
      return this._textContent;
    }
    set textContent(v) {
      this.children = [];
      this._textContent = String(v ?? '');
    }
    append(...nodes) {
      for (const n of nodes) {
        if (n == null) continue;
        if (typeof n === 'string') { this._textContent += n; continue; }
        if (n.parentNode) n.remove();
        n.parentNode = this;
        this.children.push(n);
      }
    }
    prepend(...nodes) {
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        if (n == null) continue;
        if (typeof n === 'string') { this._textContent = n + this._textContent; continue; }
        if (n.parentNode) n.remove();
        n.parentNode = this;
        this.children.unshift(n);
      }
    }
    replaceChildren(...nodes) {
      for (const c of this.children) if (c && typeof c === 'object') c.parentNode = null;
      this.children = [];
      this._textContent = '';
      this.append(...nodes);
    }
    remove() {
      if (!this.parentNode) return;
      const idx = this.parentNode.children.indexOf(this);
      if (idx >= 0) this.parentNode.children.splice(idx, 1);
      this.parentNode = null;
    }
    setAttribute(k, v) { this.attributes.set(k, String(v)); if (k === 'id') this.id = String(v); }
    getAttribute(k) { return this.attributes.get(k) ?? null; }
    removeAttribute(k) { this.attributes.delete(k); }
    hasAttribute(k) { return this.attributes.has(k); }
    addEventListener(type, fn) {
      if (!this._listeners.has(type)) this._listeners.set(type, new Set());
      this._listeners.get(type).add(fn);
    }
    removeEventListener(type, fn) { this._listeners.get(type)?.delete(fn); }
    dispatchEvent(ev) {
      for (const fn of this._listeners.get(ev.type) || []) fn(ev);
      return true;
    }
    click() { this.dispatchEvent({ type: 'click', currentTarget: this, target: this, preventDefault() {} }); }
    focus() {}
    querySelectorAll(sel) {
      const out = [];
      const matches = (node) => {
        if (sel.startsWith('.')) return node.classList.contains(sel.slice(1));
        if (sel.startsWith('#')) return node.id === sel.slice(1);
        return node.tagName.toLowerCase() === sel.toLowerCase();
      };
      const walk = (node) => {
        for (const c of node.children) {
          if (c && typeof c === 'object') {
            if (matches(c)) out.push(c);
            walk(c);
          }
        }
      };
      walk(this);
      return out;
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
    contains(other) {
      if (other === this) return true;
      for (const c of this.children) if (c && typeof c === 'object' && c.contains(other)) return true;
      return false;
    }
  }

  const doc = {
    documentElement: new FakeElement('html'),
    body: new FakeElement('body'),
    title: '',
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (t) => String(t ?? ''),
    createDocumentFragment: () => new FakeElement('fragment'),
    getElementById: (id) => doc.body.querySelector(`#${id}`),
    querySelector: (sel) => {
      if (sel === 'script[src="./js/app.js"]') return devRootScript ? { tagName: 'SCRIPT' } : null;
      return doc.body.querySelector(sel);
    },
    querySelectorAll: (sel) => doc.body.querySelectorAll(sel),
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener: (type, fn) => { listeners.get(type)?.delete(fn); },
    dispatchEvent: (ev) => {
      for (const fn of [...(listeners.get(ev.type) || [])]) fn(ev);
      return true;
    },
  };
  doc.documentElement.append(doc.body);
  const overlays = doc.createElement('div');
  overlays.setAttribute('id', 'overlays');
  doc.body.append(overlays);

  globalThis.document = doc;
  globalThis.window = {
    document: doc,
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  };
  globalThis.requestAnimationFrame = (fn) => { try { fn(); } catch {} return 0; };
  if (typeof globalThis.CustomEvent !== 'function') {
    globalThis.CustomEvent = class CustomEvent {
      constructor(type, init = {}) {
        this.type = type;
        this.detail = init.detail;
      }
    };
  }
  return { doc, body: doc.body, listeners };
}

test('Bug #3: pinpointMatchesAddress checks real addresses and rejects mismatched/field-only pinpoints', () => {
  assert.equal(pinpointMatchesAddress({ top: { addr: 0x1000n } }, 0x1000n), true);
  assert.equal(pinpointMatchesAddress({ top: { function: '0x2000' } }, 0x2000n), true);
  assert.equal(pinpointMatchesAddress({ top: { accessors: [{ addr: 0x3000n }] } }, 0x3000n), true);
  assert.equal(pinpointMatchesAddress({ changeSites: [{ address: 0x4000n }] }, 0x4000n), true);

  assert.equal(pinpointMatchesAddress({ top: { addr: 0x1000n } }, 0x9999n), false);
  assert.equal(
    pinpointMatchesAddress({
      verdict: 'likely',
      top: { className: 'Player', field: { name: '_hp', offset: 0x20 } },
    }, 0x1000n),
    false,
  );
  assert.equal(pinpointMatchesAddress(null, 0x1000n), false);
  assert.equal(pinpointMatchesAddress({ top: { addr: 0x1000n } }, null), false);
});

test('Bug #3: describeStrongestAnswer does not merge addressless field pinpoint with unrelated rankedCandidates[0]', () => {
  setLang('ja');
  const app = { symbols: { nameAt: () => 'unrelated_fn' } };
  const pin = {
    verdict: 'likely',
    top: { className: 'Player', field: { name: '_hp', offset: 0x20 } },
  };
  const ranked = [{ addr: 0x8000n, name: 'unrelated_fn', reasons: [{ code: 'popular', detail: { n: 10 } }] }];
  const ans = describeStrongestAnswer(app, { id: 'hp', ja: 'HP' }, pin, ranked);
  assert.equal(ans.address, null);
  assert.equal(ans.addrText, '');
  assert.ok(ans.answerField);
  assert.equal(ans.title, 'Player.hp');
});

test('Bug #3: buildGoalCandidateSummary & findGoalHighlightLines drop mismatched or addressless field pinpoints when functionAddr is passed', () => {
  setLang('ja');
  const pseudocode = [
    'void sub_5000(int64_t x0) {',
    '  int32_t v = *(int32_t *)(x0 + 0x20);',
    '  *(int32_t *)(x0 + 0x20) = v - 1;',
    '}',
  ].join('\n');

  // Mismatched function address in pinpoint
  const mismatchedPin = {
    verdict: 'likely',
    top: { addr: 0x4000n, name: 'Other::takeDamage', base: 'x0', offset: 0x20 },
  };
  const sumMismatch = buildGoalCandidateSummary({
    goal: { id: 'hp', ja: '体力' },
    pinpoint: mismatchedPin,
    pseudocode,
    functionAddr: 0x5000n,
  });
  assert.equal(sumMismatch.verdict, null);
  assert.equal(sumMismatch.verdictLabel, null);

  // Addressless field pinpoint
  const fieldOnlyPin = {
    verdict: 'likely',
    top: { className: 'Player', field: { name: '_hp', offset: 0x20, size: 4 } },
  };
  const sumFieldOnly = buildGoalCandidateSummary({
    goal: { id: 'hp', ja: '体力' },
    pinpoint: fieldOnlyPin,
    pseudocode,
    functionAddr: 0x5000n,
  });
  assert.equal(sumFieldOnly.verdict, null);
  assert.equal(sumFieldOnly.verdictLabel, null);

  const hlFieldOnly = findGoalHighlightLines(pseudocode, {
    pinpoint: fieldOnlyPin,
    functionAddr: 0x5000n,
  });
  assert.deepEqual(hlFieldOnly, []);

  // Addressless kind: 'location' pinpoint must not be misattributed to another function
  const locationOnlyPin = {
    kind: 'location',
    verdict: 'likely',
    top: { kind: 'location', label: 'Player::hp location', base: 'x0', offset: 0x20, size: 4 },
  };
  const sumLocationOnly = buildGoalCandidateSummary({
    goal: { id: 'hp', ja: '体力' },
    pinpoint: locationOnlyPin,
    pseudocode,
    functionAddr: 0x5000n,
  });
  assert.equal(sumLocationOnly.verdict, null);
  assert.equal(sumLocationOnly.verdictLabel, null);

  const hlLocationOnly = findGoalHighlightLines(pseudocode, {
    pinpoint: locationOnlyPin,
    functionAddr: 0x5000n,
  });
  assert.deepEqual(hlLocationOnly, []);

  // describeStrongestAnswer must keep address: null for addressless kind: 'location' pinpoint
  const appLoc = { symbols: { nameAt: () => 'unrelated_fn' } };
  const rankedLoc = [{ addr: 0x8000n, name: 'unrelated_fn', reasons: [] }];
  const locAns = describeStrongestAnswer(appLoc, { id: 'hp', ja: 'HP' }, locationOnlyPin, rankedLoc);
  assert.equal(locAns.address, null);
  assert.equal(locAns.addrText, '');

  // pinpoint.top.functions addresses are collected and matched accurately
  assert.equal(pinpointMatchesAddress({ kind: 'location', top: { functions: [{ addr: 0x5000n }] } }, 0x5000n), true);
  assert.equal(pinpointMatchesAddress({ kind: 'location', top: { functions: [{ addr: 0x5000n }] } }, 0x6000n), false);

  // Scoped pure { base, offset } pinpoint remains backward compatible
  const scopedBaseOffset = buildGoalCandidateSummary({
    goal: { id: 'hp', ja: '体力' },
    pinpoint: { verdict: 'confirmed', top: { base: 'x0', offset: 0x20, size: 4 } },
    pseudocode,
    functionAddr: 0x5000n,
  });
  assert.equal(scopedBaseOffset.verdict, 'confirmed');
});

test('Bug #6: CSS .row rules are scoped under .rows and investigation.js uses inv-row / inv-actions-row', () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const appCss = fs.readFileSync(path.join(root, 'css/app.css'), 'utf8');
  const compCss = fs.readFileSync(path.join(root, 'css/components.css'), 'utf8');
  const invJs = fs.readFileSync(path.join(root, 'js/ui/panels/investigation.js'), 'utf8');

  for (const [name, css] of [['css/app.css', appCss], ['css/components.css', compCss]]) {
    const lines = css.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/(?<!\.rows > )(?<!\.rows )\.row\b/.test(line) && !line.trim().startsWith('/*') && !line.trim().startsWith('*')) {
        assert.fail(`${name}:${i + 1} still has unscoped .row selector: ${line}`);
      }
    }
  }
  assert.match(appCss, /\.inv-row,\s*\.inv-actions-row\s*\{[^}]*display:\s*flex;/s);
  assert.match(appCss, /\.inv-row,\s*\.inv-actions-row\s*\{[^}]*flex-wrap:\s*wrap;/s);
  assert.doesNotMatch(invJs, /el\('div',\s*'row'\)/);
  assert.match(invJs, /el\('div',\s*'inv-row'\)/);
  assert.match(invJs, /el\('div',\s*'inv-actions-row'\)/);
});

test('Bug #8: executor-base dispatches hex:symbol-renamed on rename success and not on failure', async () => {
  const { doc } = installMinimalDom();
  const events = [];
  doc.addEventListener('hex:symbol-renamed', (ev) => events.push(ev.detail));

  const { CapabilityExecutor } = await import('../js/ai/capabilities/executor.js');
  let noteName = 'old_name';
  let symName = 'old_name';
  const app = {
    notes: { nameOf: () => noteName, setName: (_a, v) => { noteName = v; return true; } },
    symbols: { rename: (_a, v) => { symName = v; }, nameAt: () => symName },
    viewer: { setSymbols() {} },
    updateChrome() {},
  };
  const executor = new CapabilityExecutor({
    catalog: { get: (id) => (id === 'annotation.rename' ? { id, agentExposed: true, inputSchema: { type: 'object' } } : null) },
    app,
  });

  const res = await executor.execute('annotation.rename', { address: '4096', value: 'new_name' });
  assert.equal(res.ok, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].addr, 4096n);

  // Failure must not dispatch hex:symbol-renamed
  app.symbols.rename = () => { throw new Error('boom'); };
  await assert.rejects(() => executor.execute('annotation.rename', { address: '4096', value: 'bad_name' }), /boom/);
  assert.equal(events.length, 1);
});

test('Bug #9: defaultHubUrls switches to dist/ only when script[src="./js/app.js"] is present', () => {
  // Dev root environment
  installMinimalDom({ devRootScript: true });
  assert.deepEqual(defaultHubUrls(), {
    tilManifestUrl: 'dist/til-hub/manifest.json',
    tilBaseUrl: 'dist/til-hub',
    hexsigManifestUrl: 'dist/hexsig-hub/manifest.json',
    hexsigBaseUrl: 'dist/hexsig-hub',
  });

  // Production / Userscript environment (no script[src="./js/app.js"])
  installMinimalDom({ devRootScript: false });
  assert.deepEqual(defaultHubUrls(), {
    tilManifestUrl: 'til-hub/manifest.json',
    tilBaseUrl: 'til-hub',
    hexsigManifestUrl: 'hexsig-hub/manifest.json',
    hexsigBaseUrl: 'hexsig-hub',
  });

  // /embed/chatgpt route uses root-relative URLs
  const origLocation = globalThis.location;
  try {
    installMinimalDom({ devRootScript: false });
    globalThis.location = { pathname: '/embed/chatgpt' };
    assert.deepEqual(defaultHubUrls(), {
      tilManifestUrl: '/til-hub/manifest.json',
      tilBaseUrl: '/til-hub',
      hexsigManifestUrl: '/hexsig-hub/manifest.json',
      hexsigBaseUrl: '/hexsig-hub',
    });
  } finally {
    if (origLocation === undefined) delete globalThis.location;
    else globalThis.location = origLocation;
  }

  // Node environment (no document)
  delete globalThis.document;
  assert.deepEqual(defaultHubUrls(), {
    tilManifestUrl: 'til-hub/manifest.json',
    tilBaseUrl: 'til-hub',
    hexsigManifestUrl: 'hexsig-hub/manifest.json',
    hexsigBaseUrl: 'hexsig-hub',
  });
});

test('Bug #10.1, #10.2, #10.3: appendCompleteness suppression, showOverview dynamic title, and functionCount consistency', async () => {
  setLang('ja');
  const { doc } = installMinimalDom();

  // 10.1: Suppress contradictory function-discovery-incomplete when auto-analysis is done
  const hostDone = doc.createElement('div');
  const appDone = {
    store: { get: (k) => (k === 'symbolsReady' ? true : null) },
    v6Workbench: { getAutoAnalysisState: () => ({ status: 'done' }) },
  };
  const suppressed = appendCompleteness(
    hostDone,
    { completeness: { complete: false, reasons: ['function-discovery-incomplete'] } },
    { app: appDone },
  );
  assert.equal(suppressed, null);
  assert.equal(hostDone.children.length, 0);

  // Still shows warning when auto-analysis is running
  const hostRunning = doc.createElement('div');
  const appRunning = {
    store: { get: (k) => (k === 'symbolsReady' ? false : null) },
    v6Workbench: { getAutoAnalysisState: () => ({ status: 'running' }) },
  };
  const shown = appendCompleteness(
    hostRunning,
    { completeness: { complete: false, reasons: ['function-discovery-incomplete'] } },
    { app: appRunning },
  );
  assert.ok(shown);

  // 10.2 & 10.3: showOverview title transitions from 解析しています… -> 解析しました and uses symbols.functionCount
  const { investigationServiceFor } = await import('../js/analysis/investigation-service.js');
  let resolveOverview;
  const overviewPromise = new Promise((r) => { resolveOverview = r; });
  const appOverview = {
    backend: { gen: 1 },
    store: (() => { const fi = { name: 'app.bin' }; return { get: (k) => (k === 'fileInfo' ? fi : null) }; })(),
    symbols: { functionCount: 12345, gen: 1 },
  };
  const svc = investigationServiceFor(appOverview);
  svc.overview = () => overviewPromise;

  const sheet = showOverview(appOverview);
  assert.equal(sheet.title, 'このアプリを解析しています…');

  resolveOverview({
    completeness: { complete: true, reasons: [] },
    context: { region: { id: '__text' } },
    snapshotId: 'snap-1',
    report: { stats: { functions: 99, strings: 10, calls: 20, refs: 30 }, confirmed: [], goals: [], findings: [] },
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sheet.title, 'このアプリを解析しました');
  assert.match(sheet.body.textContent, /12,345/);
});

test('Bug #10.5: ARM64 Japanese memText has no double から and no extra space before 読み込み', () => {
  setLang('ja');
  const res = explain('ldr', 'x0, [x1, #16]', 0x1000n);
  assert.equal(
    res.summary,
    'x1 の 16 バイト先のアドレスから 8 バイト（64 ビット）を読み込み、x0 に入れる。',
  );
  assert.doesNotMatch(res.summary, /から.*から/);
  assert.doesNotMatch(res.summary, /） 読み込み/);
});

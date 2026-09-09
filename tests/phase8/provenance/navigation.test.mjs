import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { AnalysisQueryAPI } from '../../../js/analysis/query/api.js';
import { applyPhase8Projection } from '../../../js/decompiler/phase8/projection.js';
import { buildRenderProvenance } from '../../../js/decompiler/phase8/render-provenance.js';
import { createDecompilerNavigation, createDecompilerProvenanceView } from '../../../js/ui/decompiler-provenance.js';
import { showDecompilerProvenanceSheet } from '../../../js/ui/decompiler-provenance-sheet.js';
import { RewriteEngine } from '../../../js/decompiler/rewrite/engine.js';
import { DEFAULT_RULES } from '../../../js/decompiler/rewrite/rules.js';
import { recoverExactStackReturn } from '../../../js/decompiler/passes/stack-return-recovery.js';
import { analysis, consumerFixture, expr, resultWith, source, proofOnlySpillFixture } from './fixture.js';

test('C4-03 production pseudocode route consumes the snapshot-bound provenance view', () => {
  const product = fs.readFileSync(new URL('../../../js/ui/product-base.js', import.meta.url), 'utf8');
  const begin = product.indexOf('const renderPseudocodeTab = async () =>');
  const end = product.indexOf('const renderFlow =', begin);
  const route = product.slice(begin, end);
  assert.match(route, /analysisQueries\.decompile\(snapshot, addr/);
  assert.match(route, /createDecompilerProvenanceView\(res,/);
  assert.match(route, /currentSnapshot:\(\) => app\.analysisQueries\.snapshot\(/);
  assert.match(route, /isCurrent:\(\) => viewCurrent\(\) && !routeSignal\.aborted/);
  assert.match(route, /onNavigate:address => router\.navigate\('\/code\/' \+ address\.toString\(\)\)/);
  assert.match(route, /content\.replaceChildren\(toolbar, provenanceView\.root\)/);
});

function projection() {
  const value = expr.variable('a1', 64, true, source(1, 1));
  const wide = expr.unary('trunc', value, 32, false, source(2, 2));
  const narrow = expr.unary('trunc', wide, 8, false, source(3, 3));
  const temporary = expr.variable('v12', 64, false, source(12, 3));
  const condition = expr.compare('ne', temporary, expr.constant(0, 64, false, source(13, 3)), false, source(14, 3));
  return applyPhase8Projection(resultWith(narrow, { condition }), analysis());
}

async function queryFixture(value = projection()) {
  let epoch = 1;
  const api = new AnalysisQueryAPI({
    currentIdentity:async () => ({ binaryId:'navigation-fixture', projectRevision:1, analysisEpoch:epoch, artifactVersions:{} }),
    decompile:async () => ({ value, status:{ completeness:'complete' } }),
  });
  const snapshot = await api.snapshot();
  const query = await api.decompile(snapshot, 'function');
  return { api, query, options:{ currentSnapshot:() => api.snapshot() }, advance:() => { epoch++; } };
}

test('C4-03 query projection navigates both ways through the existing many-to-one map', async () => {
  const f = await queryFixture();
  const navigation = createDecompilerNavigation(f.query, f.options);
  const forward = await navigation.selectLine(1);
  assert.equal(forward.state, 'ready');
  assert.deepEqual(forward.entities[0].origins.rows, [1, 2, 3, 4]);
  const reverse = await navigation.selectOrigin('addr', 0x100cn);
  assert.equal(reverse.state, 'ready');
  assert.deepEqual(reverse.entities.map(entity => entity.lineIndex), [0, 1]);
  // The collapse and condition deliberately share instruction row 3. Select
  // the return node's distinct SSA origin for the one-line reverse case.
  const ir = await navigation.selectOrigin('ssa', 'def:99');
  assert.deepEqual(ir.entities.map(entity => entity.lineIndex), [1]);
  assert.equal(ir.entities[0], f.query.value.renderProvenance.entities['L1:stmt'], 'navigation reuses canonical projection entities');
  const opened = [];
  assert.equal((await navigation.openAddress(0x1004n, address => opened.push(address))).state, 'ready');
  assert.deepEqual(opened, [0x1004n]);
  assert.equal((await navigation.openAddress(0x9999n, address => opened.push(address))).reason, 'address-not-in-selection');
  assert.equal(opened.length, 1);
});

test('C4-03 navigation refuses stale query snapshots before selecting or navigating', async () => {
  const f = await queryFixture();
  const navigation = createDecompilerNavigation(f.query, f.options);
  await navigation.selectLine(1);
  f.advance();
  assert.equal((await navigation.selectOrigin('addr', 0x1004n)).reason, 'stale-query-snapshot');
  assert.equal((await navigation.openAddress(0x1004n, () => assert.fail('stale navigation'))).reason, 'stale-query-snapshot');
});

test('C4-03 cancellation and route disposal are rechecked after the snapshot await', async () => {
  const f = await queryFixture();
  for (const mode of ['cancel', 'dispose']) {
    const abort = new AbortController();
    let current = true;
    const navigation = createDecompilerNavigation(f.query, {
      signal:abort.signal, isCurrent:() => current,
      currentSnapshot:async () => {
        const snapshot = await f.api.snapshot();
        if (mode === 'cancel') abort.abort(); else current = false;
        return snapshot;
      },
    });
    assert.equal((await navigation.selectLine(1)).reason, 'stale-view');
  }
});

test('C4-03 older async selections cannot replace a newer visible selection', async () => {
  const f = await queryFixture();
  const pending = [];
  const navigation = createDecompilerNavigation(f.query, { currentSnapshot:() => new Promise(resolve => pending.push(resolve)) });
  const first = navigation.selectLine(0);
  const second = navigation.selectLine(1);
  const snapshot = await f.api.snapshot();
  pending[1](snapshot);
  assert.equal((await second).entities[0].lineIndex, 1);
  pending[0](snapshot);
  assert.equal((await first).reason, 'superseded-selection');
  const opened = [];
  const move = navigation.openAddress(0x1004n, address => opened.push(address));
  pending[2](snapshot);
  assert.equal((await move).state, 'ready');
  assert.deepEqual(opened, [0x1004n]);
});

test('C4-03 in-flight navigation cannot act on a replaced selection', async () => {
  const f = await queryFixture();
  let pending = null;
  let delay = false;
  const navigation = createDecompilerNavigation(f.query, {
    currentSnapshot:() => delay ? new Promise(resolve => { pending = resolve; }) : f.api.snapshot(),
  });
  await navigation.selectLine(1);
  delay = true;
  const move = navigation.openAddress(0x1004n, () => assert.fail('replaced selection'));
  delay = false;
  await navigation.selectLine(0);
  pending(await f.api.snapshot());
  assert.equal((await move).reason, 'superseded-selection');
});

test('C4-03 absent, incomplete and unresolved maps stay explicit; no-match is not a guessed line', async () => {
  const result = projection();
  for (const changed of [
    { ...result, renderProvenance:null },
    { ...result, renderProvenance:buildRenderProvenance({ result, snapshotId:'snapshot', budget:{ maxEntities:1 } }) },
  ]) {
    const f = await queryFixture(changed);
    const navigation = createDecompilerNavigation(f.query, f.options);
    assert.equal(navigation.available, false);
    assert.equal((await navigation.selectLine(0)).state, 'unavailable');
  }
  const f = await queryFixture();
  const navigation = createDecompilerNavigation(f.query, f.options);
  assert.deepEqual((await navigation.selectOrigin('addr', 0x9999n)).entities, []);
  assert.equal((await navigation.selectLine(-1)).reason, 'invalid-line');
  assert.equal((await navigation.selectOrigin('addr', Number.MAX_SAFE_INTEGER + 1)).reason, 'invalid-origin');
  const entity = result.renderProvenance.entities['L1:stmt'];
  const changed = await queryFixture({ ...result, renderProvenance:{ ...result.renderProvenance,
    entities:{ ...result.renderProvenance.entities, 'L1:stmt':{ ...entity, lineIndex:999 } } } });
  assert.equal((await createDecompilerNavigation(changed.query, changed.options).selectLine(1)).reason, 'unresolved-rendered-entity');
});

class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.events = {}; this.value = '';
    const classes = new Set();
    this.classList = { add:name => classes.add(name), toggle:(name, enabled) => { if (enabled) classes.add(name); else classes.delete(name); }, contains:name => classes.has(name) };
  }
  set textContent(value) { this.content = String(value); this.children = []; }
  get textContent() { return (this.content ?? '') + this.children.map(child => child.textContent).join(''); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.content = ''; this.children = nodes; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  addEventListener(name, fn) { (this.events[name] ??= []).push(fn); }
  async fire(name, event = {}) { for (const fn of this.events[name] ?? []) await fn({ preventDefault() {}, ...event }); }
  click() { return this.fire('click'); }
  focus() { this.focused = true; }
  scrollIntoView() { this.scrolled = true; }
}

test('C4-03 UI labels an actual removed statement with its old position and selects only the surviving return', async () => {
  const previous = globalThis.document;
  globalThis.document = { createElement:tag => new Element(tag) };
  try {
    const producer = proofOnlySpillFixture();
    recoverExactStackReturn(producer.result);
    const f = await queryFixture(applyPhase8Projection(producer.result, analysis()));
    const view = createDecompilerProvenanceView(f.query, f.options);
    const [controls, code, status, details, history] = view.root.children;
    const originalText = code.textContent;
    controls.children[0].value = '0x7004';
    await controls.children[1].click();
    assert.match(history.textContent, /Rendered statement removed \(pre-transform line 1\)/);
    assert.match(history.textContent, /does not mean canonical IR was deleted/);
    assert.equal(code.children[0].classList.contains('selected'), false, 'the new line at old position zero is unrelated');
    assert.equal(code.children[1].classList.contains('selected'), true);
    assert.equal(code.textContent, originalText);
    f.advance();
    await controls.children[1].click();
    assert.match(status.textContent, /stale-query-snapshot/);
    assert.equal(history.children.length, 0);
    assert.equal(details.children.length, 0);
  } finally {
    if (previous === undefined) delete globalThis.document; else globalThis.document = previous;
  }
});

test('C4-03 UI exposes actual elided-origin history without selecting a guessed output row', async () => {
  const previous = globalThis.document;
  globalThis.document = { createElement:tag => new Element(tag) };
  try {
    const value = expr.variable('input', 64, false, source(1, 1));
    const root = expr.binary('add', value, expr.constant(0, 64, false, source(2, 2)), 64, false, source(3, 3));
    const rewritten = new RewriteEngine(DEFAULT_RULES, { deterministic:true }).rewrite(root);
    const result = resultWith(rewritten.root);
    result.rewriteProof = rewritten.proof;
    const f = await queryFixture(applyPhase8Projection(result, analysis()));
    const view = createDecompilerProvenanceView(f.query, f.options);
    const [controls, code, status, details, history] = view.root.children;
    const originalText = code.textContent;
    controls.children[0].value = '0x1008';
    await controls.children[1].click();
    assert.match(status.textContent, /history exists.*binding is unresolved/);
    assert.equal(code.children.some(row => row.classList.contains('selected')), false);
    assert.equal(details.children.length, 0, 'no assembly callback is authorized by an unbound history');
    assert.equal(history.children[0].tagName, 'DETAILS');
    assert.match(history.textContent, /add-zero-right \(integer-algebra\)/);
    assert.match(history.textContent, /Elided expression origins: .*row:2/);
    assert.match(history.textContent, /does not mean canonical IR was deleted/);
    assert.equal(code.textContent, originalText);
    f.advance();
    await controls.children[1].click();
    assert.match(status.textContent, /stale-query-snapshot/);
    assert.equal(history.children.length, 0, 'stale histories clear with the existing selection lifecycle');
  } finally {
    if (previous === undefined) delete globalThis.document; else globalThis.document = previous;
  }
});

test('C4-03 UI connects producer-bound history to the real rows and instruction navigation', async () => {
  const previous = globalThis.document;
  globalThis.document = { createElement:tag => new Element(tag) };
  try {
    const producer = consumerFixture();
    const f = await queryFixture(applyPhase8Projection(producer.enhanced, analysis()));
    const opened = [];
    const view = createDecompilerProvenanceView(f.query, { ...f.options, onNavigate:address => opened.push(address) });
    const [controls, code, status, details, history] = view.root.children;
    const originalText = code.textContent;
    controls.children[0].value = '0x1004';
    await controls.children[1].click();
    assert.deepEqual(code.children.map(row => row.classList.contains('selected')), [true, false, true]);
    assert.match(status.textContent, /2 matching lines/);
    assert.match(history.textContent, /Bound to the rendered consumer of this expression/);
    assert.doesNotMatch(history.textContent, /binding is unresolved/);
    await details.children.find(node => node.textContent === '0x00001004').click();
    assert.deepEqual(opened, [producer.add.address]);
    assert.equal(code.textContent, originalText);
  } finally {
    if (previous === undefined) delete globalThis.document; else globalThis.document = previous;
  }
});

test('C4-03 history paging retains records after the first sixteen without changing copied code', async () => {
  const previous = globalThis.document;
  globalThis.document = { createElement:tag => new Element(tag) };
  try {
    const value = expr.variable('input', 64, false, source(1, 1));
    const root = expr.binary('add', value, expr.constant(0, 64, false, source(2, 2)), 64, false, source(3, 3));
    const rewritten = new RewriteEngine(DEFAULT_RULES, { deterministic:true }).rewrite(root);
    const result = resultWith(rewritten.root);
    result.rewriteProof = Array.from({ length:18 }, (_, valueId) => ({ ...rewritten.proof[0], valueId }));
    const f = await queryFixture(applyPhase8Projection(result, analysis()));
    const view = createDecompilerProvenanceView(f.query, f.options);
    const [controls, code, , , history] = view.root.children;
    const originalText = code.textContent;
    controls.children[0].value = '0x1008';
    await controls.children[1].click();
    assert.equal(history.children.filter(node => node.tagName === 'DETAILS').length, 16);
    await history.children.find(node => node.textContent === 'Next history').click();
    assert.equal(history.children.filter(node => node.tagName === 'DETAILS').length, 2);
    await history.children.find(node => node.textContent === 'Previous history').click();
    assert.equal(history.children.filter(node => node.tagName === 'DETAILS').length, 16);
    assert.equal(code.textContent, originalText);
    f.advance();
    await history.children.find(node => node.textContent === 'Next history').click();
    assert.equal(history.children.length, 0, 'paging revalidates the query snapshot too');
    assert.match(view.root.children[2].textContent, /stale-query-snapshot/);
  } finally {
    if (previous === undefined) delete globalThis.document; else globalThis.document = previous;
  }
});

test('C4-03 product view preserves copied text and connects address lookup, line origins and assembly navigation', async () => {
  const previous = globalThis.document;
  globalThis.document = { createElement:tag => new Element(tag) };
  try {
    const f = await queryFixture();
    const opened = [];
    const view = createDecompilerProvenanceView(f.query, { ...f.options, onNavigate:address => opened.push(address) });
    const [controls, code, status, details] = view.root.children;
    assert.equal(view.code, code);
    assert.equal(code.textContent, f.query.value.lines.map(line => '    '.repeat(line.indent) + line.text).join('\n'));
    const [input, find] = controls.children;
    assert.equal(input.attributes['aria-label'], 'Instruction address');
    input.value = '0x100C';
    await find.click();
    assert.ok(code.children.every(row => row.classList.contains('selected')));
    assert.match(status.textContent, /2 matching lines/);
    await code.children[1].fire('keydown', { key:'Enter' });
    assert.equal(code.children[0].classList.contains('selected'), false);
    assert.equal(code.children[1].classList.contains('selected'), true);
    const addressButton = details.children.find(node => node.textContent === '0x00001004');
    assert.ok(addressButton);
    await addressButton.click();
    assert.deepEqual(opened, [0x1004n]);
    f.advance();
    await addressButton.click();
    assert.equal(opened.length, 1);
    assert.match(status.textContent, /stale-query-snapshot/);
    assert.equal(details.children.length, 0);
  } finally {
    if (previous === undefined) delete globalThis.document; else globalThis.document = previous;
  }
});

test('C4-03 product navigation retains full-width addresses and disables incomplete maps', async () => {
  const previous = globalThis.document;
  globalThis.document = { createElement:tag => new Element(tag) };
  try {
    const address = 0x123456789abcdef0n;
    const lines = [{ kind:'stmt', indent:1, text:'return value;', source:{ addresses:[address], rows:[1], ir:['i1'] } }];
    const result = { lines };
    result.renderProvenance = buildRenderProvenance({ result, snapshotId:'wide-address-map' });
    const f = await queryFixture(result);
    const opened = [];
    const view = createDecompilerProvenanceView(f.query, { ...f.options, onNavigate:value => opened.push(value) });
    const [controls, code, , details] = view.root.children;
    controls.children[0].value = '0x123456789ABCDEF0';
    await controls.children[1].click();
    assert.equal(code.children[0].classList.contains('selected'), true);
    assert.equal(details.children[0].textContent, '0x123456789ABCDEF0');
    await details.children[0].click();
    assert.deepEqual(opened, [address]);

    const incomplete = await queryFixture({ lines });
    const unavailable = createDecompilerProvenanceView(incomplete.query, incomplete.options);
    assert.equal(unavailable.root.children[0].children[0].disabled, true);
    assert.equal(unavailable.root.children[0].children[1].disabled, true);
    assert.equal(unavailable.code.textContent, '    return value;');
    assert.match(unavailable.root.children[2].textContent, /missing-render-snapshot/);
  } finally {
    if (previous === undefined) delete globalThis.document; else globalThis.document = previous;
  }
});

test('C4-03 invalidating a visible selection also cancels its pending UI navigation callback', async () => {
  const previous = globalThis.document;
  globalThis.document = { createElement:tag => new Element(tag) };
  try {
    const f = await queryFixture();
    const opened = [];
    let pause = false, pending;
    const view = createDecompilerProvenanceView(f.query, {
      currentSnapshot:() => pause ? new Promise(resolve => { pending = resolve; }) : f.api.snapshot(),
      onNavigate:address => opened.push(address),
    });
    const [controls, code, , details] = view.root.children;
    await code.children[1].click();
    pause = true;
    const move = details.children[0].click();
    controls.children[0].value = 'not an address';
    await controls.children[1].click();
    pending(await f.api.snapshot());
    await move;
    assert.deepEqual(opened, []);
    assert.equal(details.children.length, 0);
  } finally {
    if (previous === undefined) delete globalThis.document; else globalThis.document = previous;
  }
});

test('C4-03 every origin remains reachable beyond the first address page', async () => {
  const previous = globalThis.document;
  globalThis.document = { createElement:tag => new Element(tag) };
  try {
    const addresses = Array.from({ length:70 }, (_, index) => 0x1000n + BigInt(index * 4));
    const result = { lines:[{ kind:'stmt', indent:1, text:'return value;', source:{ addresses, rows:[1], ir:['i1'] } }] };
    result.renderProvenance = buildRenderProvenance({ result, snapshotId:'many-origin-map' });
    const f = await queryFixture(result), opened = [];
    const view = createDecompilerProvenanceView(f.query, { ...f.options, onNavigate:address => opened.push(address) });
    const [, code, , details] = view.root.children;
    await code.children[0].click();
    assert.equal(details.children.filter(node => node.textContent.startsWith('0x')).length, 64);
    await details.children.find(node => node.textContent === 'Next addresses').click();
    assert.equal(details.children.filter(node => node.textContent.startsWith('0x')).length, 6);
    await details.children.find(node => node.textContent === '0x00001114').click();
    assert.deepEqual(opened, [addresses.at(-1)]);
    await details.children.find(node => node.textContent === 'Previous addresses').click();
    assert.equal(details.children.filter(node => node.textContent.startsWith('0x')).length, 64);
  } finally {
    if (previous === undefined) delete globalThis.document; else globalThis.document = previous;
  }
});

test('C4-03 unmapped legacy query text stays readable without inventing navigation', async () => {
  const previous = globalThis.document;
  globalThis.document = { createElement:tag => new Element(tag) };
  try {
    for (const value of ['    return old;', { code:'    return old;' },
      { code:{ lines:[{ kind:'stmt', indent:1, text:'return old;' }] } }]) {
      const f = await queryFixture(value);
      const view = createDecompilerProvenanceView(f.query, f.options);
      assert.equal(view.code.textContent, '    return old;');
      assert.equal(view.navigation.available, false);
    }
  } finally {
    if (previous === undefined) delete globalThis.document; else globalThis.document = previous;
  }
});

class NavigationSheet {
  static latest = null;
  constructor(title, options) {
    this.title = title; this.options = options;
    this.root = new Element('section'); this.root.isConnected = true;
    this.body = new Element('div'); this.root.append(this.body);
    NavigationSheet.latest = this;
  }
  close() { this.root.isConnected = false; this.options.onClose(); }
}

test('C4-03 legacy sheet reuses the shared query view and navigates without a product router', async () => {
  const previous = globalThis.document;
  globalThis.document = { createElement:tag => new Element(tag) };
  try {
    const f = await queryFixture(), opened = [];
    const app = { analysisQueries:f.api, backend:{ gen:1 }, store:{ get:() => 0 },
      goToAddress:(address, options) => opened.push({ address, options }) };
    const sheet = await showDecompilerProvenanceSheet(app, 0x1000n, { SheetClass:NavigationSheet });
    assert.equal(sheet.body.classList.contains('product-ui-ready'), true);
    const [toolbar, view] = sheet.body.children;
    const [controls, code, status, details] = view.children;
    controls.children[0].value = '0x100C';
    await controls.children[1].click();
    assert.equal(code.children.filter(row => row.classList.contains('selected')).length, 2);
    assert.match(status.textContent, /2 行/);
    const wrap = toolbar.children[1];
    await wrap.fire('click', { currentTarget:wrap });
    assert.equal(code.classList.contains('wrap'), true);
    assert.equal(wrap.attributes['aria-pressed'], 'true');
    const target = details.children.find(node => node.textContent === '0x00001004');
    assert.ok(target);
    await target.click();
    assert.deepEqual(opened, [{ address:0x1004n, options:{ announce:true } }]);
    assert.equal(sheet.root.isConnected, false);
    await target.click();
    assert.equal(opened.length, 1, 'closed sheet must not issue another navigation');
  } finally {
    if (previous === undefined) delete globalThis.document; else globalThis.document = previous;
  }
});

test('C4-03 legacy sheet does not publish a query that finishes after closure or binary replacement', async () => {
  const previous = globalThis.document;
  globalThis.document = { createElement:tag => new Element(tag) };
  try {
    for (const mode of ['close', 'replace']) {
      const f = await queryFixture();
      let release, began;
      const ready = new Promise(resolve => { began = resolve; });
      const api = { snapshot:options => f.api.snapshot(options), decompile:async (snapshot, address, options) => {
        began(); await new Promise(resolve => { release = resolve; });
        return f.api.decompile(snapshot, address, options);
      } };
      const app = { analysisQueries:api, backend:{ gen:1 }, store:{ get:() => 0 } };
      const loading = showDecompilerProvenanceSheet(app, 0x1000n, { SheetClass:NavigationSheet });
      await ready;
      const sheet = NavigationSheet.latest;
      if (mode === 'close') sheet.close(); else app.backend = { gen:1 };
      release();
      assert.equal(await loading, sheet);
      assert.equal(sheet.body.children.length, 1, 'late view must not replace the loading surface');
      assert.match(sheet.body.textContent, /取得しています/);
    }
  } finally {
    if (previous === undefined) delete globalThis.document; else globalThis.document = previous;
  }
});

test('C4-03 legacy sheet reports unavailable analysis without falling back to another decompiler', async () => {
  const previous = globalThis.document;
  globalThis.document = { createElement:tag => new Element(tag) };
  try {
    const app = { analyzeFunctionAt:() => assert.fail('must not create a parallel analysis path') };
    const sheet = await showDecompilerProvenanceSheet(app, 0x1000n, { SheetClass:NavigationSheet });
    assert.match(sheet.body.textContent, /解析クエリが利用できない/);
    const f = await queryFixture(null);
    const missing = await showDecompilerProvenanceSheet({ analysisQueries:f.api }, 0x1000n, { SheetClass:NavigationSheet });
    assert.match(missing.body.textContent, /表示できる疑似コードがありません/);
  } finally {
    if (previous === undefined) delete globalThis.document; else globalThis.document = previous;
  }
});

test('C4-03 legacy decompiler keeps its existing controls and opens the common provenance sheet', () => {
  const tools = fs.readFileSync(new URL('../../../js/tools-base.js', import.meta.url), 'utf8');
  const start = tools.indexOf('export async function showDecompiler(app, addr)');
  const end = tools.indexOf('function paintCode(', start);
  const surface = tools.slice(start, end);
  assert.match(surface, /button\('命令との双方向対応', 'chip', \(\) => showDecompilerProvenanceSheet\(app, addr\)\)/);
  assert.match(surface, /button\('アセンブリを併記'/);
  assert.match(surface, /button\('日本語の注釈'/);
});

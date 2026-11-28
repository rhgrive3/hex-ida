import test from 'node:test';
import assert from 'node:assert/strict';
import { setSyncAddress, syncAddressFor, nodeIndexForAddress, highlightGraphNode } from '../js/ui/view-sync.js';
import { AnalysisQueryAPI } from '../js/analysis/query/api.js';
import { createDecompilerProvenanceView } from '../js/ui/decompiler-provenance.js';

class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.events = {}; this.value = '';
    const classes = new Set();
    this.classList = {
      add:(n) => classes.add(n),
      remove:(n) => classes.delete(n),
      toggle:(n, on) => { if (on) classes.add(n); else classes.delete(n); },
      contains:(n) => classes.has(n),
    };
  }
  set textContent(v) { this.content = String(v); this.children = []; }
  get textContent() { return (this.content ?? '') + this.children.map((c) => c.textContent).join(''); }
  append(...n) { this.children.push(...n); }
  prepend(...n) { this.children.unshift(...n); }
  replaceChildren(...n) { this.content = ''; this.children = n; }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k] ?? null; }
  removeAttribute(k) { delete this.attributes[k]; }
  addEventListener(name, fn) { (this.events[name] ??= []).push(fn); }
  async fire(name, event = {}) { for (const fn of this.events[name] ?? []) await fn({ preventDefault() {}, ...event }); }
  click() { return this.fire('click'); }
  focus() {}
  scrollIntoView() { this.scrolled = true; }
  querySelectorAll(sel) {
    const out = [];
    const classes = sel.split('.').filter(Boolean);
    const walk = (node) => {
      for (const ch of node.children) {
        if (classes.every((c) => ch.classList.contains(c))) out.push(ch);
        walk(ch);
      }
    };
    walk(this);
    return out;
  }
}

async function queryOf(value) {
  const api = new AnalysisQueryAPI({
    currentIdentity:async () => ({ binaryId:'sync-fixture', projectRevision:1, analysisEpoch:1, artifactVersions:{} }),
    decompile:async () => ({ value, status:{ completeness:'complete' } }),
  });
  const snapshot = await api.snapshot();
  return { query:await api.decompile(snapshot, 'function'), currentSnapshot:() => api.snapshot() };
}

const LINES = [
  { kind:'sig', indent:0, text:'int f(uint64 a1)', source:{ addresses:[0x1000n] } },
  { kind:'ctrl', indent:0, text:'{', source:{ addresses:[] } },
  { kind:'stmt', indent:1, text:'x0 = a1 + 1;', source:{ addresses:[0x1000n, 0x1004n] } },
  { kind:'stmt', indent:1, text:'return x0;', source:{ addresses:[0x1008n] } },
  { kind:'ctrl', indent:0, text:'}', source:{ addresses:[] } },
];

test('sync address is kept per function', () => {
  const app = {};
  setSyncAddress(app, 0x1000n, 0x1008n);
  assert.equal(syncAddressFor(app, 0x1000n), 0x1008n);
  assert.equal(syncAddressFor(app, 0x2000n), null);
  setSyncAddress(app, 0x2000n, 'bad');
  assert.equal(syncAddressFor(app, 0x1000n), 0x1008n);
});

test('graph node lookup picks the block that contains the address', () => {
  const nodes = [{ id:'a', addr:0x1000n }, { id:'b', addr:0x1010n }, { id:'c', addr:0x1020n, end:0x1028n }];
  assert.equal(nodeIndexForAddress(nodes, 0x1014n), 1);
  assert.equal(nodeIndexForAddress(nodes, 0x1000n), 0);
  assert.equal(nodeIndexForAddress(nodes, 0x0fffn), -1);
  assert.equal(nodeIndexForAddress(nodes, 0x1030n), 1, 'outside the last bounded block falls back to the previous one');
});

test('highlightGraphNode clears aria-current on previously synced nodes', () => {
  const root = new Element('svg');
  const nA = new Element('g'); nA.classList.add('g-node'); nA.setAttribute('data-node-id', 'a');
  const nB = new Element('g'); nB.classList.add('g-node'); nB.setAttribute('data-node-id', 'b');
  root.append(nA, nB);
  const nodes = [{ id:'a', addr:0x1000n }, { id:'b', addr:0x1010n }];

  highlightGraphNode(root, nodes, 0x1004n);
  assert.equal(nA.classList.contains('g-sync'), true);
  assert.equal(nA.getAttribute('aria-current'), 'true');
  assert.equal(nB.getAttribute('aria-current'), null);

  highlightGraphNode(root, nodes, 0x1014n);
  assert.equal(nA.classList.contains('g-sync'), false);
  assert.equal(nA.getAttribute('aria-current'), null, 'old node aria-current must be removed');
  assert.equal(nB.classList.contains('g-sync'), true);
  assert.equal(nB.getAttribute('aria-current'), 'true');
});

test('without a verified map, sourceMap enables line selection and reverse address lookup', async () => {
  const previous = globalThis.document;
  globalThis.document = { createElement:(tag) => new Element(tag) };
  try {
    const f = await queryOf({ lines:LINES });
    const selected = [];
    const view = createDecompilerProvenanceView(f.query, { currentSnapshot:f.currentSnapshot, onSelectAddress:(a) => selected.push(a), initialAddr:0x1008n });
    const [controls, code, status, details] = view.root.children;
    const [input, find] = controls.children;
    assert.equal(input.disabled, false, 'reverse lookup input enabled under sourceMap fallback');
    assert.equal(find.disabled, false, 'reverse lookup button enabled under sourceMap fallback');
    assert.match(status.textContent, /missing-render-snapshot/);
    assert.deepEqual(selected, [0x1008n], 'initial address selects the return line');
    assert.equal(code.children[3].classList.contains('selected'), true);
    assert.equal(code.children[0].attributes.role, undefined, 'signature line is not selectable');

    input.value = '0x1004';
    await find.click();
    assert.equal(view.selectedAddress(), 0x1000n);
    assert.equal(code.children[2].classList.contains('selected'), true);
    assert.equal(code.children[3].classList.contains('selected'), false);
    assert.equal(details.children.length, 2);
    assert.deepEqual(selected, [0x1008n, 0x1000n]);

    // Clean View prioritizes visible rows when an earlier line is elided.
    const cleanLines = [
      { kind:'sig', indent:0, text:'int g(uint64 a1)', source:{ addresses:[0x2000n] } },
      { kind:'ctrl', indent:0, text:'{', source:{ addresses:[] } },
      { kind:'stmt', indent:1, text:'*(uint64 *)(sp + 0x10) = x19;', source:{ addresses:[0x2004n] } },
      { kind:'stmt', indent:1, text:'return a1 + 2;', source:{ addresses:[0x2004n, 0x2008n] } },
      { kind:'ctrl', indent:0, text:'}', source:{ addresses:[] } },
    ];
    const fClean = await queryOf({ lines:cleanLines });
    const cleanView = createDecompilerProvenanceView(fClean.query, { currentSnapshot:fClean.currentSnapshot, cleanView:true });
    const [cControls, cCode] = cleanView.root.children;
    cControls.children[0].value = '0x2004';
    await cControls.children[1].click();
    const visibleSelected = cCode.children.filter((r) => r.classList.contains('selected'));
    assert.equal(visibleSelected.length, 1, 'Clean View reverse lookup selects a visible row');
    assert.match(visibleSelected[0].textContent, /return a1 \+ 2;/);

    // Without sourceMap addresses, reverse lookup remains disabled.
    const noSource = await queryOf({ lines:[{ kind:'sig', indent:0, text:'void empty()' }, { kind:'stmt', indent:1, text:'return;' }] });
    const disabledView = createDecompilerProvenanceView(noSource.query, { currentSnapshot:noSource.currentSnapshot });
    assert.equal(disabledView.root.children[0].children[0].disabled, true);
    assert.equal(disabledView.root.children[0].children[1].disabled, true);
  } finally {
    if (previous === undefined) delete globalThis.document; else globalThis.document = previous;
  }
});

// Regression for #6098: the `trace-value` action looked semantic instructions
// up with `i.address === addr`, but sanitizeActions() hands the action a
// canonical string address ('0x1000') while semantic instructions carry BigInt
// addresses (0x1000n). The strict comparison always missed, so tapping the
// action fell through to generic navigation instead of showing value flow.
// Both sides are now compared through the same canonical address text.
import assert from 'node:assert/strict';

import { createActionRunner } from '../js/ai/interaction/actions.js';

// showValueFlow opens a Sheet; stub the DOM surface it touches (same
// fake-element pattern as tests/issues-reopened-explorer-structure-findings).
const previousDocument = globalThis.document;
const previousAnimationFrames = globalThis.requestAnimationFrame;
const overlayElem = { append() {} };
globalThis.document = {
  getElementById: (id) => (id === 'overlays' ? overlayElem : null),
  createElement: (tag) => ({
    tagName: String(tag).toUpperCase(),
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {}, removeAttribute() {},
    style: {}, dataset: {}, textContent: '',
    childNodes: [], tabIndex: -1,
    addEventListener() {}, removeEventListener() {},
    replaceChildren() {}, append() {}, remove() {},
    querySelector: () => null, focus() {},
  }),
  createTextNode: (value) => ({ nodeType: 3, textContent: value }),
  createDocumentFragment: () => ({ nodeType: 11, childNodes: [] }),
  body: { append() {} },
  activeElement: null,
};
globalThis.requestAnimationFrame = (fn) => fn();
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const navigations = [];
const rowOfCalls = [];
const app = {
  semantic: { model: { instructions: [
    {
      address: 0x1000n, row: 7,
      reads: [], writes: ['x0'], mnemonic: 'mov', operands: 'x0, x1',
      ops: [{ mnemonic: 'mov', operands: 'x0, x1' }],
    },
    {
      address: 0x2000n, row: 12,
      reads: [], writes: ['x0'], mnemonic: 'add', operands: 'x0, x2',
      ops: [{ mnemonic: 'add', operands: 'x0, x2' }],
    },
  ] } },
  store: { get: () => 'region-A' },
  viewer: { rowOfAddress: (addr) => { rowOfCalls.push(String(addr)); return 99; } },
  goToFunction() {},
};

const run = createActionRunner(app, {
  ui: { router: { navigate: (route) => navigations.push(route) } },
  assistant: null,
});

try {
  await run({ kind: 'trace-value', target: '0x2000' });
  assert.deepEqual(navigations, [], 'the semantic row must be found from the canonical string target — no navigation fallback');
  assert.deepEqual(rowOfCalls, [], 'the viewer row fallback must not be needed for a present instruction');

  await run({ kind: 'trace-value', target: '0xdead' });
  assert.deepEqual(rowOfCalls, ['0xdead'], 'an absent address consults the viewer row fallback');
  assert.deepEqual(navigations, [], 'the viewer fallback answers the lookup, so no navigation happens');
} finally {
  if (previousDocument === undefined) delete globalThis.document;
  else globalThis.document = previousDocument;
  if (previousAnimationFrames === undefined) delete globalThis.requestAnimationFrame;
  else globalThis.requestAnimationFrame = previousAnimationFrames;
}

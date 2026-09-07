import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const productHardenedPath = fileURLToPath(new URL('../../js/ui/product-hardened.js', import.meta.url));
const source = fs.readFileSync(productHardenedPath, 'utf8');
const startMarker = 'function linkedController(parentSignal) {';
const endMarker = '\n}\n\nfunction renderCanonicalStrings';
const start = source.indexOf(startMarker);
const end = source.indexOf(endMarker, start);
assert.notEqual(start, -1, 'linkedController source must remain discoverable');
assert.notEqual(end, -1, 'linkedController source boundary must remain discoverable');
const linkedControllerSource = source.slice(start, end + 2);
const linkedController = new Function(
  'AbortController',
  `"use strict";\n${linkedControllerSource}\nreturn linkedController;`,
)(AbortController);

function createInstrumentedParent() {
  let aborted = false;
  let reason;
  const listeners = new Set();
  let addCount = 0;
  let removeCount = 0;

  const signal = {
    get aborted() { return aborted; },
    get reason() { return reason; },
    addEventListener(type, listener, options) {
      assert.equal(type, 'abort');
      assert.equal(options?.once, true);
      addCount += 1;
      listeners.add(listener);
    },
    removeEventListener(type, listener) {
      assert.equal(type, 'abort');
      removeCount += 1;
      listeners.delete(listener);
    },
  };

  return {
    signal,
    abort(nextReason) {
      if (aborted) return;
      aborted = true;
      reason = nextReason;
      for (const listener of [...listeners]) listener({ type:'abort' });
      listeners.clear();
    },
    get activeListeners() { return listeners.size; },
    get addCount() { return addCount; },
    get removeCount() { return removeCount; },
  };
}

{
  const parent = createInstrumentedParent();
  const children = [];
  let current = null;

  for (let i = 0; i < 64; i += 1) {
    current?.abort('query-replaced');
    current = linkedController(parent.signal);
    children.push(current);
    assert.equal(parent.activeListeners, 1, `replacement ${i} must leave only the current parent listener`);
  }

  assert.equal(parent.addCount, 64);
  assert.equal(parent.removeCount, 63, 'each replaced child must detach its parent listener immediately');
  for (const child of children.slice(0, -1)) {
    assert.equal(child.signal.aborted, true);
    assert.equal(child.signal.reason, 'query-replaced');
  }
  assert.equal(current.signal.aborted, false);

  parent.abort('route-disposed');
  assert.equal(current.signal.aborted, true, 'parent abort must still reach the current child');
  assert.equal(current.signal.reason, 'route-disposed');
  assert.equal(parent.activeListeners, 0);
  assert.equal(parent.removeCount, 64, 'parent abort must clean the final listener too');
}

{
  const parent = createInstrumentedParent();
  const child = linkedController(parent.signal);
  assert.equal(parent.activeListeners, 1);
  child.abort('child-complete');
  assert.equal(parent.activeListeners, 0, 'child lifecycle completion must detach the parent listener');
  child.abort('again');
  assert.equal(parent.activeListeners, 0, 'cleanup must remain idempotent');
}

{
  const parent = createInstrumentedParent();
  parent.abort('already-aborted');
  const child = linkedController(parent.signal);
  assert.equal(child.signal.aborted, true, 'already-aborted parent must abort child synchronously');
  assert.equal(child.signal.reason, 'already-aborted');
  assert.equal(parent.activeListeners, 0);
  assert.equal(parent.addCount, 0, 'already-aborted parent must not register a listener');
}

{
  const child = linkedController(null);
  assert.equal(child.signal.aborted, false);
}

console.log('issue-5102-ui-product-hardened-abort-listener-cleanup: PASS');

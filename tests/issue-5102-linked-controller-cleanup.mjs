import assert from 'node:assert/strict';
import { linkedController } from '../js/ui/product-hardened.js';

// Issue #5102: linkedController() registers an abort listener on the parent
// signal for every strings query, but never removes it when the child is
// aborted first (query replacement). `{ once: true }` only releases the
// listener when the *parent* aborts, so long-lived routes accumulate one
// listener/closure per search keystroke until the route itself aborts.

assert.equal(typeof linkedController, 'function', 'linkedController must be exported for lifecycle testing');

const makeParentSignal = () => {
  const added = [];
  const removed = [];
  return {
    added,
    removed,
    aborted: false,
    reason: undefined,
    addEventListener: (type, listener, options) => { added.push([type, listener, options]); },
    removeEventListener: (type, listener) => { removed.push([type, listener]); },
  };
};

// Replacing a query aborts the previous child; its parent listener must go too.
{
  const parent = makeParentSignal();
  const first = linkedController(parent);
  assert.equal(parent.added.length, 1, 'one parent listener per linked child');
  first.abort('query-replaced');
  assert.equal(parent.removed.length, 1, 'aborting the child must release its parent listener');
  assert.equal(parent.removed[0][0], 'abort');
  assert.equal(parent.removed[0][1], parent.added[0][1], 'the exact registered handler must be removed');

  // The reported accumulation sequence: N replaced queries must not leave N listeners.
  const live = makeParentSignal();
  let current = null;
  for (let i = 0; i < 5; i++) {
    current?.abort('query-replaced');
    current = linkedController(live);
  }
  assert.equal(live.added.length, 5);
  assert.equal(live.removed.length, 4, 'every replaced child must clean up, leaving only the live listener');
  current.abort('strings-view-disposed');
  assert.equal(live.removed.length, 5, 'disposing the view must release the last listener');
}

// Parent-to-child propagation must keep working after the cleanup change.
{
  const parent = new AbortController();
  const child = linkedController(parent.signal);
  assert.equal(child.signal.aborted, false);
  parent.abort('route-left');
  assert.equal(child.signal.aborted, true, 'parent abort must still propagate to the child');
  assert.equal(child.signal.reason, 'route-left');
}

// A pre-aborted parent must abort the child immediately without registering.
{
  const parent = makeParentSignal();
  parent.aborted = true;
  parent.reason = 'route-left';
  const child = linkedController(parent);
  assert.equal(child.signal.aborted, true);
  assert.equal(parent.added.length, 0, 'no listener is needed when the parent is already aborted');
}

// No parent signal must still yield a usable controller.
{
  const child = linkedController(null);
  assert.equal(child.signal.aborted, false);
  child.abort('manual');
  assert.equal(child.signal.aborted, true);
}

console.log('issue #5102 linkedController cleanup: PASS');

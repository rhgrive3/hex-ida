import assert from 'node:assert/strict';
import test from 'node:test';

import { ProductRouter } from '../../js/ui/router.js';

const routes = [{ pattern: '/investigate' }];

function installHistory(initial) {
  const realWindow = globalThis.window;
  const realHistory = globalThis.history;
  const store = { state: initial ?? null };
  globalThis.window = {
    location: { hash: '', href: 'http://localhost/' },
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.history = {
    get state() { return store.state; },
    replaceState(state) { store.state = state; },
    pushState(state) { store.state = state; },
    back() {},
    forward() {},
  };
  return {
    store,
    restore() {
      if (realWindow === undefined) delete globalThis.window; else globalThis.window = realWindow;
      if (realHistory === undefined) delete globalThis.history; else globalThis.history = realHistory;
    },
  };
}

function createRouter() {
  return new ProductRouter(routes.map((route) => ({ ...route })), {
    onRoute: () => null,
    onState: () => {},
    onError: () => {},
  });
}

test('start normalizes a non-finite history depth instead of adopting it', () => {
  const env = installHistory({ hexUi: true, key: 1, depth: Infinity, viewState: null });
  try {
    const router = createRouter();
    router.start();
    assert.equal(router.depth, 0);
    assert.equal(router.canBack(), false);
    assert.equal(env.store.state.depth, 0);
  } finally {
    env.restore();
  }
});

test('start normalizes an unsafe-integer history depth', () => {
  const env = installHistory({ hexUi: true, key: 1, depth: 2 ** 53, viewState: null });
  try {
    const router = createRouter();
    router.start();
    assert.ok(Number.isSafeInteger(router.depth));
  } finally {
    env.restore();
  }
});

test('start keeps adopting a valid history depth', () => {
  const env = installHistory({ hexUi: true, key: 3, depth: 2, viewState: null });
  try {
    const router = createRouter();
    router.start();
    assert.equal(router.depth, 2);
    assert.equal(router.canBack(), true);
  } finally {
    env.restore();
  }
});

test('popstate with an invalid depth leaves the current depth alone', () => {
  const env = installHistory({ hexUi: true, key: 3, depth: 2, viewState: null });
  try {
    const router = createRouter();
    router.start();
    assert.equal(router.depth, 2);
    env.store.state = { hexUi: true, key: 4, depth: Infinity, viewState: null };
    router.onPop();
    assert.equal(router.depth, 2);
    assert.equal(router.canBack(), true);
  } finally {
    env.restore();
  }
});

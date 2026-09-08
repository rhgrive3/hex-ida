// Regression for #5944: project import must restore navigation.currentFunction
// through the app-level navigation so the owning region is selected — saved
// positions in secondary regions (e.g. __text_cold) were skipped because the
// restore only range-checked the fallback primary code region.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyWorkspaceProject } from '../js/workspace.js';

const TEXT = { id: 'text', section: '__text', vmAddr: 0x1000n, size: 0x100n };
const COLD = { id: 'cold', section: '__text_cold', vmAddr: 0x3000n, size: 0x100n };

function makeApp({ withGoToAddress }) {
  const state = new Map([
    ['regions', [TEXT, COLD]],
    ['currentRegion', TEXT],
    ['currentAddress', null],
  ]);
  const app = {
    navigation: null,
    notes: { id: 'test-5944', names: new Map(), comments: new Map(), types: new Map(), vars: new Map(), structs: [], dirty: false, save: () => true, nameEntries: () => [] },
    patches: { list: () => [], add() {}, clear() {} },
    store: { get: (k) => state.get(k), set: (o) => { for (const [k, v] of Object.entries(o)) state.set(k, v); } },
    codeRegion: () => TEXT,
    viewer: {
      goToAddressCalls: [],
      goToAddress(addr) { this.goToAddressCalls.push(addr); return true; },
    },
    project: null,
  };
  if (withGoToAddress) {
    // Mimic js/app.js goToAddress: select the owning region, then navigate.
    app.selectedRegions = [];
    app.goToAddress = (addr, opts = {}) => {
      const region = app.store.get('currentRegion');
      if (region && addr >= region.vmAddr && addr < region.vmAddr + region.size) {
        app.store.set({ currentAddress: addr });
        return app.viewer.goToAddress(addr);
      }
      const target = app.store.get('regions').find((r) => r.size > 0n && addr >= r.vmAddr && addr < r.vmAddr + r.size);
      if (target) {
        app.selectedRegions.push(target);
        app.store.set({ currentRegion: target, currentAddress: addr });
        return app.viewer.goToAddress(addr);
      }
      return false;
    };
  }
  return app;
}

const projectWith = (addr) => ({ user: {}, navigation: { currentFunction: addr } });

test('#5944 a saved position in a secondary region is restored with the region selected', () => {
  const app = makeApp({ withGoToAddress: true });
  applyWorkspaceProject(app, projectWith(0x3040n));
  assert.equal(app.store.get('currentAddress'), 0x3040n);
  assert.deepEqual(app.selectedRegions, [COLD], 'cold region must be selected');
  assert.deepEqual(app.viewer.goToAddressCalls, [0x3040n]);
});

test('#5944 a saved position in the primary region still restores through app navigation', () => {
  const app = makeApp({ withGoToAddress: true });
  applyWorkspaceProject(app, projectWith(0x1010n));
  assert.equal(app.store.get('currentAddress'), 0x1010n);
  assert.deepEqual(app.selectedRegions, [], 'no region switch needed');
  assert.deepEqual(app.viewer.goToAddressCalls, [0x1010n]);
});

test('#5944 an unmapped address stays silently skipped', () => {
  const app = makeApp({ withGoToAddress: true });
  applyWorkspaceProject(app, projectWith(0x9999n));
  assert.equal(app.store.get('currentAddress'), null);
  assert.deepEqual(app.viewer.goToAddressCalls, []);
});

test('#5944 legacy embedders without app.goToAddress keep the fallback path', () => {
  const app = makeApp({ withGoToAddress: false });
  applyWorkspaceProject(app, projectWith(0x1010n));
  assert.equal(app.store.get('currentAddress'), 0x1010n);
  assert.deepEqual(app.viewer.goToAddressCalls, [0x1010n]);
});

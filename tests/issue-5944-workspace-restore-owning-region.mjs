import assert from 'node:assert/strict';
import { NoteStore } from '../js/names.js';
import { applyWorkspaceProject } from '../js/workspace.js';

if (!globalThis.localStorage) {
  const map = new Map();
  globalThis.localStorage = {
    getItem(k) { return map.get(String(k)) ?? null; },
    setItem(k, v) { map.set(String(k), String(v)); },
    removeItem(k) { map.delete(String(k)); },
    clear() { map.clear(); },
  };
}

const text = { id: 'text', name: '__text', vmAddr: 0x1000n, size: 0x100n };
const cold = { id: 'cold', name: '__text_cold', vmAddr: 0x3000n, size: 0x100n };

function fakeApp({ withGoToAddress }) {
  const regions = [text, cold];
  let currentRegion = text;
  const storeMap = new Map([['regions', regions], ['currentRegion', text]]);
  const app = {
    notes: new NoteStore('binary-A'),
    navigation: null,
    patches: { list: () => [], add() {}, clear() {} },
    store: {
      get: (k) => storeMap.get(k),
      set: (o) => { for (const [k, v] of Object.entries(o)) storeMap.set(k, v); },
    },
    codeRegion: () => text,
    viewer: { region: null, goToAddress(addr) { return addr >= currentRegion.vmAddr && addr < currentRegion.vmAddr + currentRegion.size; } },
    selectRegionCalls: [],
    selectRegion(region) { this.selectRegionCalls.push(region); currentRegion = region; storeMap.set('currentRegion', region); },
  };
  if (withGoToAddress) {
    // Mirror production App.goToAddress: in-region → viewer; out-of-region →
    // selectRegion(target) + viewer.
    app.goToAddress = (addr, { history = true } = {}) => {
      const region = storeMap.get('currentRegion');
      if (addr >= region.vmAddr && addr < region.vmAddr + region.size) {
        if (!app.viewer.goToAddress(addr)) return false;
        if (history) app.navigation?.visit?.();
        return true;
      }
      const target = regions.find((r) => r.size > 0n && addr >= r.vmAddr && addr < r.vmAddr + r.size);
      if (!target) return false;
      app.selectRegion(target);
      if (!app.viewer.goToAddress(addr)) return false;
      if (history) app.navigation?.visit?.();
      return true;
    };
  }
  return app;
}

const project = (currentFunction) => ({
  version: 2,
  user: { names: [], comments: [], types: [], vars: [], structs: [] },
  navigation: { currentFunction, history: [], bookmarks: [] },
});

// Issue #5944: production-style app must switch to the owning region before
// restoring a cursor saved in a non-primary region.
{
  const app = fakeApp({ withGoToAddress: true });
  applyWorkspaceProject(app, project(0x3040n));
  assert.deepEqual(app.selectRegionCalls, [cold], 'restore must selectRegion the owning region');
  assert.equal(app.store.get('currentRegion'), cold);
}

// Primary-region cursor: no region switch, still restores.
{
  const app = fakeApp({ withGoToAddress: true });
  applyWorkspaceProject(app, project(0x1040n));
  assert.deepEqual(app.selectRegionCalls, []);
  assert.equal(app.store.get('currentRegion'), text);
}

// Unmapped address: no region switch.
{
  const app = fakeApp({ withGoToAddress: true });
  applyWorkspaceProject(app, project(0x9000n));
  assert.deepEqual(app.selectRegionCalls, []);
}

// Embedder app without app-level navigation keeps legacy restore semantics.
{
  const app = fakeApp({ withGoToAddress: false });
  app.regionForAddress = (addr) => (addr >= cold.vmAddr && addr < cold.vmAddr + cold.size ? cold : text);
  app.viewer.goToAddress = () => true;
  applyWorkspaceProject(app, project(0x3040n));
  assert.equal(app.store.get('currentAddress'), 0x3040n,
    'embedder regionForAddress path must still set the restored address');
}

console.log('issue-5944 workspace current-function restore selects owning region: ok');

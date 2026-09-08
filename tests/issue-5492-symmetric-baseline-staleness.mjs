// Regression for #5492: the symmetric diff loadBaseline wrapper must
// re-verify baseline currency after its unguarded discovery/fingerprint
// awaits. A load superseded mid-flight must settle stale instead of
// resolving as a normal success.
import assert from 'node:assert/strict';
import { ProductWorkspace } from '../js/workspace.js';
import { installSymmetricWorkspaceDiff } from '../js/diff/symmetric-workspace-runtime.js';

class Storage { constructor() { this.m = new Map(); } getItem(k) { return this.m.get(k) || null; } setItem(k, v) { this.m.set(k, String(v)); } }
const region = { id: 'text', name: '__text', exec: true, vmAddr: 0x1000n, size: 0x1000n, fileOffset: 0n };
function makeInfo(name, uuid) {
  return { name, size: 4096, format: 'macho', slices: [{ offset: 0n, size: 4096n, info: { uuid, architecture: 'arm64' }, capability: { architecture: 'arm64' }, regions: [region] }] };
}
function makeApp(hash) {
  const values = { fileInfo: makeInfo('same.bin', 'A'), file: { name: 'same.bin', size: 4096 }, sliceIndex: 0, architecture: 'arm64', currentAddress: 0x1000n, canDisassemble: false };
  const store = { values, get(k) { return this.values[k]; } };
  return {
    store,
    backend: { gen: 1, contentHash: hash, async ensureContentHash() { return this.contentHash; } },
    notes: { id: 'notes', names: new Map(), comments: new Map(), types: new Map(), vars: new Map(), structs: [], nameEntries() { return []; }, save() { return true; } },
    patches: { x: [], clear() { this.x = []; }, list() { return this.x.slice(); }, add() {} },
    bookmarks: { list: () => [] },
    navigation: { lastQuery: null, history: [], entries: [], limit: 20, cursorIndex: 0, index: 0, snapshot() { return {}; }, onChange: null },
  };
}

// A baseline backend whose symbol discovery is deferable, injected so the
// workspace does not own (or dispose) it — isolating the staleness race.
function makeBackendBackend(hangGate) {
  const symbols = { functionStartsComplete: false, functionCount: 0 };
  return {
    async open() { return makeInfo('base.bin', 'B'); },
    async ensureContentHash() { return 'hash-old'; },
    async analyze() { return { functions: [], symbols }; },
    // Called by discoverBaselineFunctions; resolves only when released.
    async guessFunctions() { await hangGate.promise; return { results: [], reasons: [] }; },
    async readAt() { return { found: false, bytes: new Uint8Array(0) }; },
  };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const app = makeApp('hash-a');
const workspace = new ProductWorkspace(app, { storage: new Storage(), backendFactory: () => ({ gen: 1, contentHash: 'hash-a', async ensureContentHash() { return 'hash-a'; }, async open() { return makeInfo('same.bin', 'A'); }, async analyze() { return { functions: [], symbols: { functionStartsComplete: true, functionCount: 0 } }; } }) });
await workspace.bind();
app.workspace = workspace;
installSymmetricWorkspaceDiff(app);
assert.equal(workspace.__symmetricWorkspaceDiffVersion, 'symmetric-workspace-diff/v2', 'the symmetric wrapper must be installed');

const gateA = deferred();
let loads = 0;
workspace.loadBaseline = ((original) => async function loadBaseline(file, options = {}) {
  loads++;
  // Load A's symbol discovery stays parked on gateA until the end of the test;
  // later loads resolve immediately.
  const gate = loads === 1 ? gateA : deferred();
  if (loads !== 1) gate.resolve();
  const backend = makeBackendBackend(gate);
  return original.call(workspace, file, { ...options, backend });
})(workspace.loadBaseline);

const loadA = workspace.loadBaseline(new Blob([new Uint8Array(32)]));
// Let A's base load finish and its wrapper enter the discovery await.
await new Promise((r) => setTimeout(r, 20));
assert.equal(workspace.baseline?.file instanceof Blob, true, 'A becomes the live baseline after its base load');

const loadB = workspace.loadBaseline(new Blob([new Uint8Array(64)]));
const b = await loadB;
assert.equal(workspace.baseline, b, 'B supersedes A');

// A's discovery resolves late: it must settle stale, not as a success.
let aOutcome = null;
loadA.then(() => { aOutcome = 'resolved'; }, (error) => { aOutcome = error; });
gateA.resolve();
await new Promise((r) => setTimeout(r, 30));
assert.ok(aOutcome instanceof Error, `the superseded load must reject, got ${String(aOutcome)}`);
assert.equal(aOutcome.code, 'HEX_WORKSPACE_STALE');

console.log('issue #5492 symmetric baseline staleness regressions PASS');

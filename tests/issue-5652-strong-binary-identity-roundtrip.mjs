// Regression for #5652: project export/import must round-trip AI
// investigation sessions bound with the strong `content:<hash>[:<slice>]`
// binary identity, not only the raw content hash.
import assert from 'node:assert/strict';
import { ProductWorkspace, snapshotWorkspace, applyWorkspaceProject } from '../js/workspace.js';
import { InvestigationSessionStore } from '../js/ai/session-core/index.js';

class Storage { constructor() { this.m = new Map(); } getItem(k) { return this.m.get(k) || null; } setItem(k, v) { this.m.set(k, String(v)); } }
const region = { id: 'text', name: '__text', exec: true, vmAddr: 0x1000n, size: 0x1000n, fileOffset: 0n };
function makeInfo(name, uuid) {
  return { name, size: 4096, format: 'macho', slices: [{ offset: 0n, size: 4096n, info: { uuid, architecture: 'arm64' }, capability: { architecture: 'arm64' }, regions: [region] }] };
}
function makeApp(hash) {
  const values = { fileInfo: makeInfo('same.bin', 'A'), file: { name: 'same.bin', size: 4096 }, sliceIndex: 0, architecture: 'arm64', currentAddress: 0x1000n, canDisassemble: false };
  const store = { values, get(k) { return this.values[k]; } };
  const backend = { gen: 1, contentHash: hash, async ensureContentHash() { return this.contentHash; } };
  return {
    store, backend,
    notes: { id: 'notes', names: new Map(), comments: new Map(), types: new Map(), vars: new Map(), structs: [], nameEntries() { return [...this.names].map(([k, name]) => ({ addr: BigInt(k), name })); }, save() { return true; } },
    patches: { x: [], clear() { this.x = []; }, list() { return this.x.slice(); }, add() {} },
    bookmarks: { list: () => [] },
    navigation: { lastQuery: null, history: [], entries: [], limit: 20, cursorIndex: 0, index: 0, snapshot() { return {}; }, onChange: null },
  };
}

// Export: a session bound with the strong identity must be captured.
const app = makeApp('content-a');
const workspace = new ProductWorkspace(app, { storage: new Storage() });
await workspace.bind();
const store = new InvestigationSessionStore({
  persistence: {
    list() { return []; },
    async load() { return null; },
    async save(session) {
      workspace.project.findings ||= {};
      if (!Array.isArray(workspace.project.findings.investigationSessions)) workspace.project.findings.investigationSessions = [];
      workspace.project.findings.investigationSessions.push(session);
    },
    async delete() {},
  },
});
await store.create({ jobId: 'strong-1', binaryId: 'content:content-a:0', goal: 'strong binding' });
app.aiRuntime = { sessionStore: store };

const snapshot = snapshotWorkspace(app, workspace.identity);
const exported = snapshot.findings?.investigationSessions || [];
assert.equal(exported.length, 1, `the strong-bound session must be exported, got ${exported.length}`);
assert.equal(exported[0].id, store.list('content:content-a:0')[0].id);

// A session from a different binary must still be excluded.
const foreign = makeApp('content-b');
const foreignStore = new InvestigationSessionStore({});
foreignStore.register({ id: 'foreign-1', binaryId: 'content:other-binary:0', goal: 'other' });
foreign.aiRuntime = { sessionStore: foreignStore };
const foreignSnapshot = snapshotWorkspace(foreign, foreign.identity);
assert.equal((foreignSnapshot.findings?.investigationSessions || []).length, 0, 'other-binary sessions stay excluded');

// Import: strong-bound sessions register; raw-hash sessions still do.
const app2 = makeApp('content-a');
const store2 = new InvestigationSessionStore({});
app2.aiRuntime = { sessionStore: store2 };
applyWorkspaceProject(app2, snapshot);
const imported = store2.list();
assert.equal(imported.length, 1, `the strong-bound session must register on import, got ${imported.length}`);
assert.equal(imported[0].binaryId, 'content:content-a:0');

// A foreign binary's sessions are still skipped on import.
const app3 = makeApp('content-a');
const store3 = new InvestigationSessionStore({});
app3.aiRuntime = { sessionStore: store3 };
const minimalProject = { binary: { hash: 'content-a', metadata: {} }, user: { names: [], comments: [], types: [], vars: [], structs: [] }, findings: { investigationSessions: [{ id: 'x', binaryId: 'content:content-a:9', goal: 'other slice' }] }, navigation: {} };
applyWorkspaceProject(app3, minimalProject);
assert.equal(store3.list().length, 1, 'the same binary at another slice still binds');
applyWorkspaceProject(app3, { ...minimalProject, findings: { investigationSessions: [{ id: 'y', binaryId: 'content:zzz:0', goal: 'unrelated' }] } });
assert.equal(store3.list().length, 1, 'unrelated-binary sessions stay skipped');

console.log('issue #5652 strong binary identity round-trip regressions PASS');

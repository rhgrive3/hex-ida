// Regression for #3767: `project-annotation` canonical state lives in
// `app.projectAnnotations` (the sole lookup source used by
// ProposalExecutor.currentState()), but the workspace project round-trip
// only persisted the confirmed-finding projection. After autosave/export ->
// import/reload the canonical store came back empty, so the same annotation
// id resolved to null and the approval/stale-state contract diverged between
// the UI report side and the mutation control-plane.
import assert from 'node:assert/strict';
import { snapshotWorkspace, applyWorkspaceProject } from '../js/workspace.js';
import { serializeHexProject, parseHexProject } from '../js/project/index.js';
import { ProposalExecutor } from '../js/ai/interaction/proposal-executor.js';

function makeApp() {
  const values = { currentAddress: 0x1000n, regions: [] };
  return {
    store: { values, get(k) { return this.values[k]; }, set(o) { Object.assign(this.values, o || {}); } },
    backend: { gen: 1, contentHash: 'hash-3767', async ensureContentHash() { return this.contentHash; } },
    notes: { id: 'notes', names: new Map(), comments: new Map(), types: new Map(), vars: new Map(), structs: [], dirty: false, lastSaveError: null, nameEntries() { return []; }, save() { return true; } },
    patches: { clear() {}, add() {}, list: () => [] },
    bookmarks: { list: () => [], restore() {} },
    navigation: { entries: [], index: -1, limit: 20, snapshot() { return { entries: this.entries, index: this.index }; }, onChange() {} },
    prefs: { lang: 'en', explain: false, textSize: 'm' },
    codeRegion: () => ({ id: 'text', vmAddr: 0x1000n, size: 0x1000n }),
    viewer: { goToAddress() {}, setSymbols() {} },
    symbols: { gen: 0, rename() {} },
    projectAnnotations: [],
  };
}

// The mutation authority (`js/ai/capabilities/executor.js::setProjectAnnotation`)
// writes the canonical record into `app.projectAnnotations` and mirrors it as a
// confirmed-finding projection. Seed the same shape the executor produces.
function seedCanonical(app, id, value) {
  const record = { id, kind: 'note', value, createdAt: '2026-01-01T00:00:00.000Z' };
  app.projectAnnotations.push(record);
  app.autoReport = { report: { confirmed: [{ ...record, confirmed: true, source: 'project-annotation' }], deep: [] }, key: 'text', gen: 0 };
  return record;
}

function annotationState(app, id) {
  return new ProposalExecutor({ app }).currentState({ kind: 'project-annotation', target: { id } });
}

async function main() {
  const app = makeApp();
  seedCanonical(app, 'finding-1', { verdict: 'verified' });

  // Baseline: the canonical authority resolves the value before round-trip.
  assert.deepEqual(await annotationState(app, 'finding-1'), { verdict: 'verified' },
    'precondition: canonical annotation must resolve before persistence');

  // Round-trip through the real persistence boundary (snapshot -> serialize ->
  // parse -> apply), the same path autosave/export/import/reload take.
  const snapshot = snapshotWorkspace(app, { hash: 'hash-3767' });
  const persisted = parseHexProject(serializeHexProject(snapshot));
  assert.deepEqual(persisted.projectAnnotations,
    [{ id: 'finding-1', kind: 'note', value: { verdict: 'verified' }, createdAt: '2026-01-01T00:00:00.000Z' }],
    'project schema must serialize the canonical projectAnnotations');

  const fresh = makeApp();
  applyWorkspaceProject(fresh, persisted);

  const restored = await annotationState(fresh, 'finding-1');
  assert.deepEqual(restored, { verdict: 'verified' },
    'ProposalExecutor.currentState() must return the same logical value after restore');
  assert.equal(fresh.projectAnnotations.length, 1, 'restore must not duplicate the annotation');

  // No double authority: the confirmed-finding projection and the canonical
  // store must agree on the same logical value after restore.
  const projection = fresh.autoReport?.report?.confirmed?.find((item) => item?.source === 'project-annotation' && item?.id === 'finding-1');
  assert.ok(projection, 'the confirmed-finding projection must also survive restore');
  assert.deepEqual(projection.value, restored, 'projection and canonical annotation authority must not diverge');

  // Idempotent second round-trip keeps a single canonical record.
  const again = parseHexProject(serializeHexProject(snapshotWorkspace(fresh, { hash: 'hash-3767' })));
  const fresh2 = makeApp();
  applyWorkspaceProject(fresh2, again);
  assert.equal(fresh2.projectAnnotations.length, 1, 'repeated round-trips must not accumulate duplicates');
  assert.deepEqual(await annotationState(fresh2, 'finding-1'), { verdict: 'verified' });

  // Legacy projects without the field restore to a safe empty canonical store.
  const legacy = makeApp();
  seedCanonical(legacy, 'stale', { verdict: 'old' });
  const legacyProject = { binary: { hash: 'hash-3767', metadata: {} }, user: { patches: [] }, findings: { confirmed: [], evidence: [] }, navigation: {} };
  applyWorkspaceProject(legacy, legacyProject);
  assert.deepEqual(legacy.projectAnnotations, [], 'legacy project without projectAnnotations must restore to empty');
  assert.equal(await annotationState(legacy, 'stale'), null, 'stale annotation from a legacy import must not linger');
}

await main();
console.log('issue #3767 project-annotation workspace round-trip regression PASS');

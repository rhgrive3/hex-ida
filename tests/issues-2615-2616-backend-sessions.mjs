import assert from 'node:assert/strict';
import { Backend } from '../js/backend.js';
import { snapshotWorkspace, applyWorkspaceProject } from '../js/workspace.js';
import { InvestigationSessionStore, createInvestigationSession } from '../js/ai/session-core/index.js';

// --- #2616: Backend does not start workers until needed (lazy worker lifecycle) ---
{
  const b = new Backend();
  assert.equal(b._legacyWorker, null, '#2616: legacy worker must not be instantiated on construction');
  assert.equal(b._platformWorker, null, '#2616: platform worker must not be instantiated on construction');

  // Request to platform worker instantiates platform worker only
  let platformTriggered = false;
  b.platformWorker = {
    sent: [],
    terminated: false,
    postMessage(msg) { this.sent.push(msg); platformTriggered = true; },
    terminate() { this.terminated = true; },
  };
  const platformCall = b._callTo('platform', 'probe', {});
  platformCall.catch(() => {});
  assert.ok(platformTriggered, 'platform call must use platform worker');
  assert.equal(b._legacyWorker, null, 'legacy worker must not be instantiated on platform call');

  // Advance epoch does not force create missing legacy worker
  b.advanceEpoch();
  assert.equal(b._legacyWorker, null, 'advanceEpoch must not eagerly spawn uninstantiated legacy worker');

  // Dispose cleans up safely
  b.dispose();
  assert.equal(b._platformWorker, null, 'disposed backend must clear platform worker');
  assert.equal(b._legacyWorker, null, 'disposed backend must clear legacy worker');
}

// --- #2615: .hexproj investigationSessions round-trip & AI continuity ---
{
  const sessionStore = new InvestigationSessionStore();
  const session1 = createInvestigationSession({
    id: 'session-auth-123',
    binaryId: 'bin-sha-abc',
    goal: 'Analyze auth bypass',
    hypotheses: [{ id: 'h1', text: 'Auth check in sub_1000' }],
    confirmedFindings: [{ id: 'f1', claim: 'Auth check bypassed when r0 == 0' }],
  });
  sessionStore.register(session1);

  const fakeApp = {
    backend: { contentHash: 'bin-sha-abc' },
    notes: {
      id: 'n1', names: new Map(), comments: new Map(), types: new Map(), vars: new Map(), structs: [],
      nameEntries: () => [], save: () => true,
    },
    navigation: { entries: [], index: -1 },
    bookmarks: { list: () => [] },
    patches: { list: () => [], clear: () => {}, add: () => {} },
    autoReport: null,
    prefs: { lang: 'ja' },
    store: { get: () => null },
    aiRuntime: { sessionStore },
  };

  // Snapshot workspace with real investigation sessions
  const snap = snapshotWorkspace(fakeApp, { hash: 'bin-sha-abc' });
  assert.ok(Array.isArray(snap.findings.investigationSessions), '#2615: investigationSessions must be array');
  assert.equal(snap.findings.investigationSessions.length, 1);
  assert.equal(snap.findings.investigationSessions[0].id, 'session-auth-123');
  assert.equal(snap.findings.investigationSessions[0].hypotheses.length, 1);
  assert.equal(snap.findings.investigationSessions[0].confirmedFindings.length, 1);

  // Restore into a fresh app with new session store
  const targetSessionStore = new InvestigationSessionStore();
  const restoredApp = {
    ...fakeApp,
    aiRuntime: { sessionStore: targetSessionStore },
  };

  applyWorkspaceProject(restoredApp, snap);
  const restored = await targetSessionStore.get('session-auth-123');
  assert.ok(restored, '#2615: session must be restored into AI session store');
  assert.equal(restored.id, 'session-auth-123');
  assert.equal(restored.hypotheses[0].text, 'Auth check in sub_1000');
  assert.equal(restored.confirmedFindings[0].claim, 'Auth check bypassed when r0 == 0');

  // Mismatch binaryId must fail closed and not attach to wrong binary
  const mismatchSessionStore = new InvestigationSessionStore();
  const mismatchApp = {
    ...fakeApp,
    backend: { contentHash: 'bin-sha-DIFFERENT' },
    aiRuntime: { sessionStore: mismatchSessionStore },
  };
  applyWorkspaceProject(mismatchApp, snap);
  assert.equal(await mismatchSessionStore.get('session-auth-123'), null, '#2615: mismatched binary session must not attach');
}

console.log('Issues #2615, #2616 regression tests PASS!');

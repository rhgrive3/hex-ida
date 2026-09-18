import assert from 'node:assert/strict';
import { createHexProject, serializeHexProject, parseHexProject, ProjectFormatError } from '../js/project/index.js';
import { snapshotWorkspace, applyWorkspaceProject } from '../js/workspace.js';
import { createAiEngine } from '../js/ai/ui/bridge.js';
import { sessionMatchesSnapshot, assertLiveBindingsUnchanged } from '../js/ai/control/runtime-support.js';
import { createAIRuntime } from '../js/ai/runtime.js';
import { InvestigationSessionStore } from '../js/ai/session-core/index.js';

const BINARY_HASH = '11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff';

// 1. Same binary hash producing distinct projects gives distinct project IDs.
const projA = createHexProject({ binary: { hash: BINARY_HASH } });
const projB = createHexProject({ binary: { hash: BINARY_HASH } });
assert.ok(projA.id, 'project A has id');
assert.ok(projB.id, 'project B has id');
assert.notEqual(projA.id, projB.id, 'distinct projects must have distinct IDs even with identical binary hash');
assert.notEqual(projA.id, BINARY_HASH, 'project ID must not equal binary hash');
assert.notEqual(projB.id, BINARY_HASH, 'project ID must not equal binary hash');

// Explicit ID is preserved, malformed ID fails closed.
const explicit = createHexProject({ id: 'proj_custom_123', binary: { hash: BINARY_HASH } });
assert.equal(explicit.id, 'proj_custom_123');
assert.throws(() => createHexProject({ id: '   ' }), ProjectFormatError);
assert.throws(() => createHexProject({ id: 12345 }), ProjectFormatError);

// 2. First-party AI bridge does NOT fall back to binary hash when project is unbound.
{
  const mockApp = {
    backend: { contentHash: BINARY_HASH },
    notes: { names: new Map(), comments: new Map(), types: new Map(), vars: new Map(), structs: [], dirty: false, id: 'notes-1' },
    patches: { list: () => [] },
  };
  const engine = createAiEngine(mockApp);
  const context = engine.localContext;
  assert.equal(context.binaryHash, BINARY_HASH);
  assert.equal(context.projectId, null, 'unbound project must give null projectId, not binary hash fallback');

  // When project A is active:
  mockApp.project = projA;
  assert.equal(context.projectId, projA.id, 'bridge must report project A id');

  // When project B is active:
  mockApp.project = projB;
  assert.equal(context.projectId, projB.id, 'bridge must report project B id after switch');
}

// 3. sessionMatchesSnapshot rejects cross-project reuse under the same binary.
{
  const sessionA = {
    id: 'session-a',
    binaryId: `content:${BINARY_HASH}`,
    projectId: projA.id,
    investigationMemory: { anchor: null },
  };
  const snapshotSameProject = {
    binaryId: `content:${BINARY_HASH}`,
    projectIdentity: projA.id,
    runtimeSessionIdentity: null,
  };
  const snapshotOtherProject = {
    binaryId: `content:${BINARY_HASH}`,
    projectIdentity: projB.id,
    runtimeSessionIdentity: null,
  };

  assert.equal(sessionMatchesSnapshot(sessionA, snapshotSameProject), true, 'same binary + same project matches');
  assert.equal(sessionMatchesSnapshot(sessionA, snapshotOtherProject), false, 'same binary + different project must NOT match');
}

// 4. Live project binding drift is detected if project switches mid-turn.
{
  const localContext = {
    projectId: projA.id,
    project: projA,
    binaryFingerprint: { algorithm: 'content-hash', hash: BINARY_HASH },
  };
  const turnSnapshot = {
    binaryId: `content:${BINARY_HASH}`,
    binaryIdentity: { id: `content:${BINARY_HASH}`, kind: 'content-derived', confidence: 'strong', algorithm: 'content-hash', hash: BINARY_HASH },
    binaryIdentitySource: 'request-fallback',
    liveBinaryIdentity: { id: `content:${BINARY_HASH}`, kind: 'content-derived', confidence: 'strong', algorithm: 'content-hash', hash: BINARY_HASH },
    projectIdentity: projA.id,
  };

  assert.doesNotThrow(() => assertLiveBindingsUnchanged(localContext, turnSnapshot));

  // Switch project to B while turn was running:
  localContext.projectId = projB.id;
  localContext.project = projB;
  assert.throws(
    () => assertLiveBindingsUnchanged(localContext, turnSnapshot),
    (err) => err.type === 'scope_violation',
    'live project switch during turn must fail closed with scope_violation',
  );
}

// 5. AIRuntime turn rejects session from project A when active project is project B.
{
  const sessionStore = new InvestigationSessionStore();
  const sessionA = await sessionStore.create({
    id: 'inv_proj_a_session',
    binaryId: `content:${BINARY_HASH}`,
    projectId: projA.id,
    goal: 'A secret investigation',
  });

  const localContext = {
    projectId: projB.id,
    project: projB,
    binaryFingerprint: { algorithm: 'content-hash', hash: BINARY_HASH },
    binaryIdentity: { id: `content:${BINARY_HASH}`, kind: 'content-derived', confidence: 'strong', algorithm: 'content-hash', hash: BINARY_HASH },
    binaryId: `content:${BINARY_HASH}`,
  };

  const runtime = createAIRuntime({
    sessionStore,
    localContext,
    provider: { complete: async () => ({ role: 'assistant', text: 'answer' }) },
  });

  await assert.rejects(
    () => runtime.turn({ sessionId: sessionA.id, goal: 'B question' }),
    (err) => err.type === 'scope_violation',
    'AIRuntime must reject reusing session from another project with same binary',
  );
}

// 6. snapshotWorkspace / export filters out sessions belonging to other projects.
{
  const sessionStore = new InvestigationSessionStore();
  await sessionStore.create({
    id: 'session-a',
    binaryId: `content:${BINARY_HASH}`,
    projectId: projA.id,
    goal: 'A secret investigation',
  });
  await sessionStore.create({
    id: 'session-b',
    binaryId: `content:${BINARY_HASH}`,
    projectId: projB.id,
    goal: 'B investigation',
  });

  const mockApp = {
    project: projB,
    aiRuntime: { sessionStore },
    notes: { names: new Map(), comments: new Map(), types: new Map(), vars: new Map(), structs: [], dirty: false, id: 'notes-1' },
    patches: { list: () => [] },
  };

  const snapshot = snapshotWorkspace(mockApp, { hash: BINARY_HASH });
  const exportedSessions = snapshot.findings.investigationSessions;
  assert.equal(exportedSessions.length, 1, 'only project B session should be included in project B snapshot');
  assert.equal(exportedSessions[0].id, 'session-b', 'session-b must be retained');
  assert.equal(exportedSessions[0].projectId, projB.id);
}

// 7. Save / reload / reopen preserves exact project ID.
{
  const serializedA = serializeHexProject(projA);
  const parsedA = parseHexProject(serializedA);
  assert.equal(parsedA.id, projA.id, 'project id must survive serialization round-trip');

  const serializedB = serializeHexProject(projB);
  const parsedB = parseHexProject(serializedB);
  assert.equal(parsedB.id, projB.id, 'project id B must survive serialization round-trip');
}

// 8. Legacy project without ID is assigned a stable minted ID upon parse/migration.
{
  const rawLegacy = JSON.parse(serializeHexProject(projA));
  delete rawLegacy.id;
  const migrated = parseHexProject(JSON.stringify(rawLegacy));
  assert.ok(migrated.id, 'legacy project must gain an id on parse');
  assert.match(migrated.id, /^proj_/, 'minted id follows proj_ convention');

  // Once migrated and saved, it does not change ID on subsequent load.
  const reloaded = parseHexProject(serializeHexProject(migrated));
  assert.equal(reloaded.id, migrated.id, 'minted id is stable across subsequent save/reload');
}

console.log('issue #8934 AI project isolation regressions: PASS');

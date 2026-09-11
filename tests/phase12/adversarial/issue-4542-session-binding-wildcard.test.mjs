import assert from 'node:assert/strict';
import { createAiEngine } from '../../../js/ai/ui/bridge.js';
import { sessionMatchesSnapshot } from '../../../js/ai/control/runtime-support.js';

const strongIdentity = {
  id: 'content:beef:0',
  kind: 'content-derived',
  confidence: 'strong',
  state: 'ready',
  algorithm: 'content-hash',
  hash: 'beef',
  legacyId: 'fixture:0',
};
const strongSnapshot = {
  binaryId: strongIdentity.id,
  binaryIdentity: strongIdentity,
  legacyBinaryId: strongIdentity.legacyId,
  projectIdentity: 'project-B',
  runtimeSessionIdentity: null,
  runtimeSessionState: 'unknown',
};

function session(overrides = {}) {
  return {
    id: 'session-4542',
    binaryId: strongIdentity.id,
    binaryIdentity: strongIdentity,
    projectId: 'project-B',
    investigationMemory: { anchor: null },
    ...overrides,
  };
}

assert.equal(
  sessionMatchesSnapshot(session({ binaryId: null, binaryIdentity: null, projectId: null }), strongSnapshot),
  false,
  'an unbound persisted session must not wildcard-match a strong binary/project',
);
assert.equal(
  sessionMatchesSnapshot(
    session({ binaryId: null, binaryIdentity: null, projectId: null }),
    { ...strongSnapshot, binaryId: null, binaryIdentity: null, legacyBinaryId: null, projectIdentity: null },
  ),
  true,
  'two genuinely unbound snapshots remain compatible',
);
assert.equal(sessionMatchesSnapshot(session(), strongSnapshot), true, 'exact strong bindings remain compatible');
assert.equal(
  sessionMatchesSnapshot(session({ binaryId: 'fixture:0', binaryIdentity: null }), strongSnapshot),
  true,
  'an explicit legacy binary ID can migrate to the matching strong identity',
);
assert.equal(
  sessionMatchesSnapshot(session({ projectId: null }), strongSnapshot),
  false,
  'a projectless session must not match when the current project is known',
);
assert.equal(
  sessionMatchesSnapshot(session({ projectId: 'project-A' }), strongSnapshot),
  false,
  'a session from another project must remain isolated',
);

function makeApp(sessions) {
  const project = { id: 'project-B', findings: { investigationSessions: sessions } };
  return {
    backend: { contentHash: 'beef', binaryId: 'fixture:0' },
    project,
    store: {
      get(key) {
        if (key === 'fileInfo') return { name: 'fixture' };
        if (key === 'sliceIndex') return 0;
        if (key === 'regions') return [];
        return null;
      },
    },
    notes: { structs: [] },
    symbols: null,
    recognition: { records: [] },
    stringIndex: [],
    workspace: { project, autosave() {} },
  };
}

async function firstSessionId(persisted) {
  const calls = [];
  const engine = createAiEngine(makeApp(persisted), {
    loadCore: async () => ({
      async turn(input) {
        calls.push({ ...input });
        return { sessionId: 'fresh-4542', answer: 'ok' };
      },
    }),
  });
  await engine.run({ question: 'resume check', mode: 'chat', style: 'analyst', scope: 'auto' });
  return calls[0]?.sessionId ?? null;
}

assert.equal(
  await firstSessionId([session({ binaryId: null, binaryIdentity: null, projectId: null })]),
  null,
  'the bridge must not auto-reconnect to the only unbound persisted session',
);
assert.equal(
  await firstSessionId([session()]),
  'session-4542',
  'the bridge still reconnects an exact binary/project-bound session',
);
assert.equal(
  await firstSessionId([session({ binaryId: 'fixture:0', binaryIdentity: null })]),
  'session-4542',
  'the bridge preserves explicit legacy binary-ID migration',
);

console.log('issue-4542 session binding wildcard regression: ok');

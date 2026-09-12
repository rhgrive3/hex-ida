import assert from 'node:assert/strict';
import {
  createInvestigationSession,
  InvestigationSessionStore,
} from '../../../js/ai/session-core/index.js';
import { sessionMatchesSnapshot } from '../../../js/ai/control/runtime-support.js';

function hostile(text) {
  let calls = 0;
  return {
    value: {
      toString() { calls++; return text; },
      valueOf() { calls++; return text; },
    },
    calls: () => calls,
  };
}

for (const [field, value] of [
  ['binaryId', ['content:abc']],
  ['projectId', ['project-1']],
  ['binaryId', { id: 'content:abc' }],
  ['projectId', { id: 'project-1' }],
]) {
  assert.throws(
    () => createInvestigationSession({ id: `bad-${field}`, [field]: value }),
    TypeError,
    `${field} must reject structured identity instead of String()-aliasing it`,
  );
}

for (const field of ['binaryId', 'projectId']) {
  const probe = hostile(field === 'binaryId' ? 'content:abc' : 'project-1');
  assert.throws(() => createInvestigationSession({ id: `hostile-${field}`, [field]: probe.value }), TypeError);
  assert.equal(probe.calls(), 0, `${field} validation must not invoke coercion hooks`);
}

const canonical = createInvestigationSession({
  id: 'valid-binding',
  binaryId: ' content:abc ',
  projectId: ' project-1 ',
});
assert.equal(canonical.binaryId, 'content:abc');
assert.equal(canonical.projectId, 'project-1');

const snapshot = {
  binaryId: 'content:abc',
  binaryIdentity: { id:'content:abc', kind:'content-derived', confidence:'strong', state:'ready', hash:'abc', legacyId:'legacy.bin:0' },
  legacyBinaryId: 'legacy.bin:0',
  projectIdentity: 'project-1',
  runtimeSessionIdentity: 'runtime-1',
  runtimeSessionState: 'bound',
};
assert.equal(sessionMatchesSnapshot({
  id:'runtime-array', binaryId:'content:abc', projectId:'project-1',
  investigationMemory:{ anchor:{ runtimeSessionId:['runtime-1'], runtimeSessionState:'bound' } },
}, snapshot), false, 'structured runtime anchor must fail closed');

let saveCalls = 0;
const persistedBad = new InvestigationSessionStore({ persistence: {
  async load(id) {
    return id === 'persisted-bad' ? {
      id,
      binaryId: ['content:abc'],
      projectId: ['project-1'],
      goal: 'corrupt persisted binding',
    } : null;
  },
  async save() { saveCalls++; },
} });
assert.equal(await persistedBad.get('persisted-bad'), null, 'malformed persisted binding must be quarantined, not normalized into a valid session');
assert.equal(saveCalls, 0);

const store = new InvestigationSessionStore({ persistence: { async load() { return null; }, async save() { saveCalls++; } } });
await store.create({ id:'update-binding', binaryId:'legacy.bin:0', projectId:'project-1' });
const before = await store.get('update-binding');
await assert.rejects(store.update('update-binding', { binaryId:['content:abc'] }), TypeError);
await assert.rejects(store.update('update-binding', { projectId:['project-2'] }), TypeError);
assert.equal((await store.get('update-binding')).binaryId, before.binaryId, 'failed binary binding update must not mutate visible state');
assert.equal((await store.get('update-binding')).projectId, before.projectId, 'failed project binding update must not mutate visible state');

const upgraded = await store.update('update-binding', {
  binaryIdentity: {
    id:'content:abc', kind:'content-derived', confidence:'strong', state:'ready', hash:'abc', legacyId:'legacy.bin:0',
  },
});
assert.equal(upgraded.binaryId, 'content:abc', 'weak legacy -> strong identity migration must remain atomic');
assert.equal(store.list(['content:abc']).length, 0, 'structured list filter must not alias a canonical binary ID');
assert.equal(store.list('content:abc').length, 1, 'canonical list filter remains supported');

console.log('issue-4301 session binding identity regression: ok');

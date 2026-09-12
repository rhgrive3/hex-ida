import assert from 'node:assert/strict';
import test from 'node:test';
import { InvestigationSessionStore } from '../../../js/ai/session-core/index.js';
import { createLiveProjectSessionPersistence } from '../../../js/ai/ui/bridge.js';

function fixture(sessions = []) {
  const project = { findings: { investigationSessions: sessions } };
  let failure = 'false';
  let saves = 0;
  const app = { workspace: { project, autosave() {
    saves++;
    if (failure === 'throw') throw new Error('storage unavailable');
    return failure === null;
  } }, activeProject: project };
  return {
    project,
    persistence: createLiveProjectSessionPersistence(app),
    recover() { failure = null; },
    failWith(error) { failure = error; },
    saves() { return saves; },
  };
}

// Await each test so the canonical import runner does not carry a pending
// autosave timer into other suites that temporarily instrument global timers.
for (const failure of ['false', 'throw']) await test(`#4578 live create can retry after autosave ${failure}`, async () => {
  const f = fixture();
  f.failWith(failure);
  const store = new InvestigationSessionStore({ persistence: f.persistence });
  await assert.rejects(store.create({ id: 'retry', goal: 'first' }), /autosave-failed|storage unavailable/);
  assert.equal(store.sessions.has('retry'), false);
  assert.equal(f.project.findings.investigationSessions.length, 0, 'failed creation must not claim a persisted ID');
  f.recover();
  assert.equal((await store.create({ id: 'retry', goal: 'recovered' })).goal, 'recovered');
  await assert.rejects(store.create({ id: 'retry' }), /already exists/);
  assert.equal(f.saves(), 2, 'duplicate rejection must not perform another autosave');
});

await test('#4578 failed coalesced same-ID writes restore the record before the failed batch', async () => {
  for (const original of [null, { id: 'shared', goal: 'keep' }]) {
    const f = fixture(original ? [original] : []);
    const result = await Promise.allSettled([
      f.persistence.save({ id: 'shared', goal: 'first failed write' }),
      f.persistence.save({ id: 'shared', goal: 'second failed write' }),
    ]);
    assert.deepEqual(result.map((item) => item.status), ['rejected', 'rejected']);
    assert.equal(f.saves(), 1, 'the batch still coalesces into one autosave');
    assert.deepEqual(f.project.findings.investigationSessions, original ? [original] : []);
    if (original) assert.strictEqual(f.project.findings.investigationSessions[0], original);
  }
});

await test('#4578 failed distinct-ID writes preserve unrelated sessions and successful retry coalescing', async () => {
  const untouched = { id: 'unrelated', goal: 'keep' };
  const f = fixture([untouched]);
  const store = new InvestigationSessionStore({ persistence: f.persistence });
  const result = await Promise.allSettled([store.create({ id: 'a' }), store.create({ id: 'b' })]);
  assert.deepEqual(result.map((item) => item.status), ['rejected', 'rejected']);
  assert.deepEqual(f.project.findings.investigationSessions, [untouched]);
  assert.equal(store.sessions.size, 0);
  f.recover();
  await Promise.all([store.create({ id: 'a' }), store.create({ id: 'b' })]);
  assert.equal(f.saves(), 2, 'independent IDs must still coalesce on retry');
  assert.deepEqual(f.project.findings.investigationSessions.map((item) => item.id), ['unrelated', 'a', 'b']);
});

await test('#4578 rollback leaves a concurrently replaced record intact', async () => {
  const f = fixture();
  const pending = f.persistence.save({ id: 'shared', goal: 'failed write' });
  const replacement = { id: 'shared', goal: 'new owner' };
  f.project.findings.investigationSessions[0] = replacement;
  await assert.rejects(pending, /autosave-failed/);
  assert.strictEqual(f.project.findings.investigationSessions[0], replacement);
});

await test('#4578 rollback preserves in-place edits, including a failed predecessor of a later write', async () => {
  const f = fixture();
  const first = f.persistence.save({ id: 'shared', messages: [{ content: 'original' }] });
  const edited = f.project.findings.investigationSessions[0];
  edited.messages[0].content = 'concurrent edit';
  const second = f.persistence.save({ id: 'shared', goal: 'later failed write' });
  const result = await Promise.allSettled([first, second]);
  assert.deepEqual(result.map((item) => item.status), ['rejected', 'rejected']);
  assert.strictEqual(f.project.findings.investigationSessions[0], edited);
  assert.equal(edited.messages[0].content, 'concurrent edit');
});

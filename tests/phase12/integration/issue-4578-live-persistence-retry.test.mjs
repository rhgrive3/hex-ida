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
  assert.strictEqual(await f.persistence.load('shared'), edited);
  assert.deepEqual(f.persistence.list(), [edited]);
  const store = new InvestigationSessionStore({ persistence: f.persistence });
  await assert.rejects(store.create({ id: 'shared', goal: 'must not overwrite the edit' }), /already exists/);
  assert.strictEqual(f.project.findings.investigationSessions[0], edited);
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
const outcome = (promise) => promise.then(
  (value) => ({ status: 'fulfilled', value }),
  (error) => ({ status: 'rejected', error }),
);
async function staged(project) {
  for (let tick = 0; tick < 30 && project.findings.investigationSessions.length === 0; tick++) await Promise.resolve();
  assert.equal(project.findings.investigationSessions.length, 1, 'reach the actual staging boundary');
}

for (const mode of ['same-store', 'shared-adapter-store', 'delayed-preexisting-load']) {
  await test(`#4578 ${mode} cannot hydrate a failed create into a ghost`, async () => {
    const f = fixture();
    const capture = deferred(), captured = deferred(), deliver = deferred();
    let firstLoad = true;
    const persistence = mode === 'delayed-preexisting-load' ? {
      ...f.persistence,
      async load(id) {
        if (!firstLoad) return f.persistence.load(id);
        firstLoad = false;
        await capture.promise;
        const snapshot = await f.persistence.load(id);
        captured.resolve();
        await deliver.promise;
        return snapshot;
      },
    } : f.persistence;
    const owner = new InvestigationSessionStore({ persistence });
    const reader = mode === 'shared-adapter-store' ? new InvestigationSessionStore({ persistence }) : owner;
    const before = mode === 'delayed-preexisting-load' ? reader.get('pending') : null;
    const create = outcome(owner.create({ id: 'pending', goal: 'not durable' }));
    await staged(f.project);
    let loaded;
    if (before) {
      capture.resolve();
      await captured.promise;
    } else loaded = await reader.get('pending');
    assert.equal((await create).status, 'rejected');
    if (before) { deliver.resolve(); loaded = await before; }
    assert.equal(loaded, null);
    assert.equal(f.project.findings.investigationSessions.length, 0);
    assert.equal(owner.sessions.size, 0);
    assert.equal(reader.sessions.size, 0);
    f.recover();
    assert.equal((await reader.create({ id: 'pending', goal: 'durable retry' })).goal, 'durable retry');
  });
}

await test('#4578 pending reads and duplicate probes wait for the original durable shared-store create', async () => {
  const f = fixture();
  f.recover();
  const owner = new InvestigationSessionStore({ persistence: f.persistence });
  const reader = new InvestigationSessionStore({ persistence: f.persistence });
  const duplicate = new InvestigationSessionStore({ persistence: f.persistence });
  const create = owner.create({ id: 'pending', goal: 'first' });
  await staged(f.project);
  assert.equal(await owner.get('pending'), null, 'the creating store cannot publish before durability');
  assert.deepEqual(f.persistence.list(), [], 'synchronous readers must not see a staged create');
  let readDone = false;
  const read = reader.get('pending').then((value) => { readDone = true; return value; });
  const collision = outcome(duplicate.create({ id: 'pending', goal: 'second' }));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(readDone, false);
  const created = await create;
  const loaded = await read;
  assert.equal(loaded.goal, 'first');
  assert.equal(Object.isFrozen(loaded), true);
  assert.strictEqual(await owner.get('pending'), created);
  assert.equal((await collision).status, 'rejected');
  assert.match((await collision).error.message, /already exists/);
  assert.equal(f.saves(), 1);
});

await test('#4578 unrelated committed IDs remain readable while another ID is staged', async () => {
  const original = { id: 'stable', goal: 'committed' };
  const f = fixture([original]);
  const owner = new InvestigationSessionStore({ persistence: f.persistence });
  const reader = new InvestigationSessionStore({ persistence: f.persistence });
  const create = outcome(owner.create({ id: 'pending' }));
  for (let tick = 0; tick < 30 && f.project.findings.investigationSessions.length < 2; tick++) await Promise.resolve();
  assert.equal(f.project.findings.investigationSessions.length, 2);
  assert.equal((await reader.get('stable')).goal, 'committed');
  assert.equal(f.saves(), 0, 'an unrelated read must not wait for the pending autosave');
  assert.deepEqual(f.persistence.list(), [original]);
  assert.equal((await create).status, 'rejected');
});

await test('#4578 a load started before create cannot replace its reserved or committed immutable record', async () => {
  for (const finishCreateFirst of [false, true]) {
    const releaseLoad = deferred(), releaseSave = deferred(), saving = deferred();
    let firstLoad = true;
    const store = new InvestigationSessionStore({ persistence: {
      async load() {
        if (!firstLoad) return null;
        firstLoad = false;
        await releaseLoad.promise;
        return { id: 'shared', goal: 'stale load' };
      },
      async save() { saving.resolve(); await releaseSave.promise; },
    } });
    const read = store.get('shared');
    const create = store.create({ id: 'shared', goal: 'committed' });
    await saving.promise;
    if (finishCreateFirst) { releaseSave.resolve(); await create; }
    releaseLoad.resolve();
    const loaded = await read;
    if (finishCreateFirst) assert.strictEqual(loaded, await create);
    else assert.equal(loaded, null);
    releaseSave.resolve();
    const created = await create;
    assert.strictEqual(await store.get('shared'), created);
    assert.equal(created.goal, 'committed');
  }
});

await test('#4578 a waiting live load stays bound to its original project', async () => {
  const original = { findings: { investigationSessions: [] } };
  const replacement = { findings: { investigationSessions: [{ id: 'shared', goal: 'other project' }] } };
  const app = { workspace: { project: original, autosave() { return true; } }, activeProject: original };
  const persistence = createLiveProjectSessionPersistence(app);
  const save = persistence.save({ id: 'shared', goal: 'original project' });
  const read = persistence.load('shared');
  app.workspace.project = replacement;
  app.activeProject = replacement;
  await save;
  assert.equal((await read).goal, 'original project');
  assert.equal((await persistence.load('shared')).goal, 'other project');
});

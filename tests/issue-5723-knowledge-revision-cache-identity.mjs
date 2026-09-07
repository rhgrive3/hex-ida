import assert from 'node:assert/strict';
import test from 'node:test';

import { ensureRecognitionState } from '../js/app.js';
import { KnowledgeDB } from '../js/knowledge/index.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function recognitionApp(knowledge) {
  const address = 0x1000n;
  return {
    backend: { gen: 3, contentHash: 'fixture-binary' },
    symbols: {
      gen: 7,
      functionCount: 1,
      funcs: [address],
      functionStartsComplete: true,
      nameAt: () => 'sub_1000',
      functionWindowBound: () => address + 4n,
    },
    fields: null,
    knowledge,
    recognition: null,
    recognitionBusy: null,
    recognitionBusyKnowledgeRev: null,
    recognitionKnowledgeRev: null,
    ensureSwift: async () => null,
  };
}

function controlledPropagation(knowledge) {
  const started = deferred();
  const release = deferred();
  let calls = 0;
  Object.defineProperty(knowledge, 'propagate', {
    configurable: true,
    value: async () => {
      calls++;
      const revision = knowledge.revision;
      if (calls === 1) {
        started.resolve();
        await release.promise;
      }
      return {
        propagated: true,
        candidate: { names: [`knowledge-r${revision}`] },
        confidence: 1,
        sourceId: `knowledge-r${revision}`,
      };
    },
  });
  return { started, release, calls: () => calls };
}

const recognitionOptions = { maxFunctions: 1_000, knowledgeLimit: 1 };

const mutations = [
  ['remember', (db) => db.remember({ fingerprint: { hash: 'h-race', schema: 'v1' }, sourceBinaryHash: 'fixture', names: ['KnownFunction'], userConfirmed: true })],
  ['reject', (db) => db.reject({ sourceBinaryHash: 'fixture', candidateName: 'nope' })],
  ['clear', (db) => db.clear()],
];

test('#5723 remember/reject/clear advance the knowledge revision; reads do not', async () => {
  const db = new KnowledgeDB({});
  const before = db.revision;
  await db.remember({ fingerprint: { hash: 'h-1', schema: 'v1' }, sourceBinaryHash: 'fixture', names: ['KnownFunction'], userConfirmed: true });
  const afterRemember = db.revision;
  assert.ok(afterRemember > before, 'remember must advance the revision');
  await db.reject({ sourceBinaryHash: 'fixture', candidateName: 'nope' });
  assert.ok(db.revision > afterRemember, 'reject must advance the revision');
  const beforeClear = db.revision;
  await db.clear();
  assert.ok(db.revision > beforeClear, 'clear must advance the revision');
});

test('#5723 unchanged knowledge keeps recognition single-flight', async () => {
  const db = new KnowledgeDB({});
  const app = recognitionApp(db);
  const control = controlledPropagation(db);

  const first = ensureRecognitionState(app, recognitionOptions);
  await control.started.promise;
  const second = ensureRecognitionState(app, recognitionOptions);
  control.release.resolve();

  const [firstState, secondState] = await Promise.all([first, second]);
  assert.equal(control.calls(), 1, 'same-revision callers must share one recognition build');
  assert.strictEqual(secondState, firstState, 'single-flight callers must observe the same state object');
  assert.strictEqual(app.recognition, firstState, 'the shared current state is published');
  assert.equal(firstState.records[0].name, 'knowledge-r0');
  assert.equal(app.recognitionKnowledgeRev, 0);
});

for (const [name, mutate] of mutations) {
  test(`#5723 ${name} during recognition cannot reuse or publish stale in-flight knowledge`, async () => {
    const db = new KnowledgeDB({});
    const app = recognitionApp(db);
    const control = controlledPropagation(db);

    const staleRequest = ensureRecognitionState(app, recognitionOptions);
    await control.started.promise;
    const before = db.revision;
    await mutate(db);
    assert.ok(db.revision > before, `${name} must advance the knowledge revision`);

    const freshRevision = db.revision;
    const freshRequest = ensureRecognitionState(app, recognitionOptions);
    control.release.resolve();
    const [staleState, freshState] = await Promise.all([staleRequest, freshRequest]);

    assert.equal(control.calls(), 2, 'a changed knowledge revision must start a fresh recognition build');
    assert.equal(staleState, null, 'the build bound to the old knowledge revision must fail closed');
    assert.ok(freshState, 'the post-mutation request must produce a fresh state');
    assert.equal(freshState.records[0].name, `knowledge-r${freshRevision}`,
      'the post-mutation state must reflect the new knowledge revision');
    assert.strictEqual(app.recognition, freshState, 'only the current-revision state may publish');
    assert.equal(app.recognitionKnowledgeRev, freshRevision,
      'published cache authority must match the current knowledge revision');
  });
}
